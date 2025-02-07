import {
  ChannelModerationAction,
  ChatServiceErrorCode,
  EditChannelRequest,
  EditChannelResponse,
  GetBatchedChannelInfosResponse,
  GetChannelHistoryServerResponse,
  GetChannelInfoResponse,
  GetChatUserProfileResponse,
  InitialChannelData,
  JoinChannelResponse,
  ModerateChannelUserServerRequest,
  SbChannelId,
  SearchChannelsResponse,
  SendChatMessageServerRequest,
  UpdateChannelUserPreferencesRequest,
} from '../../common/chat'
import { getErrorStack } from '../../common/errors'
import { apiUrl, urlPath } from '../../common/urls'
import { SbUser, SbUserId } from '../../common/users/sb-user'
import { ThunkAction } from '../dispatch-registry'
import i18n from '../i18n/i18next'
import logger from '../logging/logger'
import { push, replace } from '../navigation/routing'
import { RequestHandlingSpec, abortableThunk } from '../network/abortable-thunk'
import { MicrotaskBatchRequester } from '../network/batch-requests'
import { encodeBodyAsParams, fetchJson } from '../network/fetch'
import { isFetchError } from '../network/fetch-errors'
import { RequestCoalescer } from '../network/request-coalescer'
import { TIMING_LONG, openSnackbar } from '../snackbars/action-creators'
import { ActivateChannel, DeactivateChannel } from './actions'

export function getJoinedChannels(spec: RequestHandlingSpec<void>): ThunkAction {
  return abortableThunk(spec, async dispatch => {
    const joinedChannels = await fetchJson<InitialChannelData[]>(apiUrl`chat/joined-channels`, {
      method: 'GET',
      signal: spec.signal,
    })

    dispatch({
      type: '@chat/getJoinedChannels',
      payload: joinedChannels,
    })
  })
}

/**
 * Makes a request to join a user to the channel. The caller is expected to handle errors.
 */
export function joinChannel(
  channelName: string,
  spec: RequestHandlingSpec<JoinChannelResponse>,
): ThunkAction {
  return abortableThunk(spec, async () => {
    return await fetchJson(apiUrl`chat/join/${channelName}`, {
      method: 'POST',
      signal: spec.signal,
    })
  })
}

/**
 * Makes a request to join a user to the channel. This function has built-in error handling.
 */
export function joinChannelWithErrorHandling(
  channelName: string,
  spec: RequestHandlingSpec<void>,
): ThunkAction {
  return abortableThunk(spec, async dispatch => {
    return fetchJson<JoinChannelResponse>(apiUrl`chat/join/${channelName}`, {
      method: 'POST',
      signal: spec.signal,
    })
      .then(channel => navigateToChannel(channel.channelInfo.id, channel.channelInfo.name))
      .catch(err => {
        let message = i18n.t('chat.joinChannel.genericError', {
          defaultValue: 'An error occurred while joining #{{channelName}}',
          channelName,
        })

        if (isFetchError(err) && err.code) {
          if (err.code === ChatServiceErrorCode.MaximumJoinedChannels) {
            message = i18n.t(
              'chat.joinChannel.maximumChannelsError',
              'You have reached the limit of joined channels. ' +
                'You must leave one before you can join another.',
            )
          } else if (err.code === ChatServiceErrorCode.UserBanned) {
            message = i18n.t('chat.joinChannel.bannedError', {
              defaultValue: 'You are banned from #{{channelName}}',
              channelName,
            })
          } else {
            logger.error(`Unhandled code when joining ${channelName}: ${err.code}`)
          }
        } else {
          logger.error(`Error when joining ${channelName}: ${err.stack ?? err}`)
        }

        dispatch(openSnackbar({ message, time: TIMING_LONG }))

        throw err
      })
  })
}

