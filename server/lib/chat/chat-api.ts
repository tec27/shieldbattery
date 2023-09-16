import { RouterContext } from '@koa/router'
import Joi from 'joi'
import Koa from 'koa'
import { assertUnreachable } from '../../../common/assert-unreachable'
import {
  ChannelPermissions,
  ChatServiceErrorCode,
  EditChannelRequest,
  EditChannelResponse,
  GetBatchedChannelInfosResponse,
  GetChannelHistoryServerResponse,
  GetChannelInfoResponse,
  GetChannelUserPermissionsResponse,
  GetChatUserProfileResponse,
  JoinChannelResponse,
  ModerateChannelUserServerRequest,
  SEARCH_CHANNELS_LIMIT,
  SbChannelId,
  SearchChannelsResponse,
  SendChatMessageServerRequest,
  UpdateChannelUserPermissionsRequest,
} from '../../../common/chat'
import { CHANNEL_MAXLENGTH, CHANNEL_PATTERN } from '../../../common/constants'
import { SbUser, SbUserId } from '../../../common/users/sb-user'
import { asHttpError } from '../errors/error-with-payload'
import { httpApi, httpBeforeAll } from '../http/http-api'
import { httpBefore, httpDelete, httpGet, httpPatch, httpPost } from '../http/route-decorators'
import { checkAllPermissions } from '../permissions/check-permissions'
import ensureLoggedIn from '../session/ensure-logged-in'
import createThrottle from '../throttle/create-throttle'
import throttleMiddleware from '../throttle/middleware'
import { validateRequest } from '../validation/joi-validator'
import ChatService, { ChatServiceError } from './chat-service'

const joinThrottle = createThrottle('chatjoin', {
  rate: 3,
  burst: 10,
  window: 60000,
})

const editThrottle = createThrottle('chatedit', {
  rate: 50,
  burst: 80,
  window: 60000,
})

const leaveThrottle = createThrottle('chatleave', {
  rate: 10,
  burst: 20,
  window: 60000,
})

const sendThrottle = createThrottle('chatsend', {
  rate: 30,
  burst: 90,
  window: 60000,
})

const retrievalThrottle = createThrottle('chatretrieval', {
  rate: 30,
  burst: 120,
  window: 60000,
})

const channelRetrievalThrottle = createThrottle('channelretrieval', {
  rate: 50,
  burst: 150,
  window: 60000,
})

const kickBanThrottle = createThrottle('chatkickban', {
  rate: 50,
  burst: 90,
  window: 60000,
})

const getUserProfileThrottle = createThrottle('chatgetuserprofile', {
  rate: 40,
  burst: 80,
  window: 60000,
})

const userPermissionsThrottle = createThrottle('chatuserpermissions', {
  rate: 30,
  burst: 60,
  window: 60000,
})

const joiSerialId = () => Joi.number().min(1)
const channelNameSchema = () => Joi.string().max(CHANNEL_MAXLENGTH).pattern(CHANNEL_PATTERN)

function convertChatServiceError(err: unknown) {
  if (!(err instanceof ChatServiceError)) {
    throw err
  }

  switch (err.code) {
    case ChatServiceErrorCode.ChannelNotFound:
    case ChatServiceErrorCode.NotInChannel:
    case ChatServiceErrorCode.TargetNotInChannel:
    case ChatServiceErrorCode.UserOffline:
    case ChatServiceErrorCode.UserNotFound:
      throw asHttpError(404, err)
    case ChatServiceErrorCode.CannotModerateYourself:
    case ChatServiceErrorCode.CannotLeaveShieldBattery:
    case ChatServiceErrorCode.CannotModerateShieldBattery:
    case ChatServiceErrorCode.NoInitialChannelData:
      throw asHttpError(400, err)
    case ChatServiceErrorCode.CannotChangeChannelOwner:
    case ChatServiceErrorCode.CannotEditChannel:
    case ChatServiceErrorCode.CannotModerateChannelOwner:
    case ChatServiceErrorCode.CannotModerateChannelModerator:
    case ChatServiceErrorCode.MaximumJoinedChannels:
    case ChatServiceErrorCode.MaximumOwnedChannels:
    case ChatServiceErrorCode.NotEnoughPermissions:
      throw asHttpError(403, err)
    case ChatServiceErrorCode.UserBanned:
      throw asHttpError(403, err)
    default:
      assertUnreachable(err.code)
  }
}

