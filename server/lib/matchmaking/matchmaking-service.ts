import cuid from 'cuid'
import { Immutable } from 'immer'
import { Counter, exponentialBuckets, Histogram } from 'prom-client'
import { container, inject, singleton } from 'tsyringe'
import { ReadonlyDeep } from 'type-fest'
import { assertUnreachable } from '../../../common/assert-unreachable'
import { isAbortError, raceAbort } from '../../../common/async/abort-signals'
import CancelToken from '../../../common/async/cancel-token'
import createDeferred, { Deferred } from '../../../common/async/deferred'
import swallowNonBuiltins from '../../../common/async/swallow-non-builtins'
import { timeoutPromise } from '../../../common/async/timeout-promise'
import { subtract } from '../../../common/data-structures/sets'
import { GameRoute } from '../../../common/game-launch-config'
import {
  GameConfig,
  GameConfigPlayer,
  GameSource,
  GameType,
  MatchmakingExtra,
} from '../../../common/games/configuration'
import { createHuman, Slot } from '../../../common/lobbies/slot'
import { MapInfo, MapInfoJson, toMapInfoJson } from '../../../common/maps'
import {
  ALL_MATCHMAKING_TYPES,
  MatchmakingCompletionType,
  MatchmakingEvent,
  MatchmakingPreferences,
  MatchmakingSeason,
  MatchmakingServiceErrorCode,
  MatchmakingType,
  MATCHMAKING_ACCEPT_MATCH_TIME_MS,
  PreferenceData,
  TEAM_SIZES,
} from '../../../common/matchmaking'
import { BwTurnRate, BwUserLatency } from '../../../common/network'
import { RaceChar } from '../../../common/races'
import { randomInt, randomItem } from '../../../common/random'
import { urlPath } from '../../../common/urls'
import { SbUserId } from '../../../common/users/sb-user'
import { GameplayActivityRegistry } from '../games/gameplay-activity-registry'
import { GameLoaderError, LegacyGameLoader } from '../games/legacy-game-loader'
import logger from '../logging/logger'
import { getMapInfo } from '../maps/map-models'
import {
  calcEffectiveRating,
  Matchmaker,
  MATCHMAKING_INTERVAL_MS,
  OnMatchFoundFunc,
} from '../matchmaking/matchmaker'
import {
  getMatchmakingEntityId,
  getNumPlayersInEntity,
  getPlayersFromEntity,
  MatchmakingEntity,
  MatchmakingParty,
  MatchmakingPlayer,
  MatchmakingPlayerData,
  matchmakingRatingToPlayerData,
} from '../matchmaking/matchmaking-entity'
import MatchmakingStatusService from '../matchmaking/matchmaking-status'
import {
  createInitialMatchmakingRating,
  getMatchmakingRating,
  insertMatchmakingCompletion,
  MatchmakingRating,
} from '../matchmaking/models'
import { getCurrentMapPool } from '../models/matchmaking-map-pools'
import { InPartyChecker, IN_PARTY_CHECKER } from '../parties/in-party-checker'
import { Clock } from '../time/clock'
import { ClientIdentifierString } from '../users/client-ids'
import { UserIdentifierManager } from '../users/user-identifier-manager'
import { findUsersByIdAsMap } from '../users/user-model'
import {
  ClientSocketsGroup,
  ClientSocketsManager,
  UserSocketsGroup,
  UserSocketsManager,
} from '../websockets/socket-groups'
import { TypedPublisher } from '../websockets/typed-publisher'
import { MatchmakingSeasonsService } from './matchmaking-seasons'
import { MatchmakingServiceError } from './matchmaking-service-error'
import { adjustMatchmakingRatingForInactivity } from './rating'

interface MatchmakerCallbacks {
  onMatchFound: OnMatchFoundFunc
}

interface GameLoaderCallbacks {
  onGameSetup: (props: {
    matchInfo: Readonly<Match>
    clients: ReadonlyArray<ClientSocketsGroup>
    slots: ReadonlyArray<Slot>
    setup: {
      gameId: string
      seed: number
      turnRate?: BwTurnRate
      userLatency?: BwUserLatency
    }
    resultCodes: ReadonlyMap<SbUserId, string>
    chosenMap: MapInfoJson
    cancelToken: CancelToken
  }) => void
  onRoutesSet: (
    clients: ReadonlyArray<ClientSocketsGroup>,
    playerName: string,
    routes: ReadonlyArray<GameRoute>,
    gameId: string,
  ) => void
  onGameLoaded: (clients: ReadonlyArray<ClientSocketsGroup>) => void
}

class Match {
  private acceptPromises = new Map<SbUserId, Deferred<void>>()
  private acceptTimeout: Promise<void>
  private clearAcceptTimeout: (reason?: any) => void
  private userIdToRegisteredId = new Map<SbUserId, SbUserId>()

  private toKick = new Set<SbUserId>()
  private abortController = new AbortController()

