import { Counter, Histogram, linearBuckets } from 'prom-client'
import { singleton } from 'tsyringe'
import { isAbortError, raceAbort } from '../../../common/async/abort-signals'
import createDeferred, { Deferred } from '../../../common/async/deferred'
import { timeoutPromise } from '../../../common/async/timeout-promise'
import { appendToMultimap } from '../../../common/data-structures/maps'
import { GameConfig } from '../../../common/games/configuration'
import { GameLoadBeginEvent, GameLoadEvent, GameRoute } from '../../../common/games/games'
import { SbUserId } from '../../../common/users/sb-user'
import { CodedError } from '../errors/coded-error'
import log from '../logging/logger'
import { deleteUserRecordsForGame } from '../models/games-users'
import { RallyPointRouteInfo, RallyPointService } from '../rally-point/rally-point-service'
import { findUsersById } from '../users/user-model'
import { TypedPublisher } from '../websockets/typed-publisher'
import { deleteRecordForGame } from './game-models'
import { GameplayActivityRegistry } from './gameplay-activity-registry'
import { registerGame } from './registration'

/** How long to wait for clients to report a ping to rally-point. */
const PING_REPORT_TIMEOUT = 10000

export enum GameLoadErrorType {
  GameNotFound = 'gameNotFound',
  PlayerFailed = 'playerFailed',
}

interface GameLoadErrorTypeToData {
  [GameLoadErrorType.GameNotFound]: undefined
  [GameLoadErrorType.PlayerFailed]: {
    userId: SbUserId
  }
}

// NOTE(tec27): This is necessary to make the third (options) parameter optional in the case that
// we have no associated data for the error, but required otherwise. Unfortunately verbose :(
type GameLoadErrorParams<T extends GameLoadErrorType> = GameLoadErrorTypeToData[T] extends undefined
  ? [code: T, message: string, options?: { cause?: unknown }]
  : [code: T, message: string, options: { data: GameLoadErrorTypeToData[T]; cause?: unknown }]

export class GameLoaderError<T extends GameLoadErrorType> extends CodedError<
  T,
  GameLoadErrorTypeToData[T]
> {
  constructor(...params: GameLoadErrorParams<T>) {
    super(params[0], params[1], params[2])
  }
}

class LoadInProgress {
  readonly playerIds: ReadonlySet<SbUserId>
  private abortController = new AbortController()
  private loadingPromises = new Map<SbUserId, Deferred<void>>()
  // FIXME: State should maybe be more granular?
  private loadingState = new Map<SbUserId, boolean>()

  constructor(readonly gameId: string, readonly playerIdArray: ReadonlyArray<SbUserId>) {
    this.playerIds = new Set(playerIdArray)
    for (const playerId of playerIdArray) {
      this.loadingPromises.set(playerId, createDeferred())
      this.loadingState.set(playerId, false)
    }
  }

  untilLoadedStateChanged(): Promise<void> {
    return raceAbort(
      this.abortController.signal,
      Promise.race(Array.from(this.loadingPromises.values())),
    )
  }

  abort<T extends GameLoadErrorType>(reason: GameLoaderError<T>) {
    this.abortController.abort(reason)
  }

  throwIfAborted() {
    this.abortController.signal.throwIfAborted()
  }

  getLoadingState(): ReadonlyMap<SbUserId, boolean> {
    return this.loadingState
  }

  registerPlayerLoaded(userId: SbUserId) {
    this.loadingState.set(userId, true)
    this.loadingPromises.get(userId)!.resolve()
  }
}