export function updateChannel({
  channelId,
  channelChanges,
  channelBanner,
  channelBadge,
  spec,
}: {
  channelId: SbChannelId
  channelChanges: EditChannelRequest
  channelBanner?: File
  channelBadge?: File
  spec: RequestHandlingSpec<void>
}): ThunkAction {
  return abortableThunk(spec, async dispatch => {
    if (
      Object.values(channelChanges).filter(c => c !== undefined).length === 0 &&
      !channelBanner &&
      !channelBadge
    ) {
      return
    }

    const formData = new FormData()
    formData.append(
      'channelChanges',
      JSON.stringify(channelChanges, (_, value) => (value === '' ? null : value)),
    )

    if (channelBanner) {
      formData.append('banner', channelBanner)
    }
    if (channelBadge) {
      formData.append('badge', channelBadge)
    }

    const result = await fetchJson<EditChannelResponse>(apiUrl`chat/${channelId}`, {
      method: 'PATCH',
      signal: spec.signal,
      body: formData,
    })

    dispatch({
      type: '@chat/getChannelInfo',
      payload: result,
      meta: {
        channelId,
      },
    })
  })
}

export function updateChannelUserPreferences(
  channelId: SbChannelId,
  preferences: UpdateChannelUserPreferencesRequest,
  spec: RequestHandlingSpec<void>,
) {
  return abortableThunk(spec, async () => {
    return await fetchJson(apiUrl`chat/${channelId}/userPreferences`, {
      method: 'POST',
      body: encodeBodyAsParams<UpdateChannelUserPreferencesRequest>(preferences),
      signal: spec.signal,
    })
  })
}

export function leaveChannel(channelId: SbChannelId): ThunkAction {
  return dispatch => {
    const params = { channelId }
    dispatch({
      type: '@chat/leaveChannelBegin',
      payload: params,
    })
    dispatch({
      type: '@chat/leaveChannel',
      payload: fetchJson<void>(apiUrl`chat/${channelId}`, { method: 'DELETE' }),
      meta: params,
    })
  }
}

export function moderateUser(
  channelId: SbChannelId,
  userId: SbUserId,
  moderationAction: ChannelModerationAction,
  spec: RequestHandlingSpec<void>,
  moderationReason?: string,
): ThunkAction {
  return abortableThunk(spec, async () => {
    return fetchJson<void>(apiUrl`chat/${channelId}/users/${userId}/remove`, {
      method: 'POST',
      body: encodeBodyAsParams<ModerateChannelUserServerRequest>({
        moderationAction,
        moderationReason,
      }),
      signal: spec.signal,
    })
  })
}

export function sendMessage(channelId: SbChannelId, message: string): ThunkAction {
  return dispatch => {
    const params = { channelId, message }
    dispatch({
      type: '@chat/sendMessageBegin',
      payload: params,
    })

    dispatch({
      type: '@chat/sendMessage',
      payload: fetchJson<void>(apiUrl`chat/${channelId}/messages`, {
        method: 'POST',
        body: encodeBodyAsParams<SendChatMessageServerRequest>({ message }),
      }),
      meta: params,
    })
  }
}

export function deleteMessageAsAdmin(
  channelId: SbChannelId,
  messageId: string,
  spec: RequestHandlingSpec,
): ThunkAction {
  return abortableThunk(spec, async () => {
    await fetchJson<void>(apiUrl`admin/chat/${channelId}/messages/${messageId}`, {
      method: 'DELETE',
      signal: spec.signal,
    })
  })
}

export function getMessageHistory(channelId: SbChannelId, limit: number): ThunkAction {
  return (dispatch, getStore) => {
    const {
      chat: { idToMessages },
    } = getStore()
    const channelMessages = idToMessages.get(channelId)
    const earliestMessageTime = channelMessages?.messages.length
      ? channelMessages.messages[0].time
      : -1
    const params = { channelId, limit, beforeTime: earliestMessageTime }

    dispatch({
      type: '@chat/loadMessageHistoryBegin',
      payload: params,
    })
    dispatch({
      type: '@chat/loadMessageHistory',
      payload: fetchJson<GetChannelHistoryServerResponse>(
        apiUrl`chat/${channelId}/messages2?limit=${limit}&beforeTime=${earliestMessageTime}`,
        { method: 'GET' },
      ),
      meta: params,
    })
  }
}

