import { Map, Record, Set } from 'immutable'
import { NydusServer } from 'nydus'
import { singleton } from 'tsyringe'
import { ChatEvent, ChatInitEvent, ChatMessage, ChatUser } from '../../../common/chat'
import filterChatMessage from '../messaging/filter-chat-message'
import { UserSocketsGroup, UserSocketsManager } from '../websockets/socket-groups'
import { TypedPublisher } from '../websockets/typed-publisher'
import {
  addMessageToChannel,
  addUserToChannel,
  findChannel,
  getChannelsForUser,
  getMessagesForChannel,
  getUsersForChannel,
  leaveChannel,
} from './chat-models'

class ChatState extends Record({
  /** Maps channel name -> Set of users in that channel (as names). */
  channels: Map<string, Set<string>>(),
  /** Maps username -> Set of channels they're in (as names). */
  users: Map<string, Set<string>>(),
}) {}

export enum ChatServiceErrorCode {
  UserOffline,
  InvalidJoinAction,
  LeaveShieldBattery,
  InvalidLeaveAction,
  InvalidSendAction,
  InvalidGetHistoryAction,
  InvalidGetUsersAction,
}

export class ChatServiceError extends Error {
  constructor(readonly code: ChatServiceErrorCode, message: string) {
    super(message)
  }
}

export function getChannelPath(channelName: string): string {
  return `/chat/${encodeURIComponent(channelName)}`
}

@singleton()
export default class ChatService {
  private state = new ChatState()

  constructor(
    private publisher: TypedPublisher<ChatEvent>,
    private nydus: NydusServer,
    private userSocketsManager: UserSocketsManager,
  ) {
    userSocketsManager
      .on('newUser', (userSockets: UserSocketsGroup) => this.handleNewUser(userSockets))
      .on('userQuit', (userName: string) => this.handleUserQuit(userName))
  }

  async joinChannel(channelName: string, userName: string) {
    const userSockets = this.getUserSockets(userName)
    const originalChannelName = await this.getOriginalChannelName(channelName)
    if (
      this.state.users.has(userSockets.name) &&
      this.state.users.get(userSockets.name)!.has(originalChannelName)
    ) {
      throw new ChatServiceError(ChatServiceErrorCode.InvalidJoinAction, 'Already in this channel')
    }

    await addUserToChannel(userSockets.session.userId, originalChannelName)

    this.state = this.state
      .updateIn(['channels', originalChannelName], (s = Set()) => s.add(userName))
      .updateIn(['users', userName], (s = Set()) => s.add(originalChannelName))

    this.publisher.publish(getChannelPath(originalChannelName), {
      action: 'join',
      user: userName,
    })
    this.subscribeUserToChannel(userSockets, originalChannelName)
  }

  async leaveChannel(channelName: string, userName: string) {
    const userSockets = this.getUserSockets(userName)
    const originalChannelName = await this.getOriginalChannelName(channelName)
    if (originalChannelName === 'ShieldBattery') {
      throw new ChatServiceError(
        ChatServiceErrorCode.LeaveShieldBattery,
        "Can't leave ShieldBattery channel",
      )
    }
    if (
      !this.state.users.has(userSockets.name) ||
      !this.state.users.get(userSockets.name)!.has(originalChannelName)
    ) {
      throw new ChatServiceError(
        ChatServiceErrorCode.InvalidLeaveAction,
        'Must be in channel to leave it',
      )
    }

    const result = await leaveChannel(userSockets.session.userId, originalChannelName)
    const updated = this.state.channels.get(originalChannelName)!.delete(userSockets.name)
    this.state = updated.size
      ? this.state.setIn(['channels', originalChannelName], updated)
      : this.state.deleteIn(['channels', originalChannelName])
    this.state = this.state.updateIn(['users', userSockets.name], u =>
      u.delete(originalChannelName),
    )

    this.publisher.publish(getChannelPath(originalChannelName), {
      action: 'leave',
      user: userSockets.name,
      newOwner: result.newOwner,
    })
    this.unsubscribeUserFromChannel(userSockets, originalChannelName)
  }

  async sendChatMessage(channelName: string, userName: string, message: string) {
    const userSockets = this.getUserSockets(userName)
    const originalChannelName = await this.getOriginalChannelName(channelName)
    // TODO(tec27): lookup channel keys case insensitively?
    if (
      !this.state.users.has(userSockets.name) ||
      !this.state.users.get(userSockets.name)!.has(originalChannelName)
    ) {
      throw new ChatServiceError(
        ChatServiceErrorCode.InvalidSendAction,
        'Must be in a channel to send a message to it',
      )
    }

    const text = filterChatMessage(message)
    const result = await addMessageToChannel(userSockets.session.userId, originalChannelName, {
      type: 'message',
      text,
    })

    this.publisher.publish(getChannelPath(originalChannelName), {
      action: 'message',
      id: result.msgId,
      user: result.userName,
      sent: Number(result.sent),
      data: result.data,
    })
  }

