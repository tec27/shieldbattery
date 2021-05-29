import Router, { RouterContext } from '@koa/router'
import httpErrors from 'http-errors'
import Joi from 'joi'
import Koa from 'koa'
import { container } from 'tsyringe'
import { assertUnreachable } from '../../../common/assert-unreachable'
import { USERNAME_MAXLENGTH, USERNAME_MINLENGTH, USERNAME_PATTERN } from '../../../common/constants'
import { PARTIES } from '../../../common/flags'
import { featureEnabled } from '../flags/feature-enabled'
import users from '../models/users'
import ensureLoggedIn from '../session/ensure-logged-in'
import createThrottle from '../throttle/create-throttle'
import throttleMiddleware from '../throttle/middleware'
import { joiValidator } from '../validation/joi-validator'
import PartyService, { PartyServiceError, PartyServiceErrorCode, PartyUser } from './party-service'

const invitesThrottle = createThrottle('partyInvites', {
  rate: 40,
  burst: 60,
  window: 60000,
})

const partyThrottle = createThrottle('parties', {
  rate: 20,
  burst: 40,
  window: 60000,
})

const clientIdSchema = Joi.object().keys({
  clientId: Joi.string().required(),
})

const invitesPostSchema = clientIdSchema.keys({
  targets: Joi.array()
    .items(
      Joi.string()
        .min(USERNAME_MINLENGTH)
        .max(USERNAME_MAXLENGTH)
        .pattern(USERNAME_PATTERN)
        .required(),
    )
    .min(1)
    .required(),
})

const partyIdSchema = Joi.object().keys({
  partyId: Joi.string().required(),
})

const removeInviteParamsSchema = partyIdSchema.keys({
  targetId: Joi.number().required(),
})

function isPartyServiceError(error: Error): error is PartyServiceError {
  return error.hasOwnProperty('code')
}

function convertPartyServiceError(err: Error) {
  if (!isPartyServiceError(err)) {
    throw err
  }

  switch (err.code) {
    case PartyServiceErrorCode.PartyNotFound:
      throw new httpErrors.NotFound(err.message)
    case PartyServiceErrorCode.InsufficientPermissions:
      throw new httpErrors.Forbidden(err.message)
    case PartyServiceErrorCode.PartyFull:
      throw new httpErrors.Conflict(err.message)
    case PartyServiceErrorCode.UserOffline:
      throw new httpErrors.NotFound(err.message)
    case PartyServiceErrorCode.InvalidAction:
      throw new httpErrors.BadRequest(err.message)
    default:
      assertUnreachable(err.code)
  }
}

async function convertPartyServiceErrors(ctx: RouterContext, next: Koa.Next) {
  try {
    await next()
  } catch (err) {
    convertPartyServiceError(err)
  }
}

export default function (router: Router) {
  // NOTE(tec27): Just ensures the service gets initialized on app init
  container.resolve(PartyService)

  router
    .use(featureEnabled(PARTIES), ensureLoggedIn, convertPartyServiceErrors)
    .post(
      '/invites',
      throttleMiddleware(invitesThrottle, ctx => String(ctx.session!.userId)),
      joiValidator({ body: invitesPostSchema }),
      invite,
    )
    .delete(
      '/invites/:partyId',
      throttleMiddleware(invitesThrottle, ctx => String(ctx.session!.userId)),
      joiValidator({ params: partyIdSchema }),
      decline,
    )
    .delete(
      '/invites/:partyId/:targetId',
      throttleMiddleware(invitesThrottle, ctx => String(ctx.session!.userId)),
      joiValidator({ params: removeInviteParamsSchema }),
      removeInvite,
    )
    .post(
      '/:partyId',
      throttleMiddleware(partyThrottle, ctx => String(ctx.session!.userId)),
      joiValidator({ params: partyIdSchema, body: clientIdSchema }),
      accept,
    )
}

// TODO(2Pac): Move this somewhere common and share with client
export interface PartiesInviteBody {
  clientId: string
  targets: string[]
}

// TODO(2Pac): Move this somewhere common and share with client
export interface PartiesAcceptBody {
  clientId: string
}

async function invite(ctx: RouterContext) {
  const { clientId, targets } = ctx.request.body as PartiesInviteBody

  const invites = await Promise.all<PartyUser>(
    targets.map(async (target): Promise<PartyUser> => {
      const foundTarget = await users.find(target)
      if (!foundTarget) {
        throw new httpErrors.NotFound('Target user not found')
      }

      // TODO(2Pac): Check if the target user has blocked invitations from the user issuing
      // the request. Or potentially use friends list when implemented.

      return { id: foundTarget.id as number, name: foundTarget.name }
    }),
  )

  const leader: PartyUser = {
    id: ctx.session!.userId,
    name: ctx.session!.userName,
  }

  const partyService = container.resolve(PartyService)
  partyService.invite(leader, clientId, invites)

  ctx.status = 204
}

async function decline(ctx: RouterContext) {
  const { partyId } = ctx.params

  const target: PartyUser = { id: ctx.session!.userId, name: ctx.session!.userName }

  const partyService = container.resolve(PartyService)
  partyService.decline(partyId, target)

  ctx.status = 204
}

async function removeInvite(ctx: RouterContext) {
  const { partyId, targetId } = ctx.params

  const foundTarget = await users.find(targetId)
  if (!foundTarget) {
    throw new httpErrors.NotFound('Target user not found')
  }

  const removingUser: PartyUser = { id: ctx.session!.userId, name: ctx.session!.userName }
  const target: PartyUser = { id: foundTarget.id as number, name: foundTarget.name }

  const partyService = container.resolve(PartyService)
  partyService.removeInvite(partyId, removingUser, target)

  ctx.status = 204
}

async function accept(ctx: RouterContext) {
  const { partyId } = ctx.params
  const { clientId } = ctx.request.body as PartiesAcceptBody

  const user: PartyUser = { id: ctx.session!.userId, name: ctx.session!.userName }

  const partyService = container.resolve(PartyService)
  partyService.acceptInvite(partyId, user, clientId)

  ctx.status = 204
}