@singleton()
export class GameLoaderService {
  private gameLoadRequestsTotalMetric = new Counter({
    name: 'shieldbattery_game_loader_requests_total',
    labelNames: ['game_source'],
    help: 'Total number of game load requests',
  })
  private gameLoadFailuresTotalMetric = new Counter({
    name: 'shieldbattery_game_loader_failures_total',
    // TODO(tec27): Add failure types?
    labelNames: ['game_source'],
    help: 'Total number of game load requests that failed',
  })
  private gameLoadSuccessesTotalMetric = new Counter({
    name: 'shieldbattery_game_loader_successes_total',
    labelNames: ['game_source'],
    help: 'Total number of game load requests that succeeded',
  })
  private maxEstimatedLatencyMetric = new Histogram({
    name: 'shieldbattery_game_loader_max_estimated_latency_seconds',
    labelNames: ['game_source'],
    help: 'Maximum latency between a pair of peers in a game in seconds',
    buckets: linearBuckets(0.01, 0.03, 12),
  })

  private loadsInProgress = new Map<string, LoadInProgress>()

  constructor(
    private gameplayActivityRegistry: GameplayActivityRegistry,
    private typedPublisher: TypedPublisher<GameLoadEvent>,
    private rallyPointService: RallyPointService,
  ) {}

  async loadGame({ mapId, gameConfig }: { mapId: string; gameConfig: GameConfig }): Promise<void> {
    this.gameLoadRequestsTotalMetric.labels(gameConfig.gameSource).inc()
    const playerIds = gameConfig.teams.flatMap(t => t.filter(p => !p.isComputer).map(p => p.id))
    if (!playerIds.length) {
      throw new Error('no humans found in game configuration')
    }
    const userInfos = await findUsersById(playerIds)
    if (userInfos.length !== playerIds.length) {
      throw new Error('could not find all users in game')
    }

    if (!playerIds.every(id => Boolean(this.gameplayActivityRegistry.getClientForUser(id)))) {
      // TODO(tec27): Should we treat this as a "normal" error and pass back the non-connected
      // clients? Seems more like a programming error to me if it happens at this point but not
      // 100% sure right now
      throw new Error('not all players have an active client')
    }

    const { gameId, resultCodes } = await registerGame(mapId, gameConfig)
    const gamePath = GameLoaderService.getLoaderPath(gameId)

    const loadInProgress = new LoadInProgress(gameId, playerIds)
    this.loadsInProgress.set(gameId, loadInProgress)
    const routesByPlayer = new Map<SbUserId, GameRoute[]>()
    const subscriptionCleanupFuncs: Array<() => void> = []

    try {
      // Subscribe all the players to the relevant websocket routes on their active client
      for (const playerId of playerIds) {
        const resultCode = resultCodes.get(playerId)
        if (!resultCode) {
          throw new Error('could not find result code for player')
        }

        const client = this.gameplayActivityRegistry.getClientForUser(playerId)
        if (!client) {
          loadInProgress.abort(
            new GameLoaderError(GameLoadErrorType.PlayerFailed, 'player failed to load', {
              data: { userId: playerId },
            }),
          )
        } else {
          client.subscribe(gamePath)
          client.subscribe<GameLoadBeginEvent>(
            GameLoaderService.getLoaderPlayerPath(gameId, playerId),
            () => ({
              type: 'begin',
              id: gameId,
              gameConfig,
              userInfos,
              resultCode,
              routes: routesByPlayer.get(playerId),
            }),
          )

          subscriptionCleanupFuncs.push(() => {
            client.unsubscribe(gamePath)
            client.unsubscribe(GameLoaderService.getLoaderPlayerPath(gameId, playerId))
          })
        }
      }

      const hasMultipleHumans = playerIds.length > 1
      // Wait for players to report pings to rally-point
      const pingPromise = hasMultipleHumans
        ? Promise.all(
            playerIds.map(p =>
              Promise.race([
                this.rallyPointService.waitForPingResult(
                  this.gameplayActivityRegistry.getClientForUser(p)!,
                ),
                timeoutPromise(PING_REPORT_TIMEOUT)[0].then(() =>
                  loadInProgress.abort(
                    new GameLoaderError(
                      GameLoadErrorType.PlayerFailed,
                      'player did not report pings',
                      {
                        data: { userId: p },
                      },
                    ),
                  ),
                ),
              ]),
            ),
          )
        : Promise.resolve()

      await pingPromise
      loadInProgress.throwIfAborted()

      // Create the rally-point routes for each player pair in the game
      const routes = hasMultipleHumans ? await this.createRoutes(playerIds) : []
      loadInProgress.throwIfAborted()

      // Let each player know what their routes are
      for (const {
        p1,
        p2,
        server,
        route: { p1Id, p2Id, routeId },
      } of routes) {
        appendToMultimap(routesByPlayer, p1, { for: p2, server, routeId, playerId: p1Id })
        appendToMultimap(routesByPlayer, p2, { for: p1, server, routeId, playerId: p2Id })
      }
      for (const [playerId, routes] of routesByPlayer) {
        this.typedPublisher.publish(GameLoaderService.getLoaderPlayerPath(gameId, playerId), {
          type: 'routes',
          id: gameId,
          routes,
        })
      }

      let allPlayersLoaded = false
      do {
        await loadInProgress.untilLoadedStateChanged()
        const loadedPlayers = Array.from(loadInProgress.getLoadingState().entries())
          .filter(([_, isLoaded]) => isLoaded)
          .map(([id, _]) => id)

        // FIXME: broadcast update

        allPlayersLoaded = loadedPlayers.length === playerIds.length
      } while (!allPlayersLoaded)

      // FIXME: broadcast countdown
      // FIXME: start game
      // FIXME: increment success metric
    } catch (err: unknown) {
      this.gameLoadFailuresTotalMetric.labels(gameConfig.gameSource).inc()
      this.loadsInProgress.delete(gameId)

      Promise.all([deleteRecordForGame(gameId), deleteUserRecordsForGame(gameId)]).catch(err => {
        log.error({ err }, 'error removing game records for canceled game')
      })

      if (isAbortError(err)) {
        if (err.cause && err.cause instanceof GameLoaderError) {
          throw err.cause
        } else {
          // This should never happen, as we should only be aborting with our error type
          throw new Error('game load aborted with unknown error', { cause: err.cause })
        }
      }

      throw err
    } finally {
      for (const fn of subscriptionCleanupFuncs) {
        fn()
      }
    }
  }