  async getChannelHistory(
    channelName: string,
    userName: string,
    limit?: number,
    beforeTime?: number,
  ): Promise<ChatMessage[]> {
    const userSockets = this.getUserSockets(userName)
    const originalChannelName = await this.getOriginalChannelName(channelName)
    // TODO(tec27): lookup channel keys case insensitively?
    if (
      !this.state.users.has(userSockets.name) ||
      !this.state.users.get(userSockets.name)!.has(originalChannelName)
    ) {
      throw new ChatServiceError(
        ChatServiceErrorCode.InvalidGetHistoryAction,
        'Must be in a channel to retrieve message history',
      )
    }

    const messages = await getMessagesForChannel(
      originalChannelName,
      userSockets.session.userId,
      limit,
      beforeTime && beforeTime > -1 ? new Date(beforeTime) : undefined,
    )
    return messages.map<ChatMessage>(m => ({
      id: m.msgId,
      user: m.userName,
      sent: Number(m.sent),
      data: m.data,
    }))
  }

  async getChannelUsers(channelName: string, userName: string): Promise<ChatUser[]> {
    const userSockets = this.getUserSockets(userName)
    const originalChannelName = await this.getOriginalChannelName(channelName)
    if (
      !this.state.users.has(userSockets.name) ||
      !this.state.users.get(userSockets.name)!.has(originalChannelName)
    ) {
      throw new ChatServiceError(
        ChatServiceErrorCode.InvalidGetUsersAction,
        'Must be in a channel to retrieve user list',
      )
    }

    const users = await getUsersForChannel(originalChannelName)
    return users.map(u => u.userName)
  }

  async getOriginalChannelName(channelName: string) {
    const foundChannel = await findChannel(channelName)

    // If the channel already exists in database, return its name with original casing; otherwise
    // return it as is
    return foundChannel ? foundChannel.name : channelName
  }

  private getUserSockets(userName: string): UserSocketsGroup {
    const userSockets = this.userSocketsManager.getByName(userName)
    if (!userSockets) {
      throw new ChatServiceError(ChatServiceErrorCode.UserOffline, 'User is offline')
    }

    return userSockets
  }

  private subscribeUserToChannel(userSockets: UserSocketsGroup, channelName: string) {
    userSockets.subscribe<ChatInitEvent>(getChannelPath(channelName), () => ({
      action: 'init',
      activeUsers: this.state.channels.get(channelName)!.toArray(),
    }))
  }

  unsubscribeUserFromChannel(user: UserSocketsGroup, channelName: string) {
    user.unsubscribe(getChannelPath(channelName))
  }

  private async handleNewUser(userSockets: UserSocketsGroup) {
    const channelsForUser = await getChannelsForUser(userSockets.session.userId)
    if (!userSockets.sockets.size) {
      // The user disconnected while we were waiting for their channel list
      return
    }

    const channelSet = Set(channelsForUser.map(c => c.channelName))
    const userSet = Set([userSockets.name])
    const inChannels = Map(channelsForUser.map(c => [c.channelName, userSet]))

    this.state = this.state
      .mergeDeepIn(['channels'], inChannels)
      .setIn(['users', userSockets.name], channelSet)
    for (const { channelName: chan } of channelsForUser) {
      this.publisher.publish(getChannelPath(chan), {
        action: 'userActive',
        user: userSockets.name,
      })
      this.subscribeUserToChannel(userSockets, chan)
    }
    userSockets.subscribe(`${userSockets.getPath()}/chat`, () => ({ type: 'chatReady' }))
  }

  private async handleUserQuit(userName: string) {
    if (!this.state.users.has(userName)) {
      // This can happen if a user disconnects before we get their channel list back from the DB
      return
    }
    const channels = this.state.users.get(userName)!
    for (const channel of channels.values()) {
      const updated = this.state.channels.get(channel)?.delete(userName)
      this.state = updated?.size
        ? this.state.setIn(['channels', channel], updated)
        : this.state.deleteIn(['channels', channel])
    }
    this.state = this.state.deleteIn(['users', userName])

    for (const c of channels.values()) {
      this.publisher.publish(getChannelPath(c), {
        action: 'userOffline',
        user: userName,
      })
    }
  }
}
