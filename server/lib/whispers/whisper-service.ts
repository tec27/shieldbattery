import { Map as IMap, Set as ISet, OrderedSet } from 'immutable'
import { singleton } from 'tsyringe'
import { assertUnreachable } from '../../../common/assert-unreachable'
import { SbChannelId } from '../../../common/chat'
import { subtract } from '../../../common/data-structures/sets'
import { urlPath } from '../../../common/urls'
import { SbUser, SbUserId } from '../../../common/users/sb-user'
import {
  GetSessionHistoryResponse,
  WhisperEvent,
  WhisperMessage,
  WhisperMessageType,
  WhisperServiceErrorCode,
  WhisperSessionInitEvent,
} from '../../../common/whispers'
import { getChannelInfos, toBasicChannelInfo } from '../chat/chat-models'
import logger from '../logging/logger'
import filterChatMessage from '../messaging/filter-chat-message'
import { processMessageContents } from '../messaging/process-chat-message'
import { findUserById, findUsersById } from '../users/user-model'
import { UserSocketsGroup, UserSocketsManager } from '../websockets/socket-groups'
import { TypedPublisher } from '../websockets/typed-publisher'
import {
  addMessageToWhisper,
  closeWhisperSession as dbCloseWhisperSession,
  startWhisperSession as dbStartWhisperSession,
  getMessagesForWhisperSession,
  getWhisperSessionsForUser,
} from './whisper-models'