  constructor(
    readonly id: string,
    readonly type: MatchmakingType,
    readonly teams: Immutable<MatchmakingEntity[][]>,
  ) {
    for (const entities of teams) {
      for (const entity of entities) {
        const registeredId = getMatchmakingEntityId(entity)
        for (const p of getPlayersFromEntity(entity)) {
          this.acceptPromises.set(p.id, createDeferred())
          this.userIdToRegisteredId.set(p.id, registeredId)
        }
      }
    }

    ;[this.acceptTimeout, this.clearAcceptTimeout] = timeoutPromise(
      MATCHMAKING_ACCEPT_MATCH_TIME_MS + ACCEPT_MATCH_LATENCY,
    )

    this.acceptTimeout
      .then(() => {
        if (this.acceptPromises.size) {
          for (const id of this.acceptPromises.keys()) {
            this.toKick.add(this.userIdToRegisteredId.get(id)!)
          }
          this.abortController.abort()
        }
      })
      .catch(swallowNonBuiltins)
  }

  get acceptStateChanged(): Promise<void> {
    return raceAbort(
      this.abortController.signal,
      Promise.race(Array.from(this.acceptPromises.values())),
    )
  }

  *players(): Generator<Immutable<MatchmakingPlayerData>> {
    for (const entities of this.teams) {
      for (const entity of entities) {
        for (const p of getPlayersFromEntity(entity)) {
          yield p
        }
      }
    }
  }

  get totalPlayers(): number {
    return TEAM_SIZES[this.type] * this.teams.length
  }

  get numAccepted(): number {
    return this.totalPlayers - this.acceptPromises.size
  }

  registerAccept(userId: SbUserId) {
    this.acceptPromises.get(userId)?.resolve()
    this.acceptPromises.delete(userId)

    if (this.numAccepted === this.totalPlayers) {
      this.clearAcceptTimeout()
    }
  }

  registerDecline(userId: SbUserId) {
    this.toKick.add(this.userIdToRegisteredId.get(userId)!)
    this.abortController.abort()
    this.clearAcceptTimeout()
  }

  getKicksAndRequeues(): [toKick: Set<SbUserId>, toRequeue: Set<SbUserId>] {
    // Requeue any party leaders and solo players that don't appear in toKick
    const toRequeue = subtract(
      new Set(this.teams.flatMap(team => team.map(entity => getMatchmakingEntityId(entity)))),
      this.toKick,
    )
    return [new Set(this.toKick), toRequeue]
  }
}

interface QueueEntry {
  userId: SbUserId
  /** The user ID that the matchmaking queue is registered under. (e.g. the party leader's ID) */
  registeredId: SbUserId
  type: MatchmakingType
  partyId?: string
  matchId?: string
}

interface Timers {
  mapSelectionTimer?: Deferred<void>
  countdownTimer?: Deferred<void>
  cancelToken: CancelToken
}

// Extra time that is added to the matchmaking accept time to account for latency in getting
// messages back and forth from clients
const ACCEPT_MATCH_LATENCY = 2000

/**
 * Selects a map for the given players and matchmaking type, based on the players' stored
 * matchmaking preferences and the current map pool.
 */
async function pickMap(
  matchmakingType: MatchmakingType,
  entities: Immutable<MatchmakingEntity[]>,
): Promise<MapInfo> {
  const currentMapPool = await getCurrentMapPool(matchmakingType)
  if (!currentMapPool) {
    throw new MatchmakingServiceError(
      MatchmakingServiceErrorCode.InvalidMapPool,
      "Map pool doesn't exist",
    )
  }

  // TODO(tec27): Handle parties in 2v2: only the leader's selections should be used

  // The algorithm for selecting maps is:
  // 1) All players' map selections are treated as vetoes, and removed from the available map pool.
  //    We also track how many times each map was vetoed.
  // 2a) If any maps are remaining, select a random map from the remaining ones
  // 2b) If no maps are remaining, select a random map from the least vetoed maps

  const fullMapPool = new Set(currentMapPool.maps)
  const vetoCount = new Map<string, number>()
  let mapPool = fullMapPool
  for (const e of entities) {
    let mapSelections: ReadonlyArray<string>
    if ('players' in e) {
      mapSelections = e.players.find(p => p.id === e.leaderId)!.mapSelections
    } else {
      mapSelections = e.mapSelections
    }
    mapPool = subtract(mapPool, mapSelections)
    for (const map of mapSelections) {
      vetoCount.set(map, (vetoCount.get(map) ?? 0) + 1)
    }
  }

  if (!mapPool.size) {
    // All available maps were vetoed, create a final pool from the least vetoed maps
    // NOTE(tec27): We know since the whole pool was vetoed, each map in the pool will have an entry
    // here, even though we didn't initialize the Map directly
    const sortedByVetoCount = Array.from(vetoCount.entries()).sort((a, b) => a[1] - b[1])
    const leastVetoCount = sortedByVetoCount[0][1]
    let lastElem = 1
    while (
      lastElem < sortedByVetoCount.length &&
      sortedByVetoCount[lastElem][1] <= leastVetoCount
    ) {
      lastElem += 1
    }

    mapPool = new Set(sortedByVetoCount.slice(0, lastElem).map(e => e[0]))
  }

  const chosenMapId = randomItem(Array.from(mapPool))
  const mapInfo = await getMapInfo([chosenMapId])

  if (!mapInfo.length) {
    throw new MatchmakingServiceError(
      MatchmakingServiceErrorCode.InvalidMaps,
      'Some (or all) of the maps not found',
    )
  }

  const chosenMap = mapInfo[0]

  return chosenMap
}