  registerPlayerLoaded(gameId: string, userId: SbUserId) {
    const loadInProgress = this.loadsInProgress.get(gameId)
    if (!loadInProgress || !loadInProgress.playerIds.has(userId)) {
      throw new GameLoaderError(GameLoadErrorType.GameNotFound, 'game not found')
    }

    loadInProgress.registerPlayerLoaded(userId)
  }

  private async createRoutes(players: ReadonlyArray<SbUserId>): Promise<RallyPointRouteInfo[]> {
    // Generate all the pairings of players to figure out the routes we need
    const matchGen: Array<[userId: SbUserId, targets: Array<SbUserId>]> = []
    const rest = players.slice()
    while (rest.length > 1) {
      const first = rest.shift()!
      matchGen.push([first, rest.slice()])
    }
    const needRoutes = matchGen.reduce((result, [p1, players]) => {
      players.forEach(p2 => result.push([p1, p2]))
      return result
    }, [] as Array<[p1: SbUserId, p2: SbUserId]>)

    return Promise.all(
      needRoutes.map(([p1, p2]) =>
        this.rallyPointService.createBestRoute(
          this.gameplayActivityRegistry.getClientForUser(p1)!,
          this.gameplayActivityRegistry.getClientForUser(p2)!,
        ),
      ),
    )
  }

  /** Returns the websocket path used to broadcast game loading updates by this service. */
  static getLoaderPath(gameId: string) {
    return `/game-loader/${gameId}`
  }

  /**
   * Returns the websocket path used to broadcast game loading updates that are private to a single
   * player.
   */
  static getLoaderPlayerPath(gameId: string, userId: SbUserId) {
    return `${GameLoaderService.getLoaderPath(gameId)}/${userId}`
  }
}
