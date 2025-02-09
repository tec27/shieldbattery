import { Tagged } from 'type-fest'
import { Jsonify } from './json'
import { Patch } from './patch'
import { SbUser, SbUserId } from './users/sb-user'

export const CHANNEL_BANNER_WIDTH = 736 * 2
export const CHANNEL_BANNER_HEIGHT = 414 * 2
export const CHANNEL_BADGE_WIDTH = 80 * 4
export const CHANNEL_BADGE_HEIGHT = 80 * 4

export const MAXIMUM_JOINED_CHANNELS = 40
export const MAXIMUM_OWNED_CHANNELS = 20

export const SEARCH_CHANNELS_LIMIT = 40

export type SbChannelId = Tagged<number, 'SbChannelId'>

/**
 * Converts a channel ID number into a properly typed version. Alternative methods of retrieving an
 * SbChannelId should be preferred, such as using a value retrieved from the database, or getting
 * one via the common Joi validator.
 */
export function makeSbChannelId(id: number): SbChannelId {
  return id as SbChannelId
}

export enum ChatServiceErrorCode {
  CannotChangeChannelOwner = 'CannotChangeChannelOwner',
  CannotEditChannel = 'CannotEditChannel',
  CannotLeaveShieldBattery = 'CannotLeaveShieldBattery',
  CannotModerateChannelOwner = 'CannotModerateChannelOwner',
  CannotModerateChannelModerator = 'CannotModerateChannelModerator',
  CannotModerateShieldBattery = 'CannotModerateShieldBattery',
  CannotModerateYourself = 'CannotModerateYourself',
  ChannelNotFound = 'ChannelNotFound',
  InappropriateImage = 'InappropriateImage',
  MaximumJoinedChannels = 'MaximumJoinedChannels',
  MaximumOwnedChannels = 'MaximumOwnedChannels',
  NoInitialChannelData = 'NoChannelData',
  NotEnoughPermissions = 'NotEnoughPermissions',
  NotInChannel = 'NotInChannel',
  TargetNotInChannel = 'TargetNotInChannel',
  UserBanned = 'UserBanned',
  UserNotFound = 'UserNotFound',
  UserOffline = 'UserOffline',
}

/** Chat messages which are persisted in the DB and shown each time the user opens the app. */
export enum ServerChatMessageType {
  TextMessage = 'message',
  JoinChannel = 'joinChannel',
}

/** Chat messages which are only displayed on the client and are cleared when the app reloads. */
export enum ClientChatMessageType {
  BanUser = 'banUser',
  KickUser = 'kickUser',
  LeaveChannel = 'leaveChannel',
  NewChannelOwner = 'newOwner',
  SelfJoinChannel = 'selfJoinChannel',
}

export type ChatMessageType = ServerChatMessageType | ClientChatMessageType

export interface BaseChatMessage {
  id: string
  type: ChatMessageType
  channelId: SbChannelId
  time: number
}

/** A common text message that the user types in a channel. */
export interface ChannelTextMessage extends BaseChatMessage {
  type: typeof ServerChatMessageType.TextMessage
  from: SbUserId
  text: string
}

/** A message that is displayed in the chat when someone joins the channel. */
export interface JoinChannelMessage extends BaseChatMessage {
  type: typeof ServerChatMessageType.JoinChannel
  userId: SbUserId
}

/** A message that is displayed in the chat when someone leaves the channel. */
export interface LeaveChannelMessage extends BaseChatMessage {
  type: typeof ClientChatMessageType.LeaveChannel
  userId: SbUserId
}

/** A message that is displayed in the chat when someone gets kicked from the channel. */
export interface KickUserMessage extends BaseChatMessage {
  type: typeof ClientChatMessageType.KickUser
  userId: SbUserId
}

/** A message that is displayed in the chat when someone gets banned from the channel. */
export interface BanUserMessage extends BaseChatMessage {
  type: typeof ClientChatMessageType.BanUser
  userId: SbUserId
}

/**
 * A message that is displayed in the chat when a current owner of the channel leaves and a new
 * owner is selected.
 */
export interface NewChannelOwnerMessage extends BaseChatMessage {
  type: typeof ClientChatMessageType.NewChannelOwner
  newOwnerId: SbUserId
}

