import childProcess from 'child_process'
import type { LookupAddress } from 'dns'
import dns from 'node:dns/promises'
import { NydusServer } from 'nydus'
import path from 'path'
import RallyPointCreator, { CreatedRoute } from 'rally-point-creator'
import { singleton } from 'tsyringe'
import createDeferred, { Deferred } from '../../../common/async/deferred'
import { RallyPointServer, ResolvedRallyPointServer } from '../../../common/rally-point'
import { SbUserId } from '../../../common/users/sb-user'
import isDev from '../env/is-dev'
import log from '../logging/logger'
import { ClientSocketsGroup, ClientSocketsManager } from '../websockets/socket-groups'
import { addRallyPointServer, retrieveRallyPointServers, updateRallyPointServer } from './models'

const SERVER_UPDATE_PATH = '/rallyPoint/serverList'

export interface RallyPointRouteInfo {
  /** The user ID of player 1. */
  p1: SbUserId
  /** The user ID of player 2. */
  p2: SbUserId
  /**
   * The rally-point route info, containing information players will need to provide to the server
   * to initialize the connection.
   */
  route: CreatedRoute
  /** Which rally-point server this route is for. */
  server: ResolvedRallyPointServer
  /** The estimated latency between players (this is one-way, from player A to the server to B). */
  estimatedLatency: number
}

@singleton()
export class RallyPointService {
  private readonly servers = new Map<number, ResolvedRallyPointServer>()
  private readonly clientPings = new Map<ClientSocketsGroup, Map<number, number>>()
  private readonly pingDeferreds = new Map<ClientSocketsGroup, Deferred<void>>()
  private routeCreator: RallyPointCreator | undefined

  constructor(private nydus: NydusServer, private clientSocketsManager: ClientSocketsManager) {
    this.clientSocketsManager.on('newClient', c => {
      if (c.clientType === 'electron') {
        c.subscribe(SERVER_UPDATE_PATH, () => {
          return {
            type: 'fullUpdate',
            servers: serializeServerMap(this.servers),
          }
        })

        c.on('close', () => {
          this.clientPings.delete(c)
          this.pingDeferreds.get(c)?.reject(new Error('client disconnected'))
          this.pingDeferreds.delete(c)
        })
      }
    })
  }

  /**
   * Initializes this service, causing it to bind a socket to create rally-point routes from and
   * read all the current rally-point servers from the database.
   *
   * @param creatorHost the hostname to bind the route-creator socket to
   * @param creatorPort the port to bind the route-creator socket to
   * @param secret the secret string used to verify this server's authenticity to any
   *   rally-point servers
   */
  async initialize(creatorHost: string, creatorPort: number, secret: string) {
    if (this.routeCreator) {
      throw new Error('initialized more than once')
    }

    this.routeCreator = new RallyPointCreator(creatorHost, creatorPort, secret)
    const bindPromise = this.routeCreator.bind()

    const servers = (await retrieveRallyPointServers()).filter(s => s.enabled)
    await bindPromise

    if (!servers.length) {
      if (isDev) {
        log.info('creating local rally-point process')
        const rallyPoint = childProcess.fork(path.join(__dirname, 'run-local-server.js'))
        rallyPoint
          .on('error', err => {
            log.error('rally-point process error: ' + err)
            process.exit(1)
          })
          .on('exit', (code, signal) => {
            log.error(
              'rally-point process exited unexpectedly with code: ' + code + ', signal: ' + signal,
            )
            process.exit(1)
          })

        this.servers.set(0, {
          id: 0,
          description: 'Local Server',
          enabled: true,
          hostname: 'localhost',
          port: Number(process.env.SB_RALLY_POINT_LOCAL_PORT ?? 14098),
          address6: '::1',
          address4: '::ffff:127.0.0.1',
        })

        this.nydus.publish(SERVER_UPDATE_PATH, {
          type: 'fullUpdate',
          servers: serializeServerMap(this.servers),
        })
      } else {
        log.warn('no enabled rally-point servers, multiplayer games will not work')
      }

      return
    }

    const resolvedServers = (await Promise.all(servers.map(s => lookupHostOrDisable(s)))).filter(
      s => isResolved(s),
    ) as ResolvedRallyPointServer[]

    this.servers.clear()
    for (const resolvedServer of resolvedServers) {
      log.info(`registering rally-point server: ${resolvedServer.hostname}:${resolvedServer.port}`)
      this.servers.set(resolvedServer.id, resolvedServer)
    }

    this.nydus.publish(SERVER_UPDATE_PATH, {
      type: 'fullUpdate',
      servers: serializeServerMap(this.servers),
    })
  }

  /**
   * Adds a new server with the specified parameters to the DB, and notifies all clients to
   * update their local lists.
   */
  async addServer(serverData: Omit<RallyPointServer, 'id'>): Promise<RallyPointServer> {
    const server = await addRallyPointServer(serverData)
    if (!server.enabled) {
      return server
    }

    const resolvedServer = await lookupHostOrDisable(server)
    if (!isResolved(resolvedServer)) {
      return resolvedServer!
    }

    this.servers.set(resolvedServer.id, resolvedServer)
    this.nydus.publish(SERVER_UPDATE_PATH, {
      type: 'upsert',
      server: resolvedServer,
    })

    return server
  }