@singleton()
export class MatchmakingService {
  private matchmakerDelegate: MatchmakerCallbacks = {
    onMatchFound: (teamA, teamB) => {
      const playerEntry = this.queueEntries.get(getMatchmakingEntityId(teamA[0]))!

      const matchInfo = new Match(cuid(), playerEntry.type, [teamA, teamB])
      this.matches.set(matchInfo.id, matchInfo)

      for (const entities of [teamA, teamB]) {
        for (const entity of entities) {
          for (const p of getPlayersFromEntity(entity)) {
            const queueEntry = this.queueEntries.get(p.id)!
            queueEntry.matchId = matchInfo.id
            this.publishToActiveClient(p.id, {
              type: 'matchFound',
              matchmakingType: matchInfo.type,
              numPlayers: matchInfo.totalPlayers,
            })
          }
        }
      }

      const completionTime = new Date(this.clock.now())
      for (const entities of [teamA, teamB]) {
        for (const entity of entities) {
          for (const p of getPlayersFromEntity(entity)) {
            insertMatchmakingCompletion({
              userId: p.id,
              matchmakingType: matchInfo.type,
              completionType: MatchmakingCompletionType.Found,
              searchTimeMillis: entity.searchIterations * MATCHMAKING_INTERVAL_MS,
              completionTime,
            }).catch(err => logger.error({ err }, 'error while logging matchmaking completion'))
          }
          this.matchSearchTimeMetric
            .labels(
              matchInfo.type,
              String(getNumPlayersInEntity(entity)),
              MatchmakingCompletionType.Found,
            )
            .observe((entity.searchIterations * MATCHMAKING_INTERVAL_MS) / 1000)
        }
      }

      this.matchesFoundMetric.labels(matchInfo.type).inc()

      this.runMatch(matchInfo.id).catch(swallowNonBuiltins)
    },
  }

  private gameLoaderDelegate: GameLoaderCallbacks = {
    onGameSetup: async ({
      matchInfo,
      clients,
      slots,
      setup,
      resultCodes,
      chosenMap,
      cancelToken,
    }) => {
      cancelToken.throwIfCancelling()

      const playersJson = matchInfo.teams.flatMap(team =>
        team.flatMap(entities =>
          Array.from(getPlayersFromEntity(entities), p => {
            const slot = slots.find(s => s.name === p.name)!

            return {
              id: p.id,
              name: p.name,
              race: slot.race,
              rating: p.rating,
            }
          }),
        ),
      )

      // Using `map` with `Promise.all` here instead of `forEach`, so our general error handler
      // catches any of the errors inside.
      await Promise.all(
        clients.map(async client => {
          let published = this.publishToActiveClient(client.userId, {
            type: 'matchReady',
            matchmakingType: matchInfo.type,
            setup,
            resultCode: resultCodes.get(client.userId),
            slots,
            players: playersJson,
            chosenMap,
          })

          if (!published) {
            throw new MatchmakingServiceError(
              MatchmakingServiceErrorCode.ClientDisconnected,
              `Match cancelled, ${client.name} disconnected`,
            )
          }

          let mapSelectionTimerId
          let countdownTimerId
          try {
            const mapSelectionTimer = createDeferred<void>()
            mapSelectionTimer.catch(swallowNonBuiltins)
            let timers = this.clientTimers.get(client.userId) ?? { cancelToken }
            timers.mapSelectionTimer = mapSelectionTimer
            this.clientTimers.set(client.userId, timers)
            mapSelectionTimerId = setTimeout(() => mapSelectionTimer.resolve(), 5000)
            await mapSelectionTimer
            cancelToken.throwIfCancelling()

            published = this.publishToActiveClient(client.userId, { type: 'startCountdown' })
            if (!published) {
              throw new MatchmakingServiceError(
                MatchmakingServiceErrorCode.ClientDisconnected,
                `Match cancelled, ${client.name} disconnected`,
              )
            }

            const countdownTimer = createDeferred<void>()
            countdownTimer.catch(swallowNonBuiltins)
            timers = this.clientTimers.get(client.userId) ?? { cancelToken }
            timers.countdownTimer = countdownTimer
            this.clientTimers.set(client.userId, timers)
            countdownTimerId = setTimeout(() => countdownTimer.resolve(), 5000)

            await countdownTimer
            cancelToken.throwIfCancelling()

            published = this.publishToActiveClient(client.userId, {
              type: 'startWhenReady',
              gameId: setup.gameId!,
            })
            if (!published) {
              throw new MatchmakingServiceError(
                MatchmakingServiceErrorCode.ClientDisconnected,
                `Match cancelled, ${client.name} disconnected`,
              )
            }
          } finally {
            if (mapSelectionTimerId) {
              clearTimeout(mapSelectionTimerId)
              mapSelectionTimerId = null
            }
            if (countdownTimerId) {
              clearTimeout(countdownTimerId)
              countdownTimerId = null
            }
          }
        }),
      )
    },

    onRoutesSet: (clients, playerName, routes, gameId) => {
      for (const c of clients) {
        // TODO(tec27): It'd be a lot nicer if this just delivered us the user ID of this player
        // instead of their name (or gave both).
        if (c.name === playerName) {
          this.publishToActiveClient(c.userId, {
            type: 'setRoutes',
            routes,
            gameId,
          })
          break
        }
      }
    },

    onGameLoaded: clients => {
      for (const client of clients) {
        this.publishToActiveClient(client.userId, { type: 'gameStarted' })
        // TODO(tec27): Should this be maintained until the client reports game exit instead?
        this.unregisterActivity(client.userId)
      }
    },
  }

