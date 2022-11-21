import cuid from 'cuid'
import { Immutable } from 'immer'
import { container, delay, inject, instanceCachingFactory, singleton } from 'tsyringe'
import { isAbortError, raceAbort } from '../../../common/async/abort-signals'
import { createDeferred, Deferred } from '../../../common/async/deferred'
import swallowNonBuiltins from '../../../common/async/swallow-non-builtins'
import {
  MatchmakingPreferences,
  MatchmakingServiceErrorCode,
  MatchmakingType,
  TEAM_SIZES,
} from '../../../common/matchmaking'
import { NotificationType } from '../../../common/notifications'
import {
  MAX_PARTY_SIZE,
  PartyEvent,
  PartyInitEvent,
  PartyJson,
  PartyQueueCancelReason,
  PartyServiceErrorCode,
} from '../../../common/parties'
import { RaceChar } from '../../../common/races'
import { SbUser, SbUserId } from '../../../common/users/sb-user'
import { toBasicChannelInfo } from '../chat/chat-models'
import { CodedError } from '../errors/coded-error'
import { GameplayActivityRegistry } from '../games/gameplay-activity-registry'
import logger from '../logging/logger'
import { MatchmakingService } from '../matchmaking/matchmaking-service'
import { MatchmakingServiceError } from '../matchmaking/matchmaking-service-error'
import filterChatMessage from '../messaging/filter-chat-message'
import { processMessageContents } from '../messaging/process-chat-message'
import NotificationService from '../notifications/notification-service'
import { Clock } from '../time/clock'
import { ClientIdentifierString } from '../users/client-ids'
import { findUsersByIdAsMap } from '../users/user-model'
import { UserRelationshipService } from '../users/user-relationship-service'
import { ClientSocketsGroup, ClientSocketsManager } from '../websockets/socket-groups'
import { TypedPublisher } from '../websockets/typed-publisher'
import { InPartyChecker, IN_PARTY_CHECKER } from './in-party-checker'

export interface PartyRecord {
  id: string
  invites: Set<SbUserId>
  members: Set<SbUserId>
  leader: SbUserId

  partyQueueRequest?: PartyQueueRequest
}

export class PartyServiceError extends CodedError<PartyServiceErrorCode> {}

export function getPartyPath(partyId: string): string {
  return `/parties/${partyId}`
}

export function toPartyJson(party: PartyRecord): PartyJson {
  return {
    id: party.id,
    invites: Array.from(party.invites.values()),
    members: Array.from(party.members.values()),
    leader: party.leader,
  }
}

export interface PartyAcceptData {
  race: RaceChar
  identifiers: ReadonlyArray<ClientIdentifierString>
}

/**
 * Tracks the current state of a party matchmaking queue request and exposes a way to wait for
 * any changes to that state.
 */
export class PartyQueueRequest {
  readonly id = cuid()
  private acceptPromises = new Map<SbUserId, Deferred<void>>()
  private acceptData = new Map<SbUserId, PartyAcceptData>()
  private abortController = new AbortController()
  private cancelReason?: PartyQueueCancelReason

  constructor(
    readonly matchmakingType: MatchmakingType,
    readonly members: ReadonlyArray<SbUserId>,
  ) {
    for (const member of members) {
      this.acceptPromises.set(member, createDeferred())
    }
  }

  untilAcceptStateChanged(): Promise<void> {
    return raceAbort(
      this.abortController.signal,
      Promise.race(Array.from(this.acceptPromises.values())),
    )
  }

  getUnacceptedMembers(): SbUserId[] {
    return Array.from(this.acceptPromises.keys())
  }

  registerAccept(
    userId: SbUserId,
    race: RaceChar,
    identifiers: ReadonlyArray<ClientIdentifierString>,
  ) {
    this.acceptPromises.get(userId)?.resolve()
    this.acceptPromises.delete(userId)
    this.acceptData.set(userId, { race, identifiers: [...identifiers] })
  }

  abort(reason: PartyQueueCancelReason) {
    this.abortController.abort()
    if (!this.cancelReason) {
      this.cancelReason = reason
    }
  }

