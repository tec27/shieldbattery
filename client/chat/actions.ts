import {
  ChatBanEvent,
  ChatInitEvent,
  ChatJoinEvent,
  ChatKickEvent,
  ChatLeaveEvent,
  ChatMessageDeletedEvent,
  ChatMessageEvent,
  ChatPermissionsChangedEvent,
  ChatPreferencesChangedEvent,
  ChatUserActiveEvent,
  ChatUserIdleEvent,
  ChatUserOfflineEvent,
  GetBatchedChannelInfosResponse,
  GetChannelHistoryServerResponse,
  GetChannelInfoResponse,
  GetChatUserProfileResponse,
  InitialChannelData,
  SbChannelId,
  SearchChannelsResponse,
} from '../../common/chat'
import { SbUser } from '../../common/users/sb-user'
import { BaseFetchFailure } from '../network/fetch-errors'

export type ChatActions =
  | JoinChannelBegin
  | JoinChannel
  | JoinChannelFailure
  | LeaveChannelBegin
  | LeaveChannel
  | LeaveChannelFailure
  | SendMessageBegin
  | SendMessage
  | SendMessageFailure
  | LoadMessageHistoryBegin
  | LoadMessageHistory
  | LoadMessageHistoryFailure
  | RetrieveUserListBegin
  | RetrieveUserList
  | RetrieveUserListFailure
  | GetChatUserProfile
  | GetChannelInfo
  | GetBatchChannelInfoSuccess
  | GetBatchChannelInfoFailure
  | GetJoinedChannels
  | SearchChannels
  | ActivateChannel
  | DeactivateChannel
  | InitChannel
  | UpdateJoin
  | UpdateLeave
  | UpdateLeaveSelf
  | UpdateKick
  | UpdateKickSelf
  | UpdateBan
  | UpdateBanSelf
  | UpdateMessage
  | UpdateMessageDeleted
  | UpdateUserActive
  | UpdateUserIdle
  | UpdateUserOffline
  | UpdateSelfPreferences
  | UpdateSelfPermissions

export interface GetJoinedChannels {
  type: '@chat/getJoinedChannels'
  payload: InitialChannelData[]
}

export interface JoinChannelBegin {
  type: '@chat/joinChannelBegin'
  payload: {
    channelId: SbChannelId
  }
}

/**
 * Makes the user join a channel. If a channel doesn't exist, it is created and user gets full
 * permissions in it.
 */
export interface JoinChannel {
  type: '@chat/joinChannel'
  payload: void
  meta: {
    channelId: SbChannelId
  }
  error?: false
}

export interface JoinChannelFailure extends BaseFetchFailure<'@chat/joinChannel'> {
  meta: {
    channelId: SbChannelId
  }
}

export interface LeaveChannelBegin {
  type: '@chat/leaveChannelBegin'
  payload: {
    channelId: SbChannelId
  }
}

/**
 * Makes the user leave a channel. If the user was the "owner" of the channel, a new "owner" will be
 * selected. If the user was the only member of the channel, the channel will be effectively reset.
 */
export interface LeaveChannel {
  type: '@chat/leaveChannel'
  payload: void
  meta: {
    channelId: SbChannelId
  }
  error?: false
}

export interface LeaveChannelFailure extends BaseFetchFailure<'@chat/leaveChannel'> {
  meta: {
    channelId: SbChannelId
  }
}

export interface SendMessageBegin {
  type: '@chat/sendMessageBegin'
  payload: {
    channelId: SbChannelId
    message: string
  }
}

/**
 * Send a chat message to a chat channel.
 */
export interface SendMessage {
  type: '@chat/sendMessage'
  payload: void
  meta: {
    channelId: SbChannelId
    message: string
  }
  error?: false
}

export interface SendMessageFailure extends BaseFetchFailure<'@chat/sendMessage'> {
  meta: {
    channelId: SbChannelId
    message: string
  }
}

export interface LoadMessageHistoryBegin {
  type: '@chat/loadMessageHistoryBegin'
  payload: {
    channelId: SbChannelId
    limit: number
    beforeTime: number
  }
}

/**
 * Loads the `limit` amount of messages in a chat channel before a particular time.
 */
export interface LoadMessageHistory {
  type: '@chat/loadMessageHistory'
  payload: GetChannelHistoryServerResponse
  meta: {
    channelId: SbChannelId
    limit: number
    beforeTime: number
  }
  error?: false
}

export interface LoadMessageHistoryFailure extends BaseFetchFailure<'@chat/loadMessageHistory'> {
  meta: {
    channelId: SbChannelId
    limit: number
    beforeTime: number
  }
}

export interface RetrieveUserListBegin {
  type: '@chat/retrieveUserListBegin'
  payload: {
    channelId: SbChannelId
  }
}

/**
 * Retrieve the full list of users in a particular channel.
 */
export interface RetrieveUserList {
  type: '@chat/retrieveUserList'
  payload: SbUser[]
  meta: {
    channelId: SbChannelId
  }
  error?: false
}

