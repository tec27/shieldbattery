import { RouterContext } from '@koa/router'
import Joi from 'joi'
import {
  PASSWORD_MINLENGTH,
  USERNAME_MAXLENGTH,
  USERNAME_MINLENGTH,
  USERNAME_PATTERN,
} from '../../../common/constants'
import { MatchmakingType } from '../../../common/matchmaking'
import { SelfUser, UserErrorCode } from '../../../common/users/sb-user'
import { ClientSessionInfo } from '../../../common/users/session'
import { httpApi, httpBeforeAll } from '../http/http-api'
import { httpBefore, httpDelete, httpGet, httpPost } from '../http/route-decorators'
import { getPermissions } from '../models/permissions'
import { Redis } from '../redis'
import createThrottle from '../throttle/create-throttle'
import throttleMiddleware from '../throttle/middleware'
import { isUserBanned, retrieveBanHistory } from '../users/ban-models'
import { joiClientIdentifiers } from '../users/client-ids'
import { convertUserApiErrors, UserApiError } from '../users/user-api-errors'
import { UserIdentifierManager } from '../users/user-identifier-manager'
import { attemptLogin, findSelfById, maybeMigrateSignupIp } from '../users/user-model'
import { validateRequest } from '../validation/joi-validator'
import ensureLoggedIn from './ensure-logged-in'
import initSession from './init'

// TODO(tec27): Think about maybe a different mechanism for this. I could see this causing problems
// when lots of people need to create sessions at once from the same place (e.g. LAN events)
const loginThrottle = createThrottle('login', {
  rate: 4,
  burst: 20,
  window: 60000,
})

interface LogInRequestBody {
  username: string
  password: string
  remember?: boolean
  clientIds?: ReadonlyArray<[type: number, hashStr: string]>
}

@httpApi('/sessions')
@httpBeforeAll(convertUserApiErrors)
export class SessionApi {
  constructor(private userIdentifierManager: UserIdentifierManager, private redis: Redis) {}

  @httpGet('/')
  async getCurrentSession(ctx: RouterContext): Promise<ClientSessionInfo> {
    if (!ctx.session?.userId) {
      throw new UserApiError(UserErrorCode.SessionExpired, 'Session expired')
    }
    const userId = ctx.session.userId

    let user: SelfUser | undefined
    try {
      user = await findSelfById(userId)
    } catch (err) {
      ctx.log.error({ err }, 'error finding user')
      throw err
    }

    if (!user) {
      await ctx.regenerateSession()
      throw new UserApiError(UserErrorCode.SessionExpired, 'Session expired')
    }

    const sessionInfo: ClientSessionInfo = {
      user,
      permissions: ctx.session.permissions,
      lastQueuedMatchmakingType: ctx.session.lastQueuedMatchmakingType,
    }
    // Ensure that the currently saved session has matching values to what we just retrieved from
    // the DB (prevents things like a user having a session with outdated email verification status
    // due to a botched migration or something)
    initSession(ctx, sessionInfo)

    return {
      user,
      permissions: ctx.session.permissions,
      lastQueuedMatchmakingType: ctx.session.lastQueuedMatchmakingType,
    }
  }

  @httpPost('/')
  @httpBefore(throttleMiddleware(loginThrottle, ctx => ctx.ip))
  async startNewSession(ctx: RouterContext): Promise<ClientSessionInfo> {
    const { body } = validateRequest(ctx, {
      body: Joi.object<LogInRequestBody>({
        username: Joi.string()
          .min(USERNAME_MINLENGTH)
          .max(USERNAME_MAXLENGTH)
          .pattern(USERNAME_PATTERN)
          .required(),
        password: Joi.string().min(PASSWORD_MINLENGTH).required(),
        remember: Joi.boolean(),
        // TODO(tec27): Make this required in future versions (cur v8.0.2). This is just to allow
        // old clients to log in so it triggers auto-update
        clientIds: joiClientIdentifiers(),
      }),
    })

    const { username, password, remember, clientIds } = body
    let user: SelfUser | undefined

    if (ctx.session?.userId) {
      try {
        user = await findSelfById(ctx.session.userId)
      } catch (err) {
        ctx.log.error({ err }, 'error finding user')
      }

      if (!user) {
        await ctx.regenerateSession()
      }
    }

    if (!user) {
      user = await attemptLogin(username, password)
    }

    if (!user) {
      throw new UserApiError(UserErrorCode.InvalidCredentials, 'Incorrect username or password')
    }

    if (clientIds) {
      await this.userIdentifierManager.upsert(user.id, clientIds)
    }

    if (await isUserBanned(user.id)) {
      const banHistory = await retrieveBanHistory(user.id, 1)
      const banEntry = banHistory.length ? banHistory[0] : undefined
      throw new UserApiError(UserErrorCode.AccountBanned, 'This account has been banned', {
        data: {
          reason: banEntry?.reason,
          expiration: Number(banEntry?.endTime),
        },
      })
    } else if (await this.userIdentifierManager.banUserIfNeeded(user.id)) {
      // NOTE(tec27): We make sure to do this check *after* checking the account ban only, otherwise
      // any banned used that attempts to logs in will be permanently banned.
      const banHistory = await retrieveBanHistory(user.id, 1)
      const banEntry = banHistory.length ? banHistory[0] : undefined
      throw new UserApiError(UserErrorCode.AccountBanned, 'This account has been banned', {
        data: {
          reason: banEntry?.reason,
          expiration: Number(banEntry?.endTime),
        },
      })
    }

    await ctx.regenerateSession()
    const perms = (await getPermissions(user.id))!
    await maybeMigrateSignupIp(user.id, ctx.ip)

    const sessionInfo: ClientSessionInfo = {
      user,
      permissions: perms,
      lastQueuedMatchmakingType: MatchmakingType.Match1v1,
    }

    initSession(ctx, sessionInfo)
    if (!remember) {
      // Make the cookie a session-expiring cookie
      ctx.session!.cookie.maxAge = undefined
      ctx.session!.cookie.expires = undefined
    }

    return sessionInfo
  }

  @httpDelete('/')
  @httpBefore(ensureLoggedIn)
  async endSession(ctx: RouterContext): Promise<void> {
    if (!ctx.session?.userId) {
      throw new UserApiError(UserErrorCode.SessionExpired, 'Session expired')
    }

    await this.redis.srem('user_sessions:' + ctx.session.userId, ctx.sessionId!)
    await ctx.regenerateSession()
    ctx.status = 204
  }
}