  /**
   * Updates an already existing server, storing the modified data in the DB and notifying all
   * clients to update their local lists.
   *
   * @returns a Promise with either the updated server, or undefined if the server doesn't exist
   *   in the DB
   */
  async updateServer(serverData: RallyPointServer): Promise<RallyPointServer | undefined> {
    const server = await updateRallyPointServer(serverData)
    if (!server) {
      return undefined
    }

    const oldServer = this.servers.get(server.id)
    if (!oldServer?.enabled && !server.enabled) {
      return server
    } else if (oldServer?.enabled && !server.enabled) {
      this.servers.delete(server.id)

      for (const pingMap of this.clientPings.values()) {
        pingMap.delete(server.id)
      }

      this.nydus.publish(SERVER_UPDATE_PATH, {
        type: 'delete',
        id: server.id,
      })
      return server
    } else {
      const resolvedServerPromise = lookupHostOrDisable(server)
      for (const pingMap of this.clientPings.values()) {
        pingMap.delete(server.id)
      }

      const resolvedServer = await resolvedServerPromise
      if (!isResolved(resolvedServer)) {
        this.nydus.publish(SERVER_UPDATE_PATH, {
          type: 'delete',
          id: server.id,
        })
        return resolvedServer
      }

      this.servers.set(resolvedServer.id, resolvedServer)
      this.nydus.publish(SERVER_UPDATE_PATH, {
        type: 'upsert',
        server: resolvedServer,
      })

      return server
    }
  }

  /**
   * Creates the best available route between two players.
   *
   * The best available route is calculated by finding the available server with the lowest
   * cumulative latency for both players (that is, it minimizes `p1Latency + p2Latency`).
   */
  async createBestRoute(
    player1: ClientSocketsGroup,
    player2: ClientSocketsGroup,
  ): Promise<RallyPointRouteInfo> {
    if (!this.routeCreator) {
      throw new Error('RallyPointService is not initialized')
    }

    const pings1 = this.clientPings.get(player1) ?? new Map()
    const pings2 = this.clientPings.get(player2) ?? new Map()
    const totalPings = Array.from(this.servers.keys(), serverId => {
      // NOTE(tec27): We operate from the server keys so that we're not including servers that have
      // recently been removed from the list but these clients had pings for
      const totalPing =
        (pings1.get(serverId) ?? Number.MAX_VALUE) + (pings2.get(serverId) ?? Number.MAX_VALUE)
      return [serverId, totalPing]
    })

    let minPing = Number.MAX_VALUE
    let minServer = -1
    for (const [serverId, totalPing] of totalPings) {
      if (totalPing < minPing) {
        minPing = totalPing
        minServer = serverId
      }
    }

    if (minServer === -1) {
      throw new Error(`could not find a route between ${player1.name} and ${player2.name}`)
    }

    const server = this.servers.get(minServer)!
    const route = await this.routeCreator.createRoute(
      server.address4 ?? server.address6!,
      server.port,
    )
    return {
      p1: player1.userId,
      p2: player2.userId,
      route,
      server,
      // minPing is the round trip time from both players, summed, we divide by 2 to get the
      // 1-way latency
      estimatedLatency: minPing / 2,
    }
  }

  /**
   * Returns a promise that resolves when the specified client has at least one reported ping result
   * for a rally-point server.
   */
  async waitForPingResult(client: ClientSocketsGroup): Promise<void> {
    if (!this.pingDeferreds.has(client)) {
      const deferred = createDeferred<void>()
      if (this.clientPings.get(client)?.size) {
        deferred.resolve()
      }

      this.pingDeferreds.set(client, deferred)
    }

    await this.pingDeferreds.get(client)
  }

  /**
   * Updates the stored ping for a particular client against one of the rally-point servers. These
   * values get used to pick the best routes between different users' clients.
   */
  updatePing(client: ClientSocketsGroup, serverId: number, ping: number) {
    if (!this.servers.has(serverId)) {
      return
    }

    const pingMap = this.clientPings.get(client) ?? new Map()
    pingMap.set(serverId, ping)
    this.clientPings.set(client, pingMap)

    this.pingDeferreds.get(client)?.resolve()
  }
}

function serializeServerMap(serverMap: Map<number, ResolvedRallyPointServer>) {
  return Array.from(serverMap.entries())
}

async function lookupHost(host: string): Promise<{ address4?: string; address6?: string }> {
  let v6: LookupAddress | undefined
  try {
    v6 = await dns.lookup(host, { family: 6 })
  } catch (err) {
    log.warn({ err }, `couldn't look up IPv6 address of ${host}`)
  }

  let v4: LookupAddress | undefined
  try {
    v4 = await dns.lookup(host, { family: 4 })
  } catch (err) {
    log.warn({ err }, `couldn't look up IPv4 address of ${host}`)
  }
  if (v4 && v4?.family === 6 && v6 && v6.address.startsWith('::ffff:')) {
    // v6 is an ipv6-mapped ipv4 address, so swap things around
    v4.address = v6.address.slice('::ffff:'.length)
    v4.family = 4
    v6 = undefined
  }

  if (!v4 && !v6) {
    throw new Error(`could not resolve ${host}`)
  }

  return {
    address4: v4 && v4.family === 4 ? `::ffff:${v4.address}` : undefined,
    address6: v6 && v6.family === 6 ? v6.address : undefined,
  }
}

async function lookupHostOrDisable(
  server: Readonly<RallyPointServer>,
): Promise<ResolvedRallyPointServer | RallyPointServer | undefined> {
  try {
    const resolved = await lookupHost(server.hostname)
    const resolvedServer: ResolvedRallyPointServer = { ...server, ...resolved }
    return resolvedServer
  } catch (err) {
    log.error({ err }, `failed to resolve ${server.hostname}, disabling`)
    return await updateRallyPointServer({ ...server, enabled: false })
  }
}

function isResolved(
  possiblyResolved: ResolvedRallyPointServer | RallyPointServer | undefined,
): possiblyResolved is ResolvedRallyPointServer {
  if (possiblyResolved === undefined) {
    return false
  } else {
    return !!(
      (possiblyResolved as ResolvedRallyPointServer).address4 ||
      (possiblyResolved as ResolvedRallyPointServer).address6
    )
  }
}