  private matchmakers: Map<MatchmakingType, Matchmaker>
  // Maps user ID -> QueueEntry
  private queueEntries = new Map<SbUserId, QueueEntry>()
  // Maps match ID -> Match
  private matches = new Map<string, Match>()
  // Maps user ID -> Timers
  private clientTimers = new Map<SbUserId, Timers>()

  private matchesRequestedMetric = new Counter({
    name: 'shieldbattery_matchmaker_matches_requested_total',
    labelNames: ['matchmaking_type', 'party_size'],
    help: 'Total number of matches requested',
  })
  private matchesFoundMetric = new Counter({
    name: 'shieldbattery_matchmaker_matches_found_total',
    labelNames: ['matchmaking_type'],
    help: 'Total number of matches found',
  })
  private matchRequestsCanceledMetric = new Counter({
    name: 'shieldbattery_matchmaker_match_requests_canceled_total',
    labelNames: ['matchmaking_type', 'party_size'],
    help: 'Total number of cancellations of match requests',
  })
  private matchSearchTimeMetric = new Histogram({
    name: 'shieldbattery_matchmaker_completion_seconds',
    labelNames: ['matchmaking_type', 'party_size', 'completion_type'],
    help: 'Duration of a matchmaking search in seconds',
    buckets: exponentialBuckets(1, 1.75, 20),
  })

  // Injecting this many is fine!
  // eslint-disable-next-line max-params
  constructor(
    private publisher: TypedPublisher<ReadonlyDeep<MatchmakingEvent>>,
    private userSocketsManager: UserSocketsManager,
    private clientSocketsManager: ClientSocketsManager,
    private matchmakingStatus: MatchmakingStatusService,
    private activityRegistry: GameplayActivityRegistry,
    private gameLoader: LegacyGameLoader,
    @inject(IN_PARTY_CHECKER) private inPartyChecker: InPartyChecker,
    private matchmakingSeasonsService: MatchmakingSeasonsService,
    private clock: Clock,
    private userIdentifierManager: UserIdentifierManager,
  ) {
    this.matchmakers = new Map(
      ALL_MATCHMAKING_TYPES.map(type => [
        type,
        container
          .resolve(Matchmaker)
          .setMatchmakingType(type)
          .setOnMatchFound(this.matchmakerDelegate.onMatchFound),
      ]),
    )
  }