async function convertChatServiceErrors(ctx: RouterContext, next: Koa.Next) {
  try {
    await next()
  } catch (err) {
    convertChatServiceError(err)
  }
}

function getValidatedChannelId(ctx: RouterContext) {
  const {
    params: { channelId },
  } = validateRequest(ctx, {
    params: Joi.object<{ channelId: SbChannelId }>({
      channelId: joiSerialId().required(),
    }),
  })

  return channelId
}

@httpApi('/chat')
@httpBeforeAll(ensureLoggedIn, convertChatServiceErrors)
export class ChatApi {
  constructor(private chatService: ChatService) {}

  @httpPost('/join/:channelName')
  @httpBefore(throttleMiddleware(joinThrottle, ctx => String(ctx.session!.user!.id)))
  async joinChannel(ctx: RouterContext): Promise<JoinChannelResponse> {
    const {
      params: { channelName },
    } = validateRequest(ctx, {
      params: Joi.object<{ channelName: string }>({
        channelName: channelNameSchema().required(),
      }),
    })

    return await this.chatService.joinChannel(channelName, ctx.session!.user!.id)
  }

  @httpPatch('/:channelId')
  @httpBefore(throttleMiddleware(editThrottle, ctx => String(ctx.session!.user!.id)))
  async editChannel(ctx: RouterContext): Promise<EditChannelResponse> {
    const channelId = getValidatedChannelId(ctx)
    const { body } = validateRequest(ctx, {
      body: Joi.object<EditChannelRequest>({
        description: Joi.string().allow(null),
        topic: Joi.string().allow(null),
      }),
    })

    if (body.description === 'null') {
      body.description = null
    }
    if (body.topic === 'null') {
      body.topic = null
    }

    return await this.chatService.editChannel(channelId, ctx.session!.user!.id, body)
  }

  @httpDelete('/:channelId')
  @httpBefore(throttleMiddleware(leaveThrottle, ctx => String(ctx.session!.user!.id)))
  async leaveChannel(ctx: RouterContext): Promise<void> {
    const channelId = getValidatedChannelId(ctx)

    await this.chatService.leaveChannel(channelId, ctx.session!.user!.id)

    ctx.status = 204
  }

  @httpPost('/:channelId/messages')
  @httpBefore(throttleMiddleware(sendThrottle, ctx => String(ctx.session!.user!.id)))
  async sendChatMessage(ctx: RouterContext): Promise<void> {
    const channelId = getValidatedChannelId(ctx)
    const {
      body: { message },
    } = validateRequest(ctx, {
      body: Joi.object<SendChatMessageServerRequest>({
        message: Joi.string().min(1).required(),
      }),
    })

    await this.chatService.sendChatMessage(channelId, ctx.session!.user!.id, message)

    ctx.status = 204
  }

  /**
   * @deprecated This API was last used in version 7.1.4. Use `/:channelId/messages2` instead.
   */
  @httpGet('/:channelName/messages')
  @httpBefore(throttleMiddleware(retrievalThrottle, ctx => String(ctx.session!.user!.id)))
  getChannelHistoryOld(ctx: RouterContext) {
    return []
  }

  @httpGet('/:channelId/messages2')
  @httpBefore(throttleMiddleware(retrievalThrottle, ctx => String(ctx.session!.user!.id)))
  async getChannelHistory(ctx: RouterContext): Promise<GetChannelHistoryServerResponse> {
    const channelId = getValidatedChannelId(ctx)
    const {
      query: { limit, beforeTime },
    } = validateRequest(ctx, {
      query: Joi.object<{ limit: number; beforeTime: number }>({
        limit: Joi.number().min(1).max(100),
        beforeTime: Joi.number().min(-1),
      }),
    })

    return await this.chatService.getChannelHistory({
      channelId,
      userId: ctx.session!.user!.id,
      limit,
      beforeTime,
    })
  }