  getAcceptData(): Readonly<Map<SbUserId, PartyAcceptData>> {
    return this.acceptData
  }

  getCancelReason(): PartyQueueCancelReason | undefined {
    return this.cancelReason
  }
}

@singleton()
export default class PartyService implements InPartyChecker {
  /**
   * Maps party ID -> record representing that party. Party is created as soon as someone is invited
   * and removed once the last person in a party leaves.
   */
  private parties = new Map<string, PartyRecord>()
  /** Maps client sockets group -> party ID. Only one client sockets group can be in a party. */
  private clientSocketsToPartyId = new Map<ClientSocketsGroup, string>()
  /** Maps user ID -> client ID. The client ID is the one that user used to join the party. */
  private userIdToClientId = new Map<SbUserId, string>()

  constructor(
    private publisher: TypedPublisher<PartyEvent>,
    private clientSocketsManager: ClientSocketsManager,
    private notificationService: NotificationService,
    private clock: Clock,
    private gameplayActivityRegistry: GameplayActivityRegistry,
    @inject(delay(() => MatchmakingService)) private matchmakingService: MatchmakingService,
    private userRelationshipService: UserRelationshipService,
  ) {}

  isInParty(userId: SbUserId): boolean {
    return this.userIdToClientId.has(userId)
  }