export function retrieveUserList(channelId: SbChannelId): ThunkAction {
  return (dispatch, getStore) => {
    const {
      chat: { idToUsers },
    } = getStore()
    const channelUsers = idToUsers.get(channelId)
    if (channelUsers?.hasLoadedUserList || channelUsers?.loadingUserList) {
      return
    }

    const params = { channelId }
    dispatch({
      type: '@chat/retrieveUserListBegin',
      payload: params,
    })
    dispatch({
      type: '@chat/retrieveUserList',
      payload: fetchJson<SbUser[]>(apiUrl`chat/${channelId}/users2`, {
        method: 'GET',
      }),
      meta: params,
    })
  }
}

const getChatUserProfileRequestCoalescer = new RequestCoalescer<`${SbChannelId}|${SbUserId}`>()

export function getChatUserProfile(
  channelId: SbChannelId,
  targetId: SbUserId,
  spec: RequestHandlingSpec<void>,
): ThunkAction {
  return abortableThunk(spec, async (dispatch, getStore) => {
    await getChatUserProfileRequestCoalescer.makeRequest(
      `${channelId}|${targetId}`,
      spec.signal,
      async (signal: AbortSignal) => {
        dispatch({
          type: '@chat/getChatUserProfile',
          payload: await fetchJson<GetChatUserProfileResponse>(
            apiUrl`chat/${channelId}/users/${targetId}`,
            {
              method: 'GET',
              signal,
            },
          ),
        })
      },
    )
  })
}

export function getChannelInfo(
  channelId: SbChannelId,
  spec: RequestHandlingSpec<void>,
): ThunkAction {
  return abortableThunk(spec, async dispatch => {
    dispatch({
      type: '@chat/getChannelInfo',
      payload: await fetchJson<GetChannelInfoResponse>(apiUrl`chat/${channelId}`, {
        method: 'GET',
        signal: spec.signal,
      }),
      meta: { channelId },
    })
  })
}

const MAX_BATCH_CHANNEL_REQUESTS = 40

const channelsBatchRequester = new MicrotaskBatchRequester<SbChannelId>(
  MAX_BATCH_CHANNEL_REQUESTS,
  (dispatch, items) => {
    const params = items.map(c => urlPath`c=${c}`).join('&')
    const promise = fetchJson<GetBatchedChannelInfosResponse>(
      apiUrl`chat/batch-info` + '?' + params,
    )
    dispatch({
      type: '@chat/getBatchChannelInfo',
      payload: promise,
    })

    return promise
  },
  err => {
    logger.error('error while batch requesting channels: ' + getErrorStack(err))
  },
)

/**
 * Queues a request to the server for channel information, if necessary. This will batch multiple
 * requests that happen close together into one request to the server.
 */
export function getBatchChannelInfo(channelId: SbChannelId): ThunkAction {
  return (dispatch, getState) => {
    const {
      chat: { idToBasicInfo, idToDetailedInfo },
    } = getState()

    if (!idToBasicInfo.has(channelId) || !idToDetailedInfo.has(channelId)) {
      channelsBatchRequester.request(dispatch, channelId)
    }
  }
}

export function searchChannels(
  searchQuery: string,
  offset: number,
  spec: RequestHandlingSpec<SearchChannelsResponse>,
): ThunkAction {
  return abortableThunk(spec, async dispatch => {
    const result = await fetchJson<SearchChannelsResponse>(
      apiUrl`chat/?q=${searchQuery}&offset=${offset}`,
      {
        signal: spec.signal,
      },
    )

    dispatch({
      type: '@chat/searchChannels',
      payload: result,
    })

    return result
  })
}

export function activateChannel(channelId: SbChannelId): ActivateChannel {
  return {
    type: '@chat/activateChannel',
    payload: { channelId },
  }
}

export function deactivateChannel(channelId: SbChannelId): DeactivateChannel {
  return {
    type: '@chat/deactivateChannel',
    payload: { channelId },
  }
}

export function navigateToChannel(channelId: SbChannelId, channelName: string) {
  push(urlPath`/chat/${channelId}/${channelName}`)
}

/**
 * Corrects the URL for a specific chat channel if it is already being viewed. This is meant to be
 * used when the client arrived on the page but the channel name doesn't match what we have stored
 * for their channel ID.
 */
export function correctChannelNameForChat(channelId: SbChannelId, channelName: string) {
  replace(urlPath`/chat/${channelId}/${channelName}`)
}