/**
 * A message that is displayed in the chat to the particular user when they join the channel. Only
 * they can see this message.
 */
export interface SelfJoinChannelMessage extends BaseChatMessage {
  type: typeof ClientChatMessageType.SelfJoinChannel
}

export type ServerChatMessage = ChannelTextMessage | JoinChannelMessage

export type ClientChatMessage =
  | BanUserMessage
  | KickUserMessage
  | LeaveChannelMessage
  | NewChannelOwnerMessage
  | SelfJoinChannelMessage

export type ChatMessage = ServerChatMessage | ClientChatMessage

/**
 * Channel information that is always present and available (e.g. used in channel mentions)
 */
export interface BasicChannelInfo {
  /** The channel ID. */
  id: SbChannelId
  /** The name of the chat channel. */
  name: string
  /**
   * A flag indicating whether the chat channel is private or not. Private chat channels can only be
   * joined through an invite.
   */
  private: boolean
  /**
   * A flag indicating whether the chat channel is declared as an "official" channel. Official
   * channels can have certain rules (e.g. they're created by staff, they have no owners, they don't
   * get deleted if everyone leaves, etc.) that distinguish them from regular channels.
   */
  official: boolean
}

/**
 * Channel information that is displayed in summaries/overviews. This information will not be
 * available for any private channels that the current user has not joined.
 */
export interface DetailedChannelInfo {
  /** The channel ID. */
  id: SbChannelId
  /** The description of the chat channel, if set. */
  description?: string
  /** The path to the banner image of the chat channel, if set. */
  bannerPath?: string
  /** The path to the badge image of the chat channel, if set. */
  badgePath?: string
  /** The Number of users in the channel. */
  userCount: number
}

/**
 * Channel information that is displayed in the channels themselves, and only given to users who
 * have joined that channel.
 */
export interface JoinedChannelInfo {
  /** The channel ID. */
  id: SbChannelId
  /**
   * The ID of the user that is considered a channel owner. Usually the person who joined the chat
   * channel the earliest. Is `undefined` for official channels.
   */
  ownerId?: SbUserId
  /** An optional short message to describe the current topic of the channel. */
  topic?: string
}

export interface ChannelPreferences {
  /** A flag indicating whether to show/hide the channel banner for a user. */
  hideBanner: boolean
}

export interface ChannelPermissions {
  /**
   * A flag indicating whether the user has a permission to kick someone from the channel. Kicking a
   * user allows them to rejoin the channel immediately after they've been kicked.
   */
  kick: boolean
  /**
   * A flag indicating whether the user has a permission to ban someone from the channel. Banning a
   * user forbids them from rejoining the channel until they've been unbanned.
   */
  ban: boolean
  /** A flag indicating whether the user has a permission to change the channel's topic. */
  changeTopic: boolean
  /** A flag indicating whether the user has a permission to change the channel's private status. */
  togglePrivate: boolean
  /** A flag indicating whether the user has a permission to edit other user's permissions. */
  editPermissions: boolean
}

export interface InitialChannelData {
  /** The basic information about the channel that the current user is initializing. */
  channelInfo: BasicChannelInfo
  /** The detailed information about the channel that the current user is initializing. */
  detailedChannelInfo: DetailedChannelInfo
  /** The channel information specific to user's joined channels. */
  joinedChannelInfo: JoinedChannelInfo
  /** A list of IDs of active users that are in the chat channel. */
  activeUserIds: SbUserId[]
  /** The channel preferences for the current user that is initializing the channel. */
  selfPreferences: ChannelPreferences
  /** The channel permissions for the current user that is initializing the channel. */
  selfPermissions: ChannelPermissions
}

export interface ChatInitEvent extends InitialChannelData {
  action: 'init3'
}

export interface ChatJoinEvent {
  action: 'join2'
  /** A user info for the channel user that has joined the chat channel. */
  user: SbUser
  /** A message info for the user joining a channel that is saved in the DB. */
  message: JoinChannelMessage
}

export interface ChatEditEvent {
  action: 'edit'
  /** The updated basic information about the edited channel. */
  channelInfo: BasicChannelInfo
  /** The updated detailed information about the edited channel. */
  detailedChannelInfo: DetailedChannelInfo
  /** The updated channel information specific to user's edited channel. */
  joinedChannelInfo: JoinedChannelInfo
}

