import { SbUser, SbUserId } from './users/user-info'

/** Chat messages which are persisted in the DB and shown each time the user opens the app. */
export enum ServerChatMessageType {
  TextMessage = 'message',
  JoinChannel = 'joinChannel',
}

/** Chat messages which are only displayed on the client and are cleared when the app reloads. */
export enum ClientChatMessageType {
  LeaveChannel = 'leaveChannel',
  NewChannelOwner = 'newOwner',
  SelfJoinChannel = 'selfJoinChannel',
}

export type ChatMessageType = ServerChatMessageType | ClientChatMessageType

export interface BaseChatMessage {
  id: string
  type: ChatMessageType
  channel: string
  time: number
}

/** A common text message that the user types in a channel. */
export interface TextMessage extends BaseChatMessage {
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

export type ServerChatMessage = TextMessage | JoinChannelMessage

export type ClientChatMessage =
  | LeaveChannelMessage
  | NewChannelOwnerMessage
  | SelfJoinChannelMessage

export type ChatMessage = ServerChatMessage | ClientChatMessage

export interface ChannelPermissions {
  kick: boolean
  ban: boolean
  changeTopic: boolean
  togglePrivate: boolean
  editPermissions: boolean
  owner: boolean
}

export interface ChatInitEvent {
  action: 'init2'
  /** A list of IDs of active users that are in the chat channel. */
  activeUserIds: SbUserId[]
  /** The channel permissions for the current user that is initializing the channel. */
  selfPermissions: ChannelPermissions
}

export interface ChatJoinEvent {
  action: 'join2'
  /** A user info for the channel user that has joined the chat channel. */
  user: SbUser
  /** A message info for the user joining a channel that is saved in the DB. */
  message: JoinChannelMessage
}

export interface ChatLeaveEvent {
  action: 'leave2'
  /** The ID of a user that has left the chat channel. */
  userId: SbUserId
  /** The ID of a user that was selected as a new owner of the channel, if any. */
  newOwnerId: SbUserId | null
}

export interface ChatKickEvent {
  action: 'kick'
  /** The ID of a user that was kicked from the chat channel. */
  targetId: SbUserId
  /** The ID of a user that was selected as a new owner of the channel, if any. */
  newOwnerId: SbUserId | null
}

export interface ChatBanEvent {
  action: 'ban'
  /** The ID of a user that was banned from the chat channel. */
  targetId: SbUserId
  /** The ID of a user that was selected as a new owner of the channel, if any. */
  newOwnerId: SbUserId | null
}

export interface ChatMessageEvent {
  action: 'message2'
  /** A text message that was sent in a chat channel. */
  message: TextMessage
  /** User info for the channel user that sent the message. */
  user: SbUser
  /** User infos for all channel users that were mentioned in the message, if any. */
  mentions: SbUser[]
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

export type ChatEvent =
  | ChatInitEvent
  | ChatJoinEvent
  | ChatLeaveEvent
  | ChatKickEvent
  | ChatBanEvent
  | ChatMessageEvent
  | ChatUserActiveEvent
  | ChatUserIdleEvent
  | ChatUserOfflineEvent

export interface SendChatMessageServerBody {
  message: string
}

/**
 * Payload returned for a request to retrieve the channel message history.
 */
export interface GetChannelHistoryServerPayload {
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
export interface ModerateChannelUserServerBody {
  /** User that is about to get moderated, e.g. kicked or banned. */
  targetId: SbUserId
  /** Precise moderation action that will be performed on the user, e.g. kicked or banned. */
  moderationAction: ChannelModerationAction
  /**
   * Optional reason for the moderation action. Mostly useful for more permanent moderation actions,
   * e.g. banning.
   */
  moderationReason?: string
}