export interface RetrieveUserListFailure extends BaseFetchFailure<'@chat/retrieveUserList'> {
  meta: {
    channelId: SbChannelId
  }
}

/**
 * Get the specific user's profile in a particular chat channel.
 */
export interface GetChatUserProfile {
  type: '@chat/getChatUserProfile'
  payload: GetChatUserProfileResponse
}

/**
 * Get the information for a specific channel. Includes joined data if the user is in the channel.
 */
export interface GetChannelInfo {
  type: '@chat/getChannelInfo'
  payload: GetChannelInfoResponse
  meta: { channelId: SbChannelId }
}

/**
 * The server returned a response to our request for channel info about one or more channels.
 */
export interface GetBatchChannelInfoSuccess {
  type: '@chat/getBatchChannelInfo'
  payload: GetBatchedChannelInfosResponse
  error?: false
}

export type GetBatchChannelInfoFailure = BaseFetchFailure<'@chat/getBatchChannelInfo'>

/**
 * The server returned a response to our request for channel search.
 */
export interface SearchChannels {
  type: '@chat/searchChannels'
  payload: SearchChannelsResponse
}

/**
 * Activate a particular chat channel. This is a purely client-side action which marks the channel
 * as "active", and removes the unread indicator if there is one.
 */
export interface ActivateChannel {
  type: '@chat/activateChannel'
  payload: {
    channelId: SbChannelId
  }
}

/**
 * Deactivate a particular chat channel. This is a purely client-side action which unloads the
 * message history of a channel and thus frees up some memory.
 */
export interface DeactivateChannel {
  type: '@chat/deactivateChannel'
  payload: {
    channelId: SbChannelId
  }
}

/**
 * We have joined a channel and the server has sent us some initial data.
 */
export interface InitChannel {
  type: '@chat/initChannel'
  payload: ChatInitEvent
  meta: { channelId: SbChannelId }
}

/**
 * A user has joined a channel we're in.
 */
export interface UpdateJoin {
  type: '@chat/updateJoin'
  payload: ChatJoinEvent
  meta: { channelId: SbChannelId }
}

/**
 * A user has left a channel we're in.
 */
export interface UpdateLeave {
  type: '@chat/updateLeave'
  payload: ChatLeaveEvent
  meta: { channelId: SbChannelId }
}

/**
 * We have left a channel.
 */
export interface UpdateLeaveSelf {
  type: '@chat/updateLeaveSelf'
  meta: { channelId: SbChannelId }
}

/**
 * A user has been kicked in a channel we're in.
 */
export interface UpdateKick {
  type: '@chat/updateKick'
  payload: ChatKickEvent
  meta: { channelId: SbChannelId }
}

/**
 * We have been kicked from a channel.
 */
export interface UpdateKickSelf {
  type: '@chat/updateKickSelf'
  meta: { channelId: SbChannelId }
}

/**
 * A user has been banned in a channel we're in.
 */
export interface UpdateBan {
  type: '@chat/updateBan'
  payload: ChatBanEvent
  meta: { channelId: SbChannelId }
}

/**
 * We have been banned from a channel.
 */
export interface UpdateBanSelf {
  type: '@chat/updateBanSelf'
  meta: { channelId: SbChannelId }
}

/**
 * A channel we're in has receieved a new text message.
 */
export interface UpdateMessage {
  type: '@chat/updateMessage'
  payload: ChatMessageEvent
  meta: { channelId: SbChannelId }
}

/**
 * A message was deleted in a channel we're in.
 */
export interface UpdateMessageDeleted {
  type: '@chat/updateMessageDeleted'
  payload: ChatMessageDeletedEvent
  meta: { channelId: SbChannelId }
}

/**
 * A user in one of our chat channels has become active (non-idle and online).
 */
export interface UpdateUserActive {
  type: '@chat/updateUserActive'
  payload: ChatUserActiveEvent
  meta: { channelId: SbChannelId }
}

/**
 * A user in one of our chat channels has become idle (still online, but not active).
 */
export interface UpdateUserIdle {
  type: '@chat/updateUserIdle'
  payload: ChatUserIdleEvent
  meta: { channelId: SbChannelId }
}

/**
 * A user in one of our chat channels has gone offline.
 */
export interface UpdateUserOffline {
  type: '@chat/updateUserOffline'
  payload: ChatUserOfflineEvent
  meta: { channelId: SbChannelId }
}

/**
 * Our preferences in one of the chat channels we're in have changed.
 */
export interface UpdateSelfPreferences {
  type: '@chat/preferencesChanged'
  payload: ChatPreferencesChangedEvent
  meta: { channelId: SbChannelId }
}

/**
 * Our permissions in one of the chat channels we're in have changed.
 */
export interface UpdateSelfPermissions {
  type: '@chat/permissionsChanged'
  payload: ChatPermissionsChangedEvent
  meta: { channelId: SbChannelId }
}