  /**
   * Adds a user to the matchmaking queue. This can only be used for solo players, players in a
   * party should use `findAsParty` instead (this call will fail for them).
   */
  async find(
    userId: SbUserId,
    clientId: string,
    identifiers: ReadonlyArray<ClientIdentifierString>,
    preferences: MatchmakingPreferences,
  ): Promise<void> {
    const { matchmakingType: type } = preferences
    const clientSockets = this.getClientSocketsOrFail(userId, clientId)

    if (!this.matchmakingStatus.isEnabled(type)) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.MatchmakingDisabled,
        'Matchmaking is currently disabled',
      )
    }

    if (this.inPartyChecker.isInParty(userId)) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.InParty,
        'User is in a party, cannot queue as solo player',
      )
    }

    if (!this.activityRegistry.registerActiveClient(userId, clientSockets)) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.GameplayConflict,
        'User is already active in a gameplay activity',
      )
    }

    try {
      await this.queueSoloPlayer(userId, clientId, identifiers, preferences)
    } catch (err) {
      // Clear out the activity registry for this user, since they didn't actually make it into the
      // queue
      this.activityRegistry.unregisterClientForUser(userId)
      throw err
    }
  }

  /**
   * Helper that deals with actually putting a solo player into the queue. This should only be
   * called *after* the player's request has been validated and they've been registered as the
   * active gameplay client.
   */
  private async queueSoloPlayer(
    userId: SbUserId,
    clientId: string,
    identifiers: ReadonlyArray<ClientIdentifierString>,
    preferences: Pick<
      MatchmakingPreferences,
      'matchmakingType' | 'race' | 'mapSelections' | 'data'
    >,
  ): Promise<void> {
    const { matchmakingType: type, race, mapSelections, data: preferenceData } = preferences
    const userSockets = this.getUserSocketsOrFail(userId)
    const clientSockets = this.getClientSocketsOrFail(userId, clientId)

    const season = await this.matchmakingSeasonsService.getCurrentSeason()
    const mmr = await this.retrieveMmr(userId, type, season, identifiers)
    const playerData = matchmakingRatingToPlayerData({
      mmr,
      username: userSockets.name,
      race,
      mapSelections: mapSelections.slice(),
      preferenceData,
    })

    // TODO(tec27): Bump up the uncertainty based on how long ago the last played date was:
    // "After [14] days, the inactive player’s uncertainty (search range) increases by 24 per day,
    // up to a maximum of 336 after 14 additional days."
    const halfUncertainty = mmr.uncertainty / 2

    const player: MatchmakingPlayer = {
      ...playerData,
      interval: {
        low: mmr.rating - halfUncertainty,
        high: mmr.rating + halfUncertainty,
      },
      searchIterations: 0,
    }

    this.matchmakers.get(type)!.addToQueue(player)
    this.queueEntries.set(userId, {
      type,
      userId,
      registeredId: userId,
    })

    this.subscribeUserToQueueUpdates(userSockets, clientSockets, type, race)
    this.matchesRequestedMetric.labels(type, '1').inc()
  }

  /**
   * Adds a party of users to matchmaking as a single group. Callers of this need to manage the
   * registering the gameplay activity status themselves (until this function returns successfully,
   * at which point the activity status will be handled by this service).
   */
  async findAsParty({
    type,
    users,
    partyId,
    leaderId,
    leaderPreferences,
  }: {
    type: MatchmakingType
    users: Readonly<
      Map<
        SbUserId,
        { race: RaceChar; clientId: string; identifiers: ReadonlyArray<ClientIdentifierString> }
      >
    >
    partyId: string
    leaderId: SbUserId
    leaderPreferences: {
      mapSelections: ReadonlyArray<string>
      preferenceData: Readonly<PreferenceData>
    }
  }): Promise<void> {
    const { mapSelections, preferenceData } = leaderPreferences

    if (!this.matchmakingStatus.isEnabled(type)) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.MatchmakingDisabled,
        'Matchmaking is currently disabled',
      )
    }

    if (users.size > TEAM_SIZES[type]) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.TooManyPlayers,
        'Party is too large for that matchmaking type',
      )
    }

    const anyNotInGameplay = Array.from(users.entries()).some(
      ([id, { clientId }]) => this.activityRegistry.getClientForUser(id)?.clientId !== clientId,
    )
    if (anyNotInGameplay) {
      // This is a programming error, rather than something the user should really ever encounter
      throw new Error('At least one party user was not registered in gameplay activity')
    }

    if (users.size === 1) {
      // Just queue as a solo player to simplify the matchmaker logic (which assumes a party is
      // 2 players)
      const user = users.get(leaderId)!
      await this.queueSoloPlayer(leaderId, user.clientId, user.identifiers, {
        matchmakingType: type,
        race: user.race,
        mapSelections: mapSelections.slice(),
        data: preferenceData,
      })
      return
    }

    const season = await this.matchmakingSeasonsService.getCurrentSeason()
    const names = await findUsersByIdAsMap(Array.from(users.keys()))
    const mmrs = await Promise.all(
      Array.from(users.entries(), ([id, { identifiers }]) =>
        this.retrieveMmr(id, type, season, identifiers),
      ),
    )
    const matchmakingParty: MatchmakingParty = {
      leaderId,
      partyId,
      players: mmrs.map(mmr =>
        matchmakingRatingToPlayerData({
          mmr,
          username: names.get(mmr.userId)!.name,
          race: users.get(mmr.userId)!.race,
          mapSelections: mapSelections.slice(),
          preferenceData,
        }),
      ),
      // We'll update this below
      interval: {
        low: 0,
        high: 0,
      },
      searchIterations: 0,
    }

    const effectiveRating = calcEffectiveRating([matchmakingParty])
    // Choose the largest uncertainty among the party members to use as the party's uncertainty
    let uncertainty = 0
    for (const mmr of mmrs) {
      if (mmr.uncertainty > uncertainty) {
        uncertainty = mmr.uncertainty
      }
    }

    const halfUncertainty = uncertainty / 2
    matchmakingParty.interval.low = effectiveRating - halfUncertainty
    matchmakingParty.interval.high = effectiveRating + halfUncertainty

    const userToSockets = new Map(
      Array.from(users.entries(), ([id, { clientId }]) => [
        id,
        {
          userSockets: this.getUserSocketsOrFail(id),
          clientSockets: this.getClientSocketsOrFail(id, clientId),
        },
      ]),
    )

    this.matchmakers.get(type)!.addToQueue(matchmakingParty)
    for (const [userId, { userSockets, clientSockets }] of userToSockets.entries()) {
      this.queueEntries.set(userId, {
        type,
        userId,
        registeredId: leaderId,
        partyId,
      })
      this.subscribeUserToQueueUpdates(userSockets, clientSockets, type, users.get(userId)!.race)
    }
    this.matchesRequestedMetric.labels(type, String(users.size)).inc()
  }

  async cancel(userId: SbUserId): Promise<void> {
    const clientSockets = this.activityRegistry.getClientForUser(userId)
    if (!clientSockets || !this.queueEntries.has(userId)) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.NotInQueue,
        'User does not have an active matchmaking queue',
      )
    } else if (this.queueEntries.get(userId)?.matchId) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.MatchAlreadyStarting,
        'Match is already starting and cannot be canceled',
      )
    }

    this.removeClientFromMatchmaking(clientSockets, false)
  }

  async accept(userId: SbUserId): Promise<void> {
    const queueEntry = this.queueEntries.get(userId)
    if (!queueEntry?.matchId) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.NoActiveMatch,
        'No active match found',
      )
    }

    this.matches.get(queueEntry.matchId)?.registerAccept(userId)
  }

  /**
   * Register that a player left a party. If that party is currently queued, we treat this like a
   * disconnect.
   */
  registerPartyLeave(userId: SbUserId, partyId: string): void {
    const queueEntry = this.queueEntries.get(userId)
    if (queueEntry?.partyId === partyId) {
      this.removeClientFromMatchmaking(this.activityRegistry.getClientForUser(userId)!, false)
    }
  }

  private async retrieveMmr(
    userId: SbUserId,
    type: MatchmakingType,
    season: MatchmakingSeason,
    identifiers: ReadonlyArray<ClientIdentifierString>,
  ): Promise<MatchmakingRating> {
    let currentMmr = await getMatchmakingRating(userId, type, season.id)
    if (!currentMmr) {
      const sameUsers = await this.userIdentifierManager.findUsersWithIdentifiers(identifiers)
      currentMmr = await createInitialMatchmakingRating(userId, type, season, sameUsers)
    }

    return adjustMatchmakingRatingForInactivity(currentMmr, new Date(this.clock.now()))
  }

  private subscribeUserToQueueUpdates(
    userSockets: UserSocketsGroup,
    clientSockets: ClientSocketsGroup,
    matchmakingType: MatchmakingType,
    race: RaceChar,
  ): void {
    userSockets.subscribe<MatchmakingEvent>(
      MatchmakingService.getUserPath(userSockets.userId),
      () => {
        return {
          type: 'queueStatus',
          matchmaking: { type: matchmakingType },
        }
      },
    )
    clientSockets.subscribe<MatchmakingEvent>(
      MatchmakingService.getClientPath(clientSockets),
      () => ({
        type: 'startSearch',
        matchmakingType,
        race,
      }),
      sockets => this.removeClientFromMatchmaking(sockets, true),
    )
  }

  private async runMatch(matchId: string) {
    const match = this.matches.get(matchId)!
    let phase: 'accepting' | 'loading' = 'accepting'

    try {
      while (match.numAccepted < match.totalPlayers) {
        await match.acceptStateChanged

        for (const p of match.players()) {
          this.publishToActiveClient(p.id, {
            type: 'playerAccepted',
            acceptedPlayers: match.numAccepted,
          })
        }
      }

      phase = 'loading'
      await this.doGameLoad(match)
    } catch (err: any) {
      if (
        !isAbortError(err) &&
        !(err instanceof MatchmakingServiceError) &&
        !(err instanceof GameLoaderError)
      ) {
        logger.error({ err }, 'error while processing match')
      }

      // TODO(tec27): GameLoaderError can tell us what player failed to load now, we should add that
      // player (or their party) to the kick list

      const [toKick, toRequeue] = match.getKicksAndRequeues()

      const entities = match.teams.flat()

      for (const id of toKick) {
        const entity = entities.find(entity => getMatchmakingEntityId(entity) === id)!
        for (const p of getPlayersFromEntity(entity)) {
          this.queueEntries.delete(p.id)
          this.publishToActiveClient(p.id, {
            type: 'acceptTimeout',
          })
          this.unregisterActivity(p.id)
        }
      }

      for (const id of toRequeue) {
        const entity = entities.find(entity => getMatchmakingEntityId(entity) === id)!
        let playerMissing = false

        for (const p of getPlayersFromEntity(entity)) {
          const queueEntry = this.queueEntries.get(p.id)
          if (!queueEntry) {
            // This client must have disconnected/left
            playerMissing = true
            continue
          }

          queueEntry.matchId = undefined

          if (phase === 'loading') {
            // TODO(tec27): Give a better reason here, and ideally derive who to kick from the load
            // failures
            this.publishToActiveClient(p.id, {
              type: 'cancelLoading',
              reason: 'loading failed',
            })
          }

          this.publishToActiveClient(p.id, {
            type: 'requeue',
          })
        }

        if (!playerMissing) {
          // Generate a writable version of the MatchmakingEntity
          const newQueueEntry =
            'players' in entity
              ? {
                  ...entity,
                  players: entity.players.map(p => ({ ...p })),
                }
              : {
                  ...entity,
                }

          this.matchmakers.get(match.type)!.addToQueue(newQueueEntry)
        }
      }
    } finally {
      this.matches.delete(match.id)
    }
  }

  private async doGameLoad(match: Match) {
    let slots: Slot[]
    let teams: GameConfigPlayer[][]
    const players = Array.from(match.players())
    const clients: ClientSocketsGroup[] = []
    let declined = false
    for (const p of players) {
      const client = this.activityRegistry.getClientForUser(p.id)
      if (!client) {
        match.registerDecline(p.id)
        declined = true
      } else {
        clients.push(client)
      }
    }
    if (declined) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.ClientDisconnected,
        'client disconnected before game load',
      )
    }

    if (match.type === MatchmakingType.Match1v1) {
      // NOTE(tec27): Type inference here is kinda bad, it should know that Match is a Match1v1 at
      // this point and thus preferenceData has certain things, but it doesn't =/

      const firstPlayer = players[0]
      // NOTE(tec27): alternate race selection is not available for random users. We block this
      // from being set elsewhere, but ignore it here just in case
      const playersHaveSameRace =
        firstPlayer.race !== 'r' && players.every(p => p.race === firstPlayer.race)
      if (playersHaveSameRace && players.every(p => p.preferenceData.useAlternateRace === true)) {
        // All players have the same race and all of them want to use an alternate race: select
        // one of the players randomly to play their alternate race, leaving the other player to
        // play their main race.
        const randomPlayerIndex = randomInt(0, players.length)
        slots = players.map((p, i) =>
          createHuman(
            p.name,
            p.id,
            i === randomPlayerIndex ? p.preferenceData.alternateRace : p.race,
          ),
        )
      } else if (
        playersHaveSameRace &&
        players.some(p => p.preferenceData.useAlternateRace === true)
      ) {
        // All players have the same main race and one of them wants to use an alternate race
        slots = players.map(p =>
          createHuman(
            p.name,
            p.id,
            p.preferenceData.useAlternateRace ? p.preferenceData.alternateRace : p.race,
          ),
        )
      } else {
        // No alternate race selection, so everyone gets their selected race
        slots = players.map(p => createHuman(p.name, p.id, p.race))
      }

      teams = [
        slots.map(s => ({
          id: s.userId,
          race: s.race,
          isComputer: s.type === 'computer' || s.type === 'umsComputer',
        })),
      ]
    } else {
      // Alternate race is not allowed for non-1v1 matchmaking types, so this is very simple!
      const slotsInTeams = match.teams.map(team =>
        team.flatMap(entity =>
          Array.from(getPlayersFromEntity(entity), p => createHuman(p.name, p.id, p.race)),
        ),
      )
      slots = slotsInTeams.flat()
      teams = slotsInTeams.map(t =>
        t.map(s => ({
          id: s.userId,
          race: s.race,
          isComputer: s.type === 'computer' || s.type === 'umsComputer',
        })),
      )
    }

    const entities = match.teams.flat()
    const chosenMap = await pickMap(match.type, entities)

    let gameSourceExtra: MatchmakingExtra
    switch (match.type) {
      case MatchmakingType.Match1v1:
        gameSourceExtra = {
          type: match.type,
        }
        break
      case MatchmakingType.Match2v2:
        gameSourceExtra = {
          type: match.type,
          parties: entities.map(entity => Array.from(getPlayersFromEntity(entity), p => p.id)),
        }
        break
      default:
        gameSourceExtra = assertUnreachable(match.type)
    }

    const gameConfig: GameConfig = {
      gameType: match.type === MatchmakingType.Match1v1 ? GameType.OneVsOne : GameType.TopVsBottom,
      gameSubType: match.type === MatchmakingType.Match1v1 ? 0 : TEAM_SIZES[match.type],
      gameSource: GameSource.Matchmaking,
      gameSourceExtra,
      teams,
    }

    const loadCancelToken = new CancelToken()
    const gameLoaded = this.gameLoader.loadGame({
      players: slots,
      mapId: chosenMap.id,
      gameConfig,
      cancelToken: loadCancelToken,
      onGameSetup: (setup, resultCodes) =>
        this.gameLoaderDelegate.onGameSetup({
          matchInfo: match,
          clients,
          slots,
          setup,
          resultCodes,
          chosenMap: toMapInfoJson(chosenMap),
          cancelToken: loadCancelToken,
        }),
      onRoutesSet: (playerName, routes, gameId) =>
        this.gameLoaderDelegate.onRoutesSet(clients, playerName, routes, gameId),
    })

    await gameLoaded

    for (const player of match.players()) {
      this.queueEntries.delete(player.id)
    }

    this.gameLoaderDelegate.onGameLoaded(clients)
  }

  private unregisterActivity(userId: SbUserId) {
    const activeClient = this.activityRegistry.getClientForUser(userId)
    this.activityRegistry.unregisterClientForUser(userId)
    this.publishToUser(userId, {
      type: 'queueStatus',
      matchmaking: undefined,
    })

    const userSockets = this.userSocketsManager.getById(userId)
    userSockets?.unsubscribe(MatchmakingService.getUserPath(userId))
    activeClient?.unsubscribe(MatchmakingService.getClientPath(activeClient))
  }

  private removeClientFromMatchmaking(client: ClientSocketsGroup, isDisconnect = true) {
    // NOTE(2Pac): Client can leave, i.e. disconnect, during the queueing process, during the
    // loading process, or even during the game process.
    const entry = this.queueEntries.get(client.userId)
    const toUnregister = [client.userId]
    // Means the client disconnected during the queueing process
    if (entry) {
      this.queueEntries.delete(client.userId)

      const entity = this.matchmakers.get(entry.type)!.removeFromQueue(entry.registeredId)
      if (entity) {
        toUnregister.length = 0
        for (const player of getPlayersFromEntity(entity)) {
          toUnregister.push(player.id)
          this.queueEntries.delete(player.id)

          insertMatchmakingCompletion({
            userId: player.id,
            matchmakingType: entry.type,
            completionType: isDisconnect
              ? MatchmakingCompletionType.Disconnect
              : MatchmakingCompletionType.Cancel,
            searchTimeMillis: entity.searchIterations * MATCHMAKING_INTERVAL_MS,
            completionTime: new Date(this.clock.now()),
          }).catch(err => logger.error({ err }, 'error while logging matchmaking completion'))
        }

        this.matchSearchTimeMetric
          .labels(
            entry.type,
            String(getNumPlayersInEntity(entity)),
            isDisconnect ? MatchmakingCompletionType.Disconnect : MatchmakingCompletionType.Cancel,
          )
          .observe((entity.searchIterations * MATCHMAKING_INTERVAL_MS) / 1000)
        this.matchRequestsCanceledMetric
          .labels(entry.type, String(getNumPlayersInEntity(entity)))
          .inc()
      }

      if (entry.matchId) {
        this.matches.get(entry.matchId)?.registerDecline(client.userId)
      }
    }

    for (const userId of toUnregister) {
      if (this.clientTimers.has(userId)) {
        // Means the client disconnected during the loading process
        const { mapSelectionTimer, countdownTimer, cancelToken } = this.clientTimers.get(userId)!
        if (countdownTimer) {
          countdownTimer.reject(new Error('Countdown cancelled'))
        }
        if (mapSelectionTimer) {
          mapSelectionTimer.reject(new Error('Map selection cancelled'))
        }

        cancelToken.cancel()

        this.clientTimers.delete(userId)
      }

      this.unregisterActivity(userId)
    }
  }

  private getUserSocketsOrFail(userId: SbUserId): UserSocketsGroup {
    const userSockets = this.userSocketsManager.getById(userId)
    if (!userSockets) {
      throw new MatchmakingServiceError(MatchmakingServiceErrorCode.UserOffline, 'User is offline')
    }

    return userSockets
  }

  private getClientSocketsOrFail(userId: SbUserId, clientId: string): ClientSocketsGroup {
    const clientSockets = this.clientSocketsManager.getById(userId, clientId)
    if (!clientSockets) {
      throw new MatchmakingServiceError(
        MatchmakingServiceErrorCode.UserOffline,
        'Client could not be found',
      )
    }
    if (clientSockets.clientType !== 'electron') {
      throw new MatchmakingServiceError(MatchmakingServiceErrorCode.InvalidClient, 'Invalid client')
    }

    return clientSockets
  }

  private publishToUser(userId: SbUserId, data?: ReadonlyDeep<MatchmakingEvent>) {
    this.publisher.publish(MatchmakingService.getUserPath(userId), data)
  }

  private publishToActiveClient(userId: SbUserId, data?: ReadonlyDeep<MatchmakingEvent>): boolean {
    const client = this.activityRegistry.getClientForUser(userId)
    if (client) {
      this.publisher.publish(MatchmakingService.getClientPath(client), data)
      return true
    } else {
      return false
    }
  }

  static getUserPath(userId: SbUserId) {
    return urlPath`/matchmaking/${userId}`
  }

  static getClientPath(client: ClientSocketsGroup) {
    return urlPath`/matchmaking/${client.userId}/${client.clientId}`
  }
}