  /**
   * Invites a user to the party. If a person who is inviting someone else is not already in a
   * party, a new party is created and they're made its leader. Note that this should be treated
   * more as an "allow user to join a party" action, which means that we're not checking if someone
   * is already invited. So inviting someone multiple times should work without a problem. The
   * invite notification is only sent if there are no currently visible notifications for the
   * invited user already though.
   */
  async invite(
    leader: SbUserId,
    leaderClientId: string,
    invitedUser: SbUser,
  ): Promise<PartyRecord> {
    const leaderClientSockets = this.getClientSockets(leader, leaderClientId)

    if (invitedUser.id === leader) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidSelfAction,
        "Can't invite yourself to the party",
      )
    }

    const isBlocked = await this.userRelationshipService.isUserBlockedBy(leader, invitedUser.id)
    if (isBlocked) {
      throw new PartyServiceError(PartyServiceErrorCode.Blocked, 'This user has blocked you')
    }

    let party = this.getClientParty(leaderClientSockets)
    if (party) {
      if (party.leader !== leader) {
        throw new PartyServiceError(
          PartyServiceErrorCode.InsufficientPermissions,
          'Only party leader can invite people',
        )
      }

      if (party.members.has(invitedUser.id)) {
        throw new PartyServiceError(
          PartyServiceErrorCode.AlreadyMember,
          'This user is already a member of this party',
          { data: { user: invitedUser } },
        )
      }

      // An invite might already exist for a user, but we don't treat that as an error as that would
      // reveal to the inviter that the person has declined their first invite, which should be
      // treated as private information.

      party.invites.add(invitedUser.id)
      this.publisher.publish(getPartyPath(party.id), {
        type: 'invite',
        invitedUser: invitedUser.id,
        time: this.clock.now(),
        userInfo: invitedUser,
      })
    } else {
      const partyId = cuid()
      party = {
        id: partyId,
        invites: new Set([invitedUser.id]),
        members: new Set([leader]),
        leader,
      }

      this.parties.set(partyId, party)
      this.clientSocketsToPartyId.set(leaderClientSockets, partyId)
      this.subscribeToParty(leaderClientSockets, party)
    }

    await this.maybeSendInviteNotification(party, invitedUser.id)

    return party
  }

  /**
   * Declines a party invitation for a particular user. Declining a party invitation just clears the
   * notification for the user and doesn't actually notify the party members that the user has
   * declined. Furthermore, declining an invite doesn't prevent the user from joining the party at
   * a later time, even if currently it's not possible to perform such action through UI.
   */
  async decline(partyId: string, target: SbUserId): Promise<void> {
    await this.clearInviteNotification(partyId, target)
  }

  /**
   * Removes a party invitation for a particular user. Removing a party invitation can only be done
   * by a party leader, and basically removes the user from the "allowed to join" list. Also, the
   * invite notification is cleared for the invited user, so if they got uninvited before they even
   * saw the invite notification they'll be none the wiser!
   */
  async removeInvite(partyId: string, removingUser: SbUserId, target: SbUserId): Promise<void> {
    await this.clearInviteNotification(partyId, target)

    const party = this.parties.get(partyId)
    if (!party || !party.members.has(removingUser)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }

    if (removingUser !== party.leader) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InsufficientPermissions,
        'Only party leaders can remove invites to other people',
      )
    }

    if (!party.invites.has(target)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidAction,
        "Can't remove invite for a user that wasn't invited",
      )
    }

    party.invites.delete(target)
    this.publisher.publish(getPartyPath(party.id), {
      type: 'uninvite',
      target,
      time: this.clock.now(),
    })
  }

  /**
   * Accepts a party invitation for a particular user. Accepting a party invite removes the user
   * from the "allow to join" list, which means they will have to be reinvited if they leave the
   * party. Also, it's possible to accept an invite to a party while already being in a different
   * party. In that case, the user will leave the old party and be transferred to a new party.
   */
  async acceptInvite(partyId: string, user: SbUser, clientId: string): Promise<void> {
    await this.clearInviteNotification(partyId, user.id)

    const party = this.parties.get(partyId)
    if (!party || !party.invites.has(user.id)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInvited,
        "Party not found or you're not invited to it",
      )
    }

    if (party.members.size >= MAX_PARTY_SIZE) {
      throw new PartyServiceError(PartyServiceErrorCode.PartyFull, 'Party is full')
    }

    const clientSockets = this.getClientSockets(user.id, clientId)
    if (clientSockets.clientType !== 'electron') {
      throw new PartyServiceError(PartyServiceErrorCode.InvalidAction, 'Invalid client')
    }

    const oldParty = this.getClientParty(clientSockets)

    // TODO(2Pac): Maybe display a confirmation dialog first to the user if they were already in an
    // existing party, instead of unconditionally moving them to a new party?

    party.invites.delete(user.id)
    party.members.add(user.id)
    this.clientSocketsToPartyId.set(clientSockets, partyId)

    this.publisher.publish(getPartyPath(party.id), {
      type: 'join',
      user: user.id,
      userInfo: user,
      time: this.clock.now(),
    })
    this.subscribeToParty(clientSockets, party)

    if (oldParty) {
      // NOTE(2Pac): We're removing the user from an old party *after* we subscribe them to a new
      // one, to better represent a party change. This way the client won't have a brief period of
      // being in no party, which can change the UI in unexpected ways.
      this.removeClientFromParty(clientSockets, oldParty)
    }
  }

  /**
   * Leaves the party for a particular user. If the leaving player was a party leader, a new leader
   * will be selected. And if the leaving player was the last member of the party, the party will be
   * destroyed.
   */
  leaveParty(partyId: string, userId: SbUserId, clientId: string): void {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(userId)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }

    const clientSockets = this.getClientSockets(userId, clientId)
    this.removeClientFromParty(clientSockets, party)
  }

  /**
   * Sends a chat message in the party from a particular user. The chat messages are not persisted
   * anywhere, and users will only be able to see the messages sent since they joined the party.
   */
  async sendChatMessage(partyId: string, user: SbUser, message: string): Promise<void> {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(user.id)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }

    const text = filterChatMessage(message)
    const [processedText, userMentions, channelMentions] = await processMessageContents(text)

    this.publisher.publish(getPartyPath(partyId), {
      type: 'chatMessage',
      message: {
        partyId,
        user,
        time: this.clock.now(),
        text: processedText,
      },
      mentions: userMentions,
      channelMentions: channelMentions.map(c => toBasicChannelInfo(c)),
    })
  }

  /**
   * Kicks a particular user from a party. Only party leaders can kick other people. Kicked players
   * must be invited again to the party if they wish to rejoin.
   */
  kickPlayer(partyId: string, kickingUser: SbUserId, target: SbUserId): void {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(kickingUser)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }

    if (kickingUser !== party.leader) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InsufficientPermissions,
        'Only party leaders can kick other people',
      )
    }

    if (!party.members.has(target)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidAction,
        "Can't kick player who is not in your party",
      )
    }

    if (kickingUser === target) {
      throw new PartyServiceError(PartyServiceErrorCode.InvalidSelfAction, "Can't kick yourself")
    }

    this.publisher.publish(getPartyPath(party.id), {
      type: 'kick',
      target,
      time: this.clock.now(),
    })

    const clientId = this.userIdToClientId.get(target)!
    const clientSockets = this.getClientSockets(target, clientId)
    this.removeClientFromParty(clientSockets, party)
  }

  /**
   * Changes the party leader. Only the current party leader can initiate the change. This is the
   * same action that happens automatically when a current party leader leaves the party.
   */
  changeLeader(partyId: string, oldLeader: SbUserId, newLeader: SbUserId): void {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(oldLeader)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }

    if (oldLeader !== party.leader) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InsufficientPermissions,
        'Only party leaders can change leaders',
      )
    }

    if (!party.members.has(newLeader)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidAction,
        'Only party members can be made leader',
      )
    }

    if (oldLeader === newLeader) {
      throw new PartyServiceError(PartyServiceErrorCode.InvalidAction, "You're already a leader")
    }

    party.leader = newLeader
    this.publisher.publish(getPartyPath(party.id), {
      type: 'leaderChange',
      leader: newLeader,
      time: this.clock.now(),
    })
  }

  async findMatch(
    partyId: string,
    fromUser: SbUserId,
    fromUserIdentifiers: ReadonlyArray<ClientIdentifierString>,
    preferences: Immutable<MatchmakingPreferences>,
  ): Promise<void> {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(fromUser)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }

    if (fromUser !== party.leader) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InsufficientPermissions,
        'Only party leaders can queue for matchmaking',
      )
    }

    if (
      party.partyQueueRequest &&
      party.partyQueueRequest.matchmakingType !== preferences.matchmakingType
    ) {
      throw new PartyServiceError(
        PartyServiceErrorCode.AlreadyInGameplayActivity,
        'Party is already in the process of queueing for a different matchmaking type',
      )
    } else if (party.partyQueueRequest) {
      // Party is already queuing, just no-op this request
      return
    }

    if (party.members.size > TEAM_SIZES[preferences.matchmakingType]) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidAction,
        'Party is too large for that matchmaking type',
      )
    }

    const [registered, alreadyActive] = this.gameplayActivityRegistry.registerAll(
      Array.from(party.members.values(), userId => [
        userId,
        this.getClientSockets(userId, this.userIdToClientId.get(userId)!),
      ]),
    )
    if (!registered) {
      throw new PartyServiceError(
        PartyServiceErrorCode.AlreadyInGameplayActivity,
        'One or more player is already in a gameplay activity',
        { data: { users: alreadyActive } },
      )
    }

    // Copy these values out in case the caller changes the preferences object afterwards for
    // some reason
    const { race: leaderRace, matchmakingType, mapSelections, data: preferenceData } = preferences

    const { leader } = party
    party.partyQueueRequest = new PartyQueueRequest(
      matchmakingType,
      Array.from(party.members.values()),
    )

    Promise.resolve()
      .then(async () => {
        const { partyQueueRequest } = party
        if (!partyQueueRequest) {
          // This shouldn't generally happen, but if they canceled the matchmaking request
          // immediately then maybe?
          return
        }

        partyQueueRequest.registerAccept(fromUser, leaderRace, fromUserIdentifiers)

        try {
          while (partyQueueRequest.getUnacceptedMembers().length) {
            this.publisher.publish(getPartyPath(party.id), {
              type: 'queue',
              id: partyQueueRequest.id,
              matchmakingType: partyQueueRequest.matchmakingType,
              accepted: Array.from(
                partyQueueRequest.getAcceptData().entries(),
                ([userId, data]) => [userId, data.race],
              ),
              unaccepted: partyQueueRequest.getUnacceptedMembers(),
              time: this.clock.now(),
            })

            await partyQueueRequest.untilAcceptStateChanged()
          }

          const queuedMembers = Array.from(partyQueueRequest.getAcceptData().entries())

          try {
            const matchmakingUsers = new Map(
              queuedMembers.map(([userId, data]) => [
                userId,
                {
                  race: data.race,
                  clientId: this.userIdToClientId.get(userId)!,
                  identifiers: data.identifiers,
                },
              ]),
            )
            await this.matchmakingService.findAsParty({
              type: matchmakingType,
              users: matchmakingUsers,
              partyId,
              leaderId: leader,
              leaderPreferences: {
                mapSelections,
                preferenceData,
              },
            })
            this.publisher.publish(getPartyPath(party.id), {
              type: 'queueReady',
              id: partyQueueRequest.id,
              queuedMembers: queuedMembers.map(([userId, data]) => [userId, data.race]),
              time: this.clock.now(),
            })
          } catch (err: any) {
            if (!(err instanceof MatchmakingServiceError)) {
              throw err
            }

            if (err.code === MatchmakingServiceErrorCode.MatchmakingDisabled) {
              partyQueueRequest.abort({ type: 'matchmakingDisabled' })
            } else {
              logger.error(
                { err },
                `Unhandled matchmaking error code when finding a match as a party: ${err.code}`,
              )
              partyQueueRequest.abort({ type: 'error' })
            }

            // Trigger the AbortError to be thrown
            await partyQueueRequest.untilAcceptStateChanged()
          }
        } catch (err: any) {
          if (!isAbortError(err)) {
            logger.error({ err }, 'error while processing party queue request')
          }

          for (const userId of partyQueueRequest.members) {
            this.gameplayActivityRegistry.unregisterClientForUser(userId)
          }

          this.publisher.publish(getPartyPath(party.id), {
            type: 'queueCancel',
            id: partyQueueRequest.id,
            reason: partyQueueRequest.getCancelReason() ?? { type: 'error' },
            time: this.clock.now(),
          })
        } finally {
          party.partyQueueRequest = undefined
        }
      })
      .catch(swallowNonBuiltins)
  }

  acceptFindMatch(
    partyId: string,
    queueId: string,
    fromUser: SbUserId,
    fromUserIdentifiers: ReadonlyArray<ClientIdentifierString>,
    race: RaceChar,
  ): void {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(fromUser)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }
    if (
      party.partyQueueRequest?.id !== queueId ||
      !party.partyQueueRequest.members.includes(fromUser)
    ) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidAction,
        'Party is not currently queueing for a match',
      )
    }

    party.partyQueueRequest.registerAccept(fromUser, race, fromUserIdentifiers)
  }

  rejectFindMatch(partyId: string, queueId: string, fromUser: SbUserId): void {
    const party = this.parties.get(partyId)
    if (!party || !party.members.has(fromUser)) {
      throw new PartyServiceError(
        PartyServiceErrorCode.NotFoundOrNotInParty,
        "Party not found or you're not in it",
      )
    }
    if (
      party.partyQueueRequest?.id !== queueId ||
      !party.partyQueueRequest.members.includes(fromUser)
    ) {
      throw new PartyServiceError(
        PartyServiceErrorCode.InvalidAction,
        'Party is not currently queueing for a match',
      )
    }

    party.partyQueueRequest.abort({ type: 'rejected', user: fromUser })
  }

  private async maybeSendInviteNotification(party: PartyRecord, user: SbUserId) {
    try {
      const notification = (
        await this.notificationService.retrieveNotifications({
          userId: user,
          data: { type: NotificationType.PartyInvite, partyId: party.id },
          visible: true,
        })
      )[0]

      if (notification) {
        return
      }

      await this.notificationService.addNotification({
        userId: user,
        data: {
          type: NotificationType.PartyInvite,
          from: party.leader,
          partyId: party.id,
        },
      })
    } catch (err) {
      logger.error({ err }, 'error creating the invite notification')
      throw new PartyServiceError(
        PartyServiceErrorCode.NotificationFailure,
        'Error creating the notification',
      )
    }
  }

  private async clearInviteNotification(partyId: string, userId: SbUserId) {
    try {
      const notification = (
        await this.notificationService.retrieveNotifications({
          userId,
          data: { type: NotificationType.PartyInvite, partyId },
          visible: true,
        })
      )[0]

      if (notification) {
        await this.notificationService.clearById(userId, notification.id)
      }
    } catch (err) {
      logger.error({ err }, 'error clearing the invite notification')
    }
  }

  private subscribeToParty(clientSockets: ClientSocketsGroup, party: PartyRecord) {
    this.userIdToClientId.set(clientSockets.userId, clientSockets.clientId)
    clientSockets.subscribe<PartyInitEvent>(
      getPartyPath(party.id),
      async () => ({
        type: 'init',
        party: toPartyJson(party),
        time: this.clock.now(),
        userInfos: Array.from(
          (
            await findUsersByIdAsMap([
              ...Array.from(party.invites.values()),
              ...Array.from(party.members.values()),
            ])
          ).values(),
        ),
      }),
      sockets => this.removeClientFromParty(sockets),
    )
  }

  private removeClientFromParty(
    clientSockets: ClientSocketsGroup,
    party = this.getClientParty(clientSockets),
  ) {
    if (!party) {
      const err = new Error('Party not found')
      logger.error({ err }, 'error while handling client quitting')
      return
    }

    const { userId } = clientSockets
    if (party.members.has(userId)) {
      party.members.delete(userId)
      this.publisher.publish(getPartyPath(party.id), {
        type: 'leave',
        user: userId,
        time: this.clock.now(),
      })
    }

    const clientPartyId = this.clientSocketsToPartyId.get(clientSockets)!
    // Client's party can change when switching parties, so we must check if they're actually
    // leaving the party, or have simply switched to a new one.
    if (clientPartyId === party.id) {
      this.clientSocketsToPartyId.delete(clientSockets)
      this.userIdToClientId.delete(clientSockets.userId)
    }

    clientSockets.unsubscribe(getPartyPath(party.id))

    if (party.partyQueueRequest?.members.includes(userId)) {
      party.partyQueueRequest.abort({ type: 'userLeft', user: userId })
    }
    this.matchmakingService.registerPartyLeave(userId, party.id)

    // If the last person in a party leaves, the party is removed. All outstanding invites to this,
    // now non-existing party, should fail.
    if (party.members.size < 1) {
      this.parties.delete(party.id)
    } else if (clientSockets.userId === party.leader) {
      // If the leader has left the party, we assign a new leader, generally the person who has
      // joined the party the earliest. However, there is no robust solution implemented to ensure
      // that the earliest member becomes a new leader, since the order in which the users accept
      // their invites is pretty arbitrary already.
      const newLeader = party.members.values().next().value
      party.leader = newLeader
      this.publisher.publish(getPartyPath(party.id), {
        type: 'leaderChange',
        leader: newLeader,
        time: this.clock.now(),
      })
    }
  }

  private getClientSockets(userId: SbUserId, clientId: string): ClientSocketsGroup {
    const clientSockets = this.clientSocketsManager.getById(userId, clientId)
    if (!clientSockets) {
      throw new PartyServiceError(PartyServiceErrorCode.UserOffline, 'Client could not be found')
    }

    return clientSockets
  }

  private getClientParty(clientSockets: ClientSocketsGroup): PartyRecord | undefined {
    const partyId = this.clientSocketsToPartyId.get(clientSockets)
    return this.parties.get(partyId as string)
  }
}

container.register(IN_PARTY_CHECKER, {
  // NOTE(tec27): We have to use a factory here instead of useClass, because otherwise it resolves
  // to a different instance of the class, rather than using the constructed singleton
  useFactory: instanceCachingFactory<InPartyChecker>(c => c.resolve(PartyService)),
})