export interface ChatLeaveEvent {
  action: 'leave2'
  /** The ID of a user that has left the chat channel. */
  userId: SbUserId
  /** The ID of a user that was selected as a new owner of the channel, if any. */
  newOwnerId?: SbUserId
}

export interface ChatKickEvent {
  action: 'kick'
  /** The ID of a user that was kicked from the chat channel. */
  targetId: SbUserId
  /** The name of the chat channel user was kicked from. */
  channelName: string
  /** The ID of a user that was selected as a new owner of the channel, if any. */
  newOwnerId?: SbUserId
}

export interface ChatBanEvent {
  action: 'ban'
  /** The ID of a user that was banned from the chat channel. */
  targetId: SbUserId
  /** The name of the chat channel user was banned from. */
  channelName: string
  /** The ID of a user that was selected as a new owner of the channel, if any. */
  newOwnerId?: SbUserId
}

export interface ChatMessageEvent {
  action: 'message2'
  /** A text message that was sent in a chat channel. */
  message: ChannelTextMessage
  /** User info for the channel user that sent the message. */
  user: SbUser
  /** User infos for all channel users that were mentioned in the message, if any. */
  mentions: SbUser[]
  /** Basic channel info for all channels that were mentioned in the message, if any. */
  channelMentions: BasicChannelInfo[]
}

export interface ChatMessageDeletedEvent {
  action: 'messageDeleted'
  /** The ID of a message that was deleted in a chat channel. */
  messageId: string
}

export interface ChatUserActiveEvent {
  action: 'userActive2'
  /** The ID of a user that has become active in a chat channel. */
  userId: SbUserId
}

export interface ChatUserIdleEvent {
  action: 'userIdle2'
  /** The ID of a user that has become idle in a chat channel. */
  userId: SbUserId
}

export interface ChatUserOfflineEvent {
  action: 'userOffline2'
  /** The ID of a user that went offline in a chat channel. */
  userId: SbUserId
}

/**
 * Events that are sent to all clients in a particular chat channel.
 */
export type ChatEvent =
  | ChatJoinEvent
  | ChatEditEvent
  | ChatLeaveEvent
  | ChatKickEvent
  | ChatBanEvent
  | ChatMessageEvent
  | ChatMessageDeletedEvent
  | ChatUserActiveEvent
  | ChatUserIdleEvent
  | ChatUserOfflineEvent

export interface ChatPreferencesChangedEvent {
  action: 'preferencesChanged'
  /** The channel preferences for the current user whose preferences have changed. */
  selfPreferences: ChannelPreferences
}

export interface ChatPermissionsChangedEvent {
  action: 'permissionsChanged'
  /** The channel permissions for the current user whose permissions have changed. */
  selfPermissions: ChannelPermissions
}

/** Events that are sent to a particular user in a particular chat channel. */
export type ChatUserEvent =
  | ChatInitEvent
  | ChatPreferencesChangedEvent
  | ChatPermissionsChangedEvent

/**
 * The response returned when joining a specific chat channel.
 */
export interface JoinChannelResponse {
  /** The basic information about the joined channel. */
  channelInfo: BasicChannelInfo
  /** The detailed information about the joined channel. */
  detailedChannelInfo: DetailedChannelInfo
  /** The channel information specific to user's joined channel. */
  joinedChannelInfo: JoinedChannelInfo
}

/**
 * The body data of the API route for editing the channel info.
 */
export interface EditChannelRequest {
  description?: string | null
  topic?: string | null
  deleteBanner?: boolean
  deleteBadge?: boolean
}

/**
 * The response returned when editing a specific chat channel.
 */
export interface EditChannelResponse {
  /** The updated basic information about the edited channel. */
  channelInfo: BasicChannelInfo
  /** The updated detailed information about the edited channel. */
  detailedChannelInfo: DetailedChannelInfo
  /** The updated channel information specific to user's edited channel. */
  joinedChannelInfo: JoinedChannelInfo
}

export interface SendChatMessageServerRequest {
  message: string
}

/**
 * Payload returned for a request to retrieve the channel message history.
 */