  /**
   * @deprecated This API was last used in version 7.1.7. Use `/:channelId/users2` instead.
   */
  @httpGet('/:channelName/users')
  @httpBefore(throttleMiddleware(retrievalThrottle, ctx => String(ctx.session!.user!.id)))
  async getChannelUsersOld(ctx: RouterContext) {
    return []
  }

  @httpGet('/:channelId/users2')
  @httpBefore(throttleMiddleware(retrievalThrottle, ctx => String(ctx.session!.user!.id)))
  async getChannelUsers(ctx: RouterContext): Promise<SbUser[]> {
    const channelId = getValidatedChannelId(ctx)
    return await this.chatService.getChannelUsers({ channelId, userId: ctx.session!.user!.id })
  }

  @httpGet('/:channelId/users/:targetId')
  @httpBefore(throttleMiddleware(getUserProfileThrottle, ctx => String(ctx.session!.user!.id)))
  async getChatUserProfile(ctx: RouterContext): Promise<GetChatUserProfileResponse> {
    const {
      params: { channelId, targetId },
    } = validateRequest(ctx, {
      params: Joi.object<{ channelId: SbChannelId; targetId: SbUserId }>({
        channelId: joiSerialId().required(),
        targetId: joiSerialId().required(),
      }),
    })

    return await this.chatService.getChatUserProfile(channelId, ctx.session!.user!.id, targetId)
  }

  @httpPost('/:channelId/users/:targetId/remove')
  @httpBefore(throttleMiddleware(kickBanThrottle, ctx => String(ctx.session!.user!.id)))
  async moderateChannelUser(ctx: RouterContext): Promise<void> {
    const {
      params: { channelId, targetId },
      body: { moderationAction, moderationReason },
    } = validateRequest(ctx, {
      params: Joi.object<{ channelId: SbChannelId; targetId: SbUserId }>({
        channelId: joiSerialId().required(),
        targetId: joiSerialId().required(),
      }),
      body: Joi.object<ModerateChannelUserServerRequest>({
        moderationAction: Joi.string().valid('kick', 'ban').required(),
        moderationReason: Joi.string().allow(''),
      }),
    })

    await this.chatService.moderateUser(
      channelId,
      ctx.session!.user!.id,
      targetId,
      moderationAction,
      moderationReason,
    )

    ctx.status = 204
  }

  @httpGet('/:channelId/users/:targetId/permissions')
  @httpBefore(throttleMiddleware(userPermissionsThrottle, ctx => String(ctx.session!.user!.id)))
  async getChannelUserPermissions(ctx: RouterContext): Promise<GetChannelUserPermissionsResponse> {
    const {
      params: { channelId, targetId },
    } = validateRequest(ctx, {
      params: Joi.object<{ channelId: SbChannelId; targetId: SbUserId }>({
        channelId: joiSerialId().required(),
        targetId: joiSerialId().required(),
      }),
    })

    return await this.chatService.getUserPermissions(channelId, ctx.session!.user!.id, targetId)
  }

  @httpPost('/:channelId/users/:targetId/permissions')
  @httpBefore(throttleMiddleware(userPermissionsThrottle, ctx => String(ctx.session!.user!.id)))
  async updateChannelUserPermissions(ctx: RouterContext): Promise<void> {
    const {
      params: { channelId, targetId },
      body: { permissions },
    } = validateRequest(ctx, {
      params: Joi.object<{ channelId: SbChannelId; targetId: SbUserId }>({
        channelId: joiSerialId().required(),
        targetId: joiSerialId().required(),
      }),
      body: Joi.object<UpdateChannelUserPermissionsRequest>({
        permissions: Joi.object<ChannelPermissions>({
          kick: Joi.boolean().required(),
          ban: Joi.boolean().required(),
          changeTopic: Joi.boolean().required(),
          togglePrivate: Joi.boolean().required(),
          editPermissions: Joi.boolean().required(),
        }).required(),
      }),
    })

    await this.chatService.updateUserPermissions(
      channelId,
      ctx.session!.user!.id,
      targetId,
      permissions,
    )

    ctx.status = 204
  }

