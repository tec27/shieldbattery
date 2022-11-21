import { Counter, Histogram, linearBuckets } from 'prom-client'
import { singleton } from 'tsyringe'
import { isAbortError, raceAbort } from '../../../common/async/abort-signals'
import createDeferred, { Deferred } from '../../../common/async/deferred'
import { GameConfig } from '../../../common/games/configuration'
import { SbUserId } from '../../../common/users/sb-user'
import { CodedError } from '../errors/coded-error'
import log from '../logging/logger'
import { deleteUserRecordsForGame } from '../models/games-users'
import { findUsersById } from '../users/user-model'
import { TypedPublisher } from '../websockets/typed-publisher'
import { deleteRecordForGame } from './game-models'
import { GameplayActivityRegistry } from './gameplay-activity-registry'
import { registerGame } from './registration'

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
    private typedPublished: TypedPublisher<never>,
  ) {}

  async loadGame({
    mapId,
    gameConfig,
    signal = new AbortController().signal,
  }: {
    mapId: string
    gameConfig: GameConfig
    signal?: AbortSignal
  }): Promise<void> {
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

    try {
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
          // FIXME: fix type here
          client.subscribe<any>(gamePath, () => ({
            gameConfig,
            userInfos,
            resultCode,
          }))
        }
      }
      // FIXME: wait for changes, check if done, repeat
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
    }
  }

  registerPlayerLoaded(gameId: string, userId: SbUserId) {
    const loadInProgress = this.loadsInProgress.get(gameId)
    if (!loadInProgress || !loadInProgress.playerIds.has(userId)) {
      throw new GameLoaderError(GameLoadErrorType.GameNotFound, 'game not found')
    }

    loadInProgress.registerPlayerLoaded(userId)
  }

  /** Returns the websocket path used to broadcast game loading updates by this service. */
  static getLoaderPath(gameId: string) {
    return `/game-loader/${gameId}`
  }
}