export interface GetChannelHistoryServerResponse {
  /** A list of messages that were retrieved for the chat channel. */
  messages: ServerChatMessage[]
  /**
   * A list of user infos for all channel users that were the main "subject" in the messages, if
   * any. The "subject" is defined based on the message type, i.e. for `TextMessage` it's the author
   * of the message, for `JoinedChannelMessage` it's the user that has joined, etc.
   */
  users: SbUser[]
  /** A list of user infos for all channel users that were mentioned in the messages, if any. */
  mentions: SbUser[]
  /** A list of basic channel info for all channels that were mentioned in the messages, if any. */
  channelMentions: BasicChannelInfo[]
  /** A list of channel IDs saved in various channel messages that no longer exist. */
  deletedChannels: SbChannelId[]
}

/**
 * Available moderation actions in a chat channel. Only users with specific permissions should be
 * able to perform them.
 */
export enum ChannelModerationAction {
  Kick = 'kick',
  Ban = 'ban',
}

/**
 * The body data of the API route for moderating users in a chat channel, e.g. kicking or banning
 * them.
 */
export interface ModerateChannelUserServerRequest {
  /** Precise moderation action that will be performed on the user, e.g. kicked or banned. */
  moderationAction: ChannelModerationAction
  /**
   * Optional reason for the moderation action. Mostly useful for more permanent moderation actions,
   * e.g. banning.
   */
  moderationReason?: string
}

/**
 * Specific chat information about a user in a particular channel, such as their join date, their
 * channel role (e.g. are they a moderator), etc.
 */
export interface ChatUserProfile {
  userId: SbUserId
  channelId: SbChannelId
  joinDate: Date
  /**
   * User is considered a channel moderator if they are an owner of the channel, or have one of the
   * following permissions:
   *  - editPermissions
   *  - ban
   *  - kick
   */
  isModerator: boolean
}

export type ChatUserProfileJson = Jsonify<ChatUserProfile>

export function toChatUserProfileJson(chatUserProfile: ChatUserProfile): ChatUserProfileJson {
  return {
    userId: chatUserProfile.userId,
    channelId: chatUserProfile.channelId,
    joinDate: Number(chatUserProfile.joinDate),
    isModerator: chatUserProfile.isModerator,
  }
}

/**
 * The response returned when fetching a profile of a user in a specific chat channel.
 */
export interface GetChatUserProfileResponse {
  /** The ID of a user for which the profile is being returned. */
  userId: SbUserId
  /** The specific channel for which the user's profile is being returned. */
  channelId: SbChannelId
  /**
   * User's profile in a specific chat channel. Includes stuff like their channel join date, channel
   * permissions, etc. Can be `undefined` in case the user has left the channel, but their name is
   * still visible in old messages.
   */
  profile?: ChatUserProfileJson
}

/**
 * The body of a request when updating the preferences of a user in a specific chat channel.
 */
export type UpdateChannelUserPreferencesRequest = Patch<ChannelPreferences>

/**
 * The response returned when fetching the permissions of a user in a specific chat channel.
 */
export interface GetChannelUserPermissionsResponse {
  /** The ID of a user for which the permissions are being returned. */
  userId: SbUserId
  /** The specific channel for which the user's permissions are being returned. */
  channelId: SbChannelId
  /** User's permissions in a specific channel. */
  permissions: ChannelPermissions
}

/**
 * The body of a request when updating the permissions of a user in a specific chat channel.
 */
export interface UpdateChannelUserPermissionsRequest {
  /** The new permissions to update the user to. */
  permissions: ChannelPermissions
}

/**
 * The response returned when fetching the batched channel info.
 */
export interface GetBatchedChannelInfosResponse {
  channelInfos: BasicChannelInfo[]
  detailedChannelInfos: DetailedChannelInfo[]
  joinedChannelInfos: JoinedChannelInfo[]
}

/**
 * The response returned when fetching the channel info.
 */
export interface GetChannelInfoResponse {
  channelInfo: BasicChannelInfo
  detailedChannelInfo?: DetailedChannelInfo
  joinedChannelInfo?: JoinedChannelInfo
}

/**
 * The response returned when searching the channels..
 */
export interface SearchChannelsResponse {
  channelInfos: BasicChannelInfo[]
  detailedChannelInfos: DetailedChannelInfo[]
  joinedChannelInfos: JoinedChannelInfo[]
  hasMoreChannels: boolean
}
