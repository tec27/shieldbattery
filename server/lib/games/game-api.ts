import { RouterContext } from '@koa/router'
import httpErrors from 'http-errors'
import Joi from 'joi'
import Koa from 'koa'
import { Readable } from 'stream'
import { container, inject, singleton } from 'tsyringe'
import { assertUnreachable } from '../../../common/assert-unreachable'
import { GameStatus } from '../../../common/game-status'
import { GetGameResponse, toGameRecordJson } from '../../../common/games/games'
import {
  ALL_GAME_CLIENT_RESULTS,
  GameResultErrorCode,
  SubmitGameResultsRequest,
} from '../../../common/games/results'
import { toMapInfoJson } from '../../../common/maps'
import { toPublicMatchmakingRatingChangeJson } from '../../../common/matchmaking'
import { asHttpError } from '../errors/error-with-payload'
import { httpApi, httpBeforeAll } from '../http/http-api'
import { httpBefore, httpGet, httpPost, httpPut } from '../http/route-decorators'
import logger from '../logging/logger'
import { getMapInfo } from '../maps/map-models'
import { UpsertUserIp } from '../network/user-ips-type'
import ensureLoggedIn from '../session/ensure-logged-in'
import createThrottle from '../throttle/create-throttle'
import throttleMiddleware from '../throttle/middleware'
import { findUsersByIdAsMap } from '../users/user-model'
import { joiUserId } from '../users/user-validators'
import { validateRequest } from '../validation/joi-validator'
import { countCompletedGames } from './game-models'
import GameResultService, { GameResultServiceError } from './game-result-service'
import { LegacyGameLoader } from './legacy-game-loader'

const throttle = createThrottle('games', {
  rate: 20,
  burst: 40,
  window: 60000,
})

const gameResultsThrottle = createThrottle('gamesResults', {
  rate: 10,
  burst: 30,
  window: 60000,
})

const GAME_ID_PARAM = Joi.object<{ gameId: string }>({
  gameId: Joi.string().required(),
})

@singleton()
class GameCountEmitter {
  static readonly GAME_COUNT_UPDATE_TIME_MS = 30 * 1000

  streams = new Set<Readable>()
  interval: ReturnType<typeof setInterval> | undefined
  lastCount = 0

  addListener(stream: Readable) {
    stream.push(`event: gameCount\ndata: ${this.lastCount}\n\n`)
    this.streams.add(stream)
    this.start()
  }

  removeListener(stream: Readable) {
    this.streams.delete(stream)
    if (this.streams.size === 0) {
      this.stop()
    }
  }

  private start() {
    if (this.interval) {
      return
    }

    const doCount = () => {
      countCompletedGames()
        .then(count => {
          this.lastCount = count
          const message = `event: gameCount\ndata: ${this.lastCount}\n\n`
          for (const stream of this.streams.values()) {
            stream.push(message)
          }
        })
        .catch(err => {
          logger.error({ err }, 'error retrieving/sending completed game count')
        })
    }

    doCount()
    this.interval = setInterval(doCount, GameCountEmitter.GAME_COUNT_UPDATE_TIME_MS)
  }

  private stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }
}

function convertGameResultServiceErrors(err: unknown) {
  if (!(err instanceof GameResultServiceError)) {
    throw err
  }

  switch (err.code) {
    case GameResultErrorCode.NotFound:
      throw asHttpError(404, err)
    case GameResultErrorCode.AlreadyReported:
      throw asHttpError(409, err)
    case GameResultErrorCode.InvalidPlayers:
      throw asHttpError(400, err)
    case GameResultErrorCode.InvalidClient:
      throw asHttpError(400, err)
    default:
      assertUnreachable(err.code)
  }
}

async function convertServiceErrors(ctx: RouterContext, next: Koa.Next) {
  try {
    await next()
  } catch (err) {
    convertGameResultServiceErrors(err)
  }
}

@httpApi('/games')
@httpBeforeAll(convertServiceErrors)
export class GameApi {
  constructor(
    private gameResultService: GameResultService,
    @inject('upsertUserIp') private upsertUserIp: UpsertUserIp,
    private gameLoader: LegacyGameLoader,
  ) {}

  @httpGet('/:gameId')
  @httpBefore(throttleMiddleware(throttle, ctx => String(ctx.session?.userId) ?? ctx.ip))
  async getGame(ctx: RouterContext): Promise<GetGameResponse> {
    const {
      params: { gameId },
    } = validateRequest(ctx, {
      params: GAME_ID_PARAM,
    })

    const game = await this.gameResultService.retrieveGame(gameId)

    const usersToRetrieve = game.config.teams.flatMap(t =>
      t.filter(p => !p.isComputer).map(p => p.id),
    )
    const [mapArray, users, mmrChanges] = await Promise.all([
      getMapInfo([game.mapId], ctx.session!.userId),
      findUsersByIdAsMap(usersToRetrieve),
      this.gameResultService.retrieveMatchmakingRatingChanges(game),
    ])

    return {
      game: toGameRecordJson(game),
      map: mapArray.length ? toMapInfoJson(mapArray[0]) : undefined,
      users: Array.from(users.values()),
      mmrChanges: mmrChanges.map(m => toPublicMatchmakingRatingChangeJson(m)),
    }
  }