export class WhisperServiceError extends Error {
  constructor(
    readonly code: WhisperServiceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function getSessionPath(user: SbUserId, target: SbUserId) {
  const [low, high] = user < target ? [user, target] : [target, user]
  return urlPath`/whispers3/${low}-${high}`
}

@singleton()
export default class WhisperService {
  /** Maps user ID -> OrderedSet of their whisper sessions (as IDs of target users) */
  private userSessions = IMap<SbUserId, OrderedSet<SbUserId>>()
  /** Maps user ID -> Set of users that have session open with them (as IDs) */
  private sessionUsers = IMap<SbUserId, ISet<SbUserId>>()

  constructor(
    private publisher: TypedPublisher<WhisperEvent>,
    private userSocketsManager: UserSocketsManager,
  ) {
    userSocketsManager
      .on('newUser', userSockets => {
        this.handleNewUser(userSockets).catch(err =>
          logger.error({ err }, 'Error handling new user in whisper service'),
        )
      })
      .on('userQuit', userId => {
        this.handleUserQuit(userId).catch(err =>
          logger.error({ err }, 'Error handling user disconnect in whisper service'),
        )
      })
  }

  async getWhisperSessions(userId: SbUserId): Promise<SbUser[]> {
    return await getWhisperSessionsForUser(userId)
  }

  async startWhisperSession(userId: SbUserId, targetUser: SbUserId) {
    if (userId === targetUser) {
      throw new WhisperServiceError(
        WhisperServiceErrorCode.NoSelfMessaging,
        "Can't whisper with yourself",
      )
    }

    const [user, target] = await Promise.all([
      this.getUserById(userId),
      this.getUserById(targetUser),
    ])

    await this.ensureWhisperSession(user, target)
  }

  async closeWhisperSession(userId: SbUserId, targetUser: SbUserId): Promise<boolean> {
    if (!this.userSessions.get(userId)?.has(targetUser)) {
      return false
    }

    await dbCloseWhisperSession(userId, targetUser)
    this.userSessions = this.userSessions.update(userId, s => s!.delete(targetUser))

    const updated = this.sessionUsers.get(targetUser)!.delete(userId)
    this.sessionUsers = updated.size
      ? this.sessionUsers.set(targetUser, updated)
      : this.sessionUsers.delete(targetUser)

    this.publisher.publish(getSessionPath(userId, targetUser), {
      action: 'closeSession',
      target: targetUser,
    })
    this.unsubscribeUserFromWhisperSession(userId, targetUser)

    return true
  }

  async sendWhisperMessage(userId: SbUserId, targetUser: SbUserId, message: string) {
    if (userId === targetUser) {
      throw new WhisperServiceError(
        WhisperServiceErrorCode.NoSelfMessaging,
        "Can't whisper with yourself",
      )
    }

    const [user, target] = await Promise.all([
      this.getUserById(userId),
      this.getUserById(targetUser),
    ])

    const text = filterChatMessage(message)
    const [processedText, userMentions, channelMentions] = await processMessageContents(text)
    const mentionedUserIds = userMentions.map(u => u.id)
    const mentionedChannelIds = channelMentions.map(c => c.id)
    const result = await addMessageToWhisper(user.id, target.id, {
      type: WhisperMessageType.TextMessage,
      text: processedText,
      mentions: mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
      channelMentions: mentionedChannelIds.length > 0 ? mentionedChannelIds : undefined,
    })

    // TODO(tec27): This makes the start throttle rather useless, doesn't it? Think of a better way
    // to throttle people starting tons of tons of sessions with different people
    await Promise.all([
      this.ensureWhisperSession(user, target),
      this.ensureWhisperSession(target, user),
    ])

    this.publisher.publish(getSessionPath(userId, targetUser), {
      action: 'message',
      message: {
        id: result.id,
        type: result.data.type,
        from: result.from,
        to: result.to,
        time: Number(result.sent),
        text: result.data.text,
      },
      users: [user, target],
      mentions: userMentions,
      channelMentions: channelMentions.map(c => toBasicChannelInfo(c)),
    })
  }

  async getSessionHistory(
    userId: SbUserId,
    targetUser: SbUserId,
    limit?: number,
    beforeTime?: number,
  ): Promise<GetSessionHistoryResponse> {
    const [user, target] = await Promise.all([
      this.getUserById(userId),
      this.getUserById(targetUser),
    ])

    if (!this.userSessions.get(user.id)?.has(target.id)) {
      throw new WhisperServiceError(
        WhisperServiceErrorCode.InvalidGetSessionHistoryAction,
        'Must have a whisper session with this user to retrieve message history',
      )
    }

    const dbMessages = await getMessagesForWhisperSession(
      user.id,
      target.id,
      limit,
      beforeTime && beforeTime > -1 ? new Date(beforeTime) : undefined,
    )

    const messages: WhisperMessage[] = []
    const userMentionIds = new Set<SbUserId>()
    const channelMentionIds = new Set<SbChannelId>()

    for (const msg of dbMessages) {
      switch (msg.data.type) {
        case WhisperMessageType.TextMessage:
          messages.push({
            id: msg.id,
            type: msg.data.type,
            from: msg.from,
            to: msg.to,
            time: Number(msg.sent),
            text: msg.data.text,
          })
          for (const mention of msg.data.mentions ?? []) {
            userMentionIds.add(mention)
          }
          for (const mention of msg.data.channelMentions ?? []) {
            channelMentionIds.add(mention)
          }
          break

        default:
          return assertUnreachable(msg.data.type)
      }
    }

    const [userMentions, channelMentions] = await Promise.all([
      findUsersById(Array.from(userMentionIds)),
      getChannelInfos(Array.from(channelMentionIds)),
    ])

    const deletedChannels =
      channelMentionIds.size === channelMentions.length
        ? []
        : Array.from(
            subtract(
              channelMentionIds,
              channelMentions.map(c => c.id),
            ),
          )

    return {
      messages,
      users: [user, target],
      mentions: userMentions,
      channelMentions: channelMentions.map(c => toBasicChannelInfo(c)),
      deletedChannels,
    }
  }

  async getUserById(id: SbUserId): Promise<SbUser> {
    const foundUser = await findUserById(id)
    if (!foundUser) {
      throw new WhisperServiceError(WhisperServiceErrorCode.UserNotFound, 'User not found')
    }

    return foundUser
  }

  unsubscribeUserFromWhisperSession(userId: SbUserId, targetUser: SbUserId) {
    const userSockets = this.userSocketsManager.getById(userId)
    userSockets?.unsubscribe(getSessionPath(userId, targetUser))
  }

  private async ensureWhisperSession(user: SbUser, target: SbUser) {
    await dbStartWhisperSession(user.id, target.id)

    const userSockets = this.userSocketsManager.getById(user.id)
    // If the user is offline, the rest of the code will be done once they connect
    if (!userSockets) {
      return
    }

    // Maintain a list of users for each whisper session, so we can publish events to everyone that
    // has a session opened with a particular user
    this.sessionUsers = this.sessionUsers.update(target.id, ISet(), s => s.add(user.id))

    if (!this.userSessions.get(user.id)?.has(target.id)) {
      this.userSessions = this.userSessions.update(user.id, OrderedSet(), s => s.add(target.id))
      userSockets.subscribe<WhisperSessionInitEvent>(
        getSessionPath(userSockets.userId, target.id),
        () => ({
          action: 'initSession2',
          target,
        }),
      )
    }
  }

  private async handleNewUser(userSockets: UserSocketsGroup) {
    const whisperSessions = await getWhisperSessionsForUser(userSockets.userId)
    if (!userSockets.sockets.size) {
      // The user disconnected while we were waiting for their whisper sessions
      return
    }

    const targetIdsSet = OrderedSet(whisperSessions.map(s => s.id))
    this.userSessions = this.userSessions.set(userSockets.userId, targetIdsSet)
    for (const session of whisperSessions) {
      // Add the new user to all of the sessions they have opened
      this.sessionUsers = this.sessionUsers.update(session.id, ISet(), s =>
        s.add(userSockets.userId),
      )
      userSockets.subscribe(getSessionPath(userSockets.userId, session.id))
    }
  }

  private async handleUserQuit(userId: SbUserId) {
    const user = await this.getUserById(userId)

    if (!this.userSessions.has(user.id)) {
      // This can happen if a user disconnects before we get their whisper sessions back from the DB
      return
    }

    // Delete the user that quit from all of the sessions they had opened, if any
    for (const target of this.userSessions.get(user.id)!.values()) {
      const updated = this.sessionUsers.get(target)?.delete(user.id)
      this.sessionUsers = updated?.size
        ? this.sessionUsers.set(target, updated)
        : this.sessionUsers.delete(target)
    }
    this.userSessions = this.userSessions.delete(user.id)
  }
}