  @httpGet('/batch-info')
  @httpBefore(throttleMiddleware(channelRetrievalThrottle, ctx => String(ctx.session!.user!.id)))
  async getBatchedChannelInfos(ctx: RouterContext): Promise<GetBatchedChannelInfosResponse> {
    const {
      query: { c: channelIds },
    } = validateRequest(ctx, {
      query: Joi.object<{ c: SbChannelId[] }>({
        c: Joi.array().items(joiSerialId()).single().min(1).max(40),
      }),
    })

    return await this.chatService.getChannelInfos(channelIds, ctx.session!.user!.id)
  }

  @httpGet('/:channelId(\\d+)')
  @httpBefore(throttleMiddleware(channelRetrievalThrottle, ctx => String(ctx.session!.user!.id)))
  async getChannelInfo(ctx: RouterContext): Promise<GetChannelInfoResponse> {
    const channelId = getValidatedChannelId(ctx)

    return await this.chatService.getChannelInfo(channelId, ctx.session!.user!.id)
  }

  @httpGet('/')
  @httpBefore(throttleMiddleware(channelRetrievalThrottle, ctx => String(ctx.session!.user!.id)))
  async searchChannels(ctx: RouterContext): Promise<SearchChannelsResponse> {
    const {
      query: { q: searchQuery, offset },
    } = validateRequest(ctx, {
      query: Joi.object<{ q?: string; offset: number }>({
        q: Joi.string().allow(''),
        offset: Joi.number().min(0),
      }),
    })

    return await this.chatService.searchChannels({
      userId: ctx.session!.user!.id,
      limit: SEARCH_CHANNELS_LIMIT,
      offset,
      searchStr: searchQuery,
    })
  }
}

@httpApi('/admin/chat')
@httpBeforeAll(
  ensureLoggedIn,
  checkAllPermissions('moderateChatChannels'),
  convertChatServiceErrors,
)
export class AdminChatApi {
  constructor(private chatService: ChatService) {}

  @httpGet('/:channelId/messages')
  async getChannelHistory(ctx: RouterContext): Promise<GetChannelHistoryServerResponse> {
    const channelId = getValidatedChannelId(ctx)
    const {
      query: { limit, beforeTime },
    } = validateRequest(ctx, {
      query: Joi.object<{ limit: number; beforeTime: number }>({
        limit: Joi.number().min(1).max(100),
        beforeTime: Joi.number().min(-1),
      }),
    })

    return await this.chatService.getChannelHistory({
      channelId,
      userId: ctx.session!.user!.id,
      limit,
      beforeTime,
      isAdmin: true,
    })
  }

  @httpGet('/:channelId/users')
  async getChannelUsers(ctx: RouterContext): Promise<SbUser[]> {
    const channelId = getValidatedChannelId(ctx)
    return await this.chatService.getChannelUsers({
      channelId,
      userId: ctx.session!.user!.id,
      isAdmin: true,
    })
  }

  @httpDelete('/:channelId/messages/:messageId')
  async deleteMessage(ctx: RouterContext): Promise<void> {
    const {
      params: { channelId, messageId },
    } = validateRequest(ctx, {
      params: Joi.object<{ channelId: SbChannelId; messageId: string }>({
        channelId: joiSerialId().required(),
        messageId: Joi.string().required(),
      }),
    })

    await this.chatService.deleteMessage({
      channelId,
      messageId,
      userId: ctx.session!.user!.id,
      isAdmin: true,
    })

    ctx.status = 204
  }
}