  @httpPost('/:gameId/subscribe')
  @httpBefore(ensureLoggedIn, throttleMiddleware(throttle, ctx => String(ctx.session!.userId)))
  async subscribeToGame(ctx: RouterContext): Promise<void> {
    const {
      params: { gameId },
      query: { clientId },
    } = validateRequest(ctx, {
      params: GAME_ID_PARAM,
      query: Joi.object<{ clientId: string }>({ clientId: Joi.string().required() }).required(),
    })

    await this.gameResultService.subscribeToGame(ctx.session!.userId, clientId, gameId)
    ctx.status = 204
  }

  @httpPost('/:gameId/unsubscribe')
  @httpBefore(ensureLoggedIn, throttleMiddleware(throttle, ctx => String(ctx.session!.userId)))
  async unsubscribeFromGame(ctx: RouterContext): Promise<void> {
    const {
      params: { gameId },
      query: { clientId },
    } = validateRequest(ctx, {
      params: GAME_ID_PARAM,
      query: Joi.object<{ clientId: string }>({ clientId: Joi.string().required() }).required(),
    })

    await this.gameResultService.unsubscribeFromGame(ctx.session!.userId, clientId, gameId)
    ctx.status = 204
  }

  @httpPut('/:gameId/status')
  @httpBefore(ensureLoggedIn, throttleMiddleware(throttle, ctx => String(ctx.session!.userId)))
  async updateGameStatus(ctx: RouterContext): Promise<void> {
    const { gameId } = ctx.params
    const { status } = ctx.request.body

    if (status < GameStatus.Playing || status > GameStatus.Error) {
      throw new httpErrors.BadRequest('invalid game status')
    }

    if (
      (status === GameStatus.Playing || status === GameStatus.Error) &&
      !this.gameLoader.isLoading(gameId)
    ) {
      throw new httpErrors.Conflict('game must be loading')
    }

    if (status === GameStatus.Playing) {
      if (!this.gameLoader.registerGameAsLoaded(gameId, ctx.session!.userName)) {
        throw new httpErrors.NotFound('game not found')
      }
    } else if (status === GameStatus.Error) {
      if (!this.gameLoader.maybeCancelLoading(gameId, ctx.session!.userName)) {
        throw new httpErrors.NotFound('game not found')
      }
    } else {
      throw new httpErrors.BadRequest('invalid game status')
    }

    ctx.status = 204
  }

  // NOTE(tec27): This doesn't require being logged in because the game client sends these requests,
  // the body is intended to be secret per user and authenticate that they are the one who sent it.
  @httpPost('/:gameId/results2')
  @httpBefore(throttleMiddleware(gameResultsThrottle, ctx => String(ctx.ip)))
  async submitGameResults(ctx: RouterContext): Promise<void> {
    const {
      params: { gameId },
      body: { userId, resultCode, time, playerResults },
    } = validateRequest(ctx, {
      params: GAME_ID_PARAM,
      body: Joi.object<SubmitGameResultsRequest>({
        userId: Joi.number().min(0).required(),
        resultCode: Joi.string().required(),
        time: Joi.number().min(0).required(),
        playerResults: Joi.array()
          .items(
            Joi.array()
              .ordered(
                joiUserId().required(),
                Joi.object({
                  result: Joi.valid(...ALL_GAME_CLIENT_RESULTS).required(),
                  race: Joi.string().valid('p', 't', 'z').required(),
                  apm: Joi.number().min(0).required(),
                }).required(),
              )
              .required(),
          )
          .min(1)
          .max(8)
          .required(),
      }).required(),
    })

    await this.gameResultService.submitGameResults({
      gameId,
      userId,
      resultCode,
      time,
      playerResults,
      logger: ctx.log,
    })

    // If it was successful, record this user's IP for that account, since the normal middleware
    // to do so won't have run
    this.upsertUserIp(userId, ctx.ip)

    ctx.status = 204
  }

  @httpGet('/')
  async streamGameCount(ctx: RouterContext): Promise<Readable> {
    const gameCountEmitter = container.resolve(GameCountEmitter)
    const stream = new Readable({ highWaterMark: 0, read() {} })

    const cleanup = () => {
      gameCountEmitter.removeListener(stream)
      stream.push(null)
    }

    ctx.req.on('close', cleanup).on('finish', cleanup).on('error', cleanup)

    ctx.type = 'text/event-stream'
    ctx.status = 200
    ctx.res.flushHeaders()
    ctx.dontSendSessionCookies = true

    gameCountEmitter.addListener(stream)

    return stream
  }
}
