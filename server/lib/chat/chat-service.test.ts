import { NydusServer } from 'nydus'
import createDeferred from '../../../common/async/deferred'
import {
  BasicChannelInfo,
  ChannelModerationAction,
  ChannelPermissions,
  ChannelPreferences,
  DetailedChannelInfo,
  GetChannelHistoryServerResponse,
  JoinedChannelInfo,
  makeSbChannelId,
  SbChannelId,
  ServerChatMessageType,
} from '../../../common/chat'
import * as flags from '../../../common/flags'
import { asMockedFunction } from '../../../common/testing/mocks'
import { DEFAULT_PERMISSIONS } from '../../../common/users/permissions'
import { makeSbUserId, SbUser, SbUserId } from '../../../common/users/sb-user'
import { DbClient } from '../db'
import { ImageService } from '../images/image-service'
import { getPermissions } from '../models/permissions'
import { MIN_IDENTIFIER_MATCHES } from '../users/client-ids'
import { RequestSessionLookup } from '../websockets/session-lookup'
import { UserSocketsManager } from '../websockets/socket-groups'
import {
  clearTestLogs,
  createFakeNydusServer,
  InspectableNydusClient,
  NydusConnector,
} from '../websockets/testing/websockets'
import { TypedPublisher } from '../websockets/typed-publisher'
import {
  addMessageToChannel,
  addUserToChannel,
  banAllIdentifiersFromChannel,
  banUserFromChannel,
  ChatMessage,
  countBannedIdentifiersForChannel,
  createChannel,
  deleteChannelMessage,
  findChannelByName,
  findChannelsByName,
  FullChannelInfo,
  getChannelInfo,
  getChannelInfos,
  getChannelsForUser,
  getMessagesForChannel,
  getUserChannelEntriesForUser,
  getUserChannelEntryForUser,
  getUsersForChannel,
  isUserBannedFromChannel,
  JoinChannelData,
  removeUserFromChannel,
  searchChannels,
  TextMessageData,
  toBasicChannelInfo,
  updateChannel,
  updateUserPermissions,
  updateUserPreferences,
  UserChannelEntry,
} from './chat-models'
import ChatService, { getChannelPath, getChannelUserPath } from './chat-service'

const flagsMock = flags as { CAN_LEAVE_SHIELDBATTERY_CHANNEL: boolean }

jest.mock('../../../common/flags', () => ({
  __esModule: true,
  CAN_LEAVE_SHIELDBATTERY_CHANNEL: false,
}))

// NOTE(2Pac): We don't bother mocking this since all the DB methods are mocked already and we're
// not doing anything special with this in chat service except pass it as an argument to the model
// methods.
const dbClient = {} as DbClient

jest.mock('../db/transaction', () =>
  jest.fn(async next => {
    return await next(dbClient)
  }),
)

jest.mock('../models/permissions')
jest.mock('../users/user-identifiers')

const user1: SbUser = { id: 1 as SbUserId, name: 'USER_NAME_1' }
const user2: SbUser = { id: 2 as SbUserId, name: 'USER_NAME_2' }

jest.mock('../users/user-model', () => {
  const USERS_BY_ID: ReadonlyMap<SbUserId, SbUser> = new Map([user1, user2].map(u => [u.id, u]))
  const USERS_BY_NAME: ReadonlyMap<string, SbUser> = new Map(
    [user1, user2].map(u => [u.name.toLowerCase(), u]),
  )

  return {
    findUserById: jest.fn().mockImplementation(async (id: SbUserId) => USERS_BY_ID.get(id)),
    findUsersById: jest.fn().mockImplementation(async (ids: ReadonlyArray<SbUserId>) => {
      return ids.map(id => USERS_BY_ID.get(id)).filter(u => !!u)
    }),
    findUsersByName: jest.fn().mockImplementation(async (names: ReadonlyArray<string>) => {
      return names.map(name => USERS_BY_NAME.get(name.toLowerCase())).filter(u => !!u)
    }),
  }
})

jest.mock('./chat-models', () => {
  const originalModule = jest.requireActual('./chat-models')
  return {
    getChannelsForUser: jest.fn().mockResolvedValue([]),
    getUsersForChannel: jest.fn().mockResolvedValue([]),
    getUserChannelEntryForUser: jest.fn(),
    getUserChannelEntriesForUser: jest.fn().mockResolvedValue([]),
    createChannel: jest.fn(),
    updateChannel: jest.fn(),
    addUserToChannel: jest.fn(),
    addMessageToChannel: jest.fn(),
    getMessagesForChannel: jest.fn().mockResolvedValue([]),
    deleteChannelMessage: jest.fn(),
    removeUserFromChannel: jest.fn(),
    updateUserPreferences: jest.fn(),
    updateUserPermissions: jest.fn(),
    countBannedIdentifiersForChannel: jest.fn(),
    banUserFromChannel: jest.fn(),
    banAllIdentifiersFromChannel: jest.fn(),
    isUserBannedFromChannel: jest.fn(),
    getChannelInfo: jest.fn(),
    getChannelInfos: jest.fn().mockResolvedValue([]),
    findChannelByName: jest.fn(),
    findChannelsByName: jest.fn().mockResolvedValue([]),
    searchChannels: jest.fn().mockResolvedValue([]),
    toBasicChannelInfo: originalModule.toBasicChannelInfo,
    toDetailedChannelInfo: originalModule.toDetailedChannelInfo,
    toJoinedChannelInfo: originalModule.toJoinedChannelInfo,
  }
})

type FakeDbJoinChannelMessage = ChatMessage & { data: JoinChannelData }
type FakeDbTextChannelMessage = ChatMessage & { data: TextMessageData }

/**
 * A helper method that returns a JSON version of the "JoinChannel" database message.
 */
function toJoinChannelMessageJson(dbMessage: FakeDbJoinChannelMessage) {
  return {
    id: dbMessage.msgId,
    type: dbMessage.data.type,
    channelId: dbMessage.channelId,
    userId: dbMessage.userId,
    time: Number(dbMessage.sent),
  }
}
/**
 * A helper method that returns a JSON version of the "Text" database message.
 */
function toTextMessageJson(dbMessage: FakeDbTextChannelMessage) {
  return {
    id: dbMessage.msgId,
    type: dbMessage.data.type,
    channelId: dbMessage.channelId,
    from: dbMessage.userId,
    time: Number(dbMessage.sent),
    text: dbMessage.data.text,
  }
}

describe('chat/chat-service', () => {
  let nydus: NydusServer
  let chatService: ChatService
  let connector: NydusConnector

  const shieldBatteryBasicInfo: BasicChannelInfo = {
    id: makeSbChannelId(1),
    name: 'ShieldBattery',
    private: false,
    official: true,
  }
  const shieldBatteryDetailedInfo: DetailedChannelInfo = {
    id: makeSbChannelId(1),
    description: 'SHIELDBATTERY_DESCRIPTION',
    userCount: 5,
  }
  const shieldBatteryJoinedInfo: JoinedChannelInfo = {
    id: makeSbChannelId(1),
    ownerId: undefined,
    topic: 'SHIELDBATTERY_TOPIC',
  }
  const shieldBatteryChannel: FullChannelInfo = {
    ...shieldBatteryBasicInfo,
    ...shieldBatteryDetailedInfo,
    ...shieldBatteryJoinedInfo,
  }
  const testBasicInfo: BasicChannelInfo = {
    id: makeSbChannelId(2),
    name: 'test',
    private: false,
    official: false,
  }
  const testDetailedInfo: DetailedChannelInfo = {
    id: makeSbChannelId(2),
    description: 'TEST_DESCRIPTION',
    userCount: 2,
  }
  const testJoinedInfo: JoinedChannelInfo = {
    id: makeSbChannelId(2),
    ownerId: undefined,
    topic: 'TEST_TOPIC',
  }
  const testChannel: FullChannelInfo = {
    ...testBasicInfo,
    ...testDetailedInfo,
    ...testJoinedInfo,
  }

  const userPermissions = { ...DEFAULT_PERMISSIONS }
  const channelPreferences: ChannelPreferences = {
    hideBanner: false,
  }
  const channelPermissions: ChannelPermissions = {
    kick: false,
    ban: false,
    changeTopic: false,
    togglePrivate: false,
    editPermissions: false,
  }
  const user1ShieldBatteryChannelEntry: UserChannelEntry = {
    userId: user1.id,
    channelId: shieldBatteryChannel.id,
    joinDate: new Date('2023-03-11T00:00:00.000Z'),
    channelPreferences,
    channelPermissions,
  }
  const user1TestChannelEntry: UserChannelEntry = {
    userId: user1.id,
    channelId: testChannel.id,
    joinDate: new Date('2023-03-12T00:00:00.000Z'),
    channelPreferences,
    channelPermissions,
  }
  const user2ShieldBatteryChannelEntry: UserChannelEntry = {
    userId: user2.id,
    channelId: shieldBatteryChannel.id,
    joinDate: new Date('2023-03-11T00:00:00.000Z'),
    channelPreferences,
    channelPermissions,
  }
  const user2TestChannelEntry: UserChannelEntry = {
    userId: user2.id,
    channelId: testChannel.id,
    joinDate: new Date('2023-03-12T00:00:00.000Z'),
    channelPreferences,
    channelPermissions,
  }

  const joinUser1ShieldBatteryChannelMessage: FakeDbJoinChannelMessage = {
    msgId: 'MESSAGE_ID',
    userId: user1.id,
    userName: user1.name,
    channelId: shieldBatteryChannel.id,
    sent: new Date('2023-03-11T00:00:00.000Z'),
    data: {
      type: ServerChatMessageType.JoinChannel,
    },
  }
  const joinUser1TestChannelMessage: FakeDbJoinChannelMessage = {
    msgId: 'MESSAGE_ID',
    userId: user1.id,
    userName: user1.name,
    channelId: testChannel.id,
    sent: new Date('2023-03-11T00:00:00.000Z'),
    data: {
      type: ServerChatMessageType.JoinChannel,
    },
  }
  const joinUser2ShieldBatteryChannelMessage: FakeDbJoinChannelMessage = {
    msgId: 'MESSAGE_ID',
    userId: user2.id,
    userName: user2.name,
    channelId: shieldBatteryChannel.id,
    sent: new Date('2023-03-11T00:00:00.000Z'),
    data: {
      type: ServerChatMessageType.JoinChannel,
    },
  }
  const joinUser2TestChannelMessage: FakeDbJoinChannelMessage = {
    msgId: 'MESSAGE_ID',
    userId: user2.id,
    userName: user2.name,
    channelId: testChannel.id,
    sent: new Date('2023-03-11T00:00:00.000Z'),
    data: {
      type: ServerChatMessageType.JoinChannel,
    },
  }

  /**
   * A helper method that mocks everything correctly to "join" a user to a channel.
   */
  async function joinUserToChannel(
    user: SbUser,
    channel: FullChannelInfo,
    userChannelEntry: UserChannelEntry,
    channelMessage: ChatMessage,
  ) {
    asMockedFunction(findChannelByName).mockResolvedValue(undefined)
    asMockedFunction(createChannel).mockResolvedValue(channel)
    asMockedFunction(addMessageToChannel).mockResolvedValue(channelMessage)
    asMockedFunction(getChannelInfo).mockResolvedValue(channel)

    let isUserInChannel = false
    asMockedFunction(getUserChannelEntryForUser).mockImplementation(
      async (userId: SbUserId, channelId: SbChannelId) => {
        if (!isUserInChannel) {
          return null
        }
        return userChannelEntry
      },
    )
    asMockedFunction(getUserChannelEntriesForUser).mockImplementation(
      async (userId: SbUserId, channelIds: SbChannelId[]) => {
        if (!isUserInChannel) {
          return []
        }
        return [userChannelEntry]
      },
    )

    asMockedFunction(addUserToChannel).mockImplementation(
      async (userId: SbUserId, channelId: SbChannelId) => {
        isUserInChannel = true

        return userChannelEntry
      },
    )

    await chatService.joinChannel(testChannel.name, user.id)
  }

  let textMessage: FakeDbTextChannelMessage
  const addMessageToChannelMock = asMockedFunction(addMessageToChannel)

  /**
   * A helper method that mocks everything needed to send a message to a channel.
   */
  function mockTextMessage(
    user: SbUser,
    channel: FullChannelInfo,
    processedMessageString: string,
    userMentions: SbUser[],
    channelMentions: FullChannelInfo[],
  ) {
    textMessage = {
      msgId: 'MESSAGE_ID',
      userId: user.id,
      userName: user.name,
      channelId: channel.id,
      sent: new Date('2023-03-11T00:00:00.000Z'),
      data: {
        type: ServerChatMessageType.TextMessage,
        text: processedMessageString,
        mentions: userMentions.length > 0 ? userMentions.map(m => m.id) : undefined,
        channelMentions: channelMentions.length > 0 ? channelMentions.map(c => c.id) : undefined,
      },
    }
    // NOTE(2Pac): The `joinUserToChannel` call already mocks the return value of this function,
    // so we use the `mockResolvedValueOnce` method to bump the return value to the top of the
    // call stack.
    addMessageToChannelMock.mockResolvedValueOnce(textMessage)
    asMockedFunction(findChannelsByName).mockResolvedValue(channelMentions)
  }

  /**
   * A helper method which sends a chat message from a `user` to a `channel`, and expects the
   * `client` has not received it. This is used as a test to make sure the users not in a channel
   * don't receive messages for that channel.
   */
  async function expectMessageWasNotReceived(
    user: SbUser,
    channel: FullChannelInfo,
    client: InspectableNydusClient,
  ) {
    mockTextMessage(user, channel, 'Hello World!', [], [])

    await chatService.sendChatMessage(channel.id, user.id, textMessage.data.text)

    expect(client.publish).not.toHaveBeenCalledWith(getChannelPath(channel.id), {
      action: 'message2',
      message: toTextMessageJson(textMessage),
      user,
      mentions: [],
    })
  }

  const USER1_CLIENT_ID = 'USER1_CLIENT_ID'
  const USER2_CLIENT_ID = 'USER2_CLIENT_ID'

  let client1: InspectableNydusClient
  let client2: InspectableNydusClient

  beforeEach(() => {
    nydus = createFakeNydusServer()
    const sessionLookup = new RequestSessionLookup()
    const userSocketsManager = new UserSocketsManager(nydus, sessionLookup, async () => {})
    const publisher = new TypedPublisher(nydus)
    const imageService = new ImageService()

    chatService = new ChatService(publisher, userSocketsManager, imageService)
    connector = new NydusConnector(nydus, sessionLookup)

    client1 = connector.connectClient(user1, USER1_CLIENT_ID)
    client2 = connector.connectClient(user2, USER2_CLIENT_ID)

    jest.clearAllMocks()
    clearTestLogs(nydus)
  })

  describe('handleNewUser', () => {
    test('subscribes user to their joined channels', async () => {
      const user3: SbUser = { id: 3 as SbUserId, name: 'USER_NAME_3' }
      const user3ShieldBatteryChannelEntry = { ...user1ShieldBatteryChannelEntry, userId: user3.id }
      const user3TestChannelEntry = { ...user1TestChannelEntry, userId: user3.id }

      asMockedFunction(getChannelsForUser).mockResolvedValue([
        user3ShieldBatteryChannelEntry,
        user3TestChannelEntry,
      ])
      asMockedFunction(getChannelInfos).mockResolvedValue([shieldBatteryChannel, testChannel])

      const client3 = connector.connectClient(user3, 'USER3_CLIENT_ID')

      // TODO(2Pac): Add something to FakeNydusServer to resolve when all current subscription
      // promises are complete?
      await new Promise(resolve => setTimeout(resolve, 20))

      // NOTE(2Pac): This method is used every time a user connects (so basically before each
      // test), so we restore the mocked return value to what it is by default, so it doesn't
      // impact the tests that run after this one.
      asMockedFunction(getChannelsForUser).mockResolvedValue([])

      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client3,
        getChannelPath(shieldBatteryChannel.id),
        undefined,
      )
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client3,
        getChannelPath(testChannel.id),
        undefined,
      )
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client3,
        getChannelUserPath(shieldBatteryChannel.id, user3.id),
        undefined,
      )
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client3,
        getChannelUserPath(testChannel.id, user3.id),
        undefined,
      )
    })
  })

  describe('getJoinedChannels', () => {
    test('returns joined channels for the user', async () => {
      await joinUserToChannel(
        user1,
        shieldBatteryChannel,
        user1ShieldBatteryChannelEntry,
        joinUser1ShieldBatteryChannelMessage,
      )
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      asMockedFunction(getChannelsForUser).mockResolvedValue([
        user1ShieldBatteryChannelEntry,
        user1TestChannelEntry,
      ])
      asMockedFunction(getChannelInfos).mockResolvedValue([shieldBatteryChannel, testChannel])

      const result = await chatService.getJoinedChannels(user1.id)

      // NOTE(2Pac): This method is used every time a user connects (so basically before each
      // test), so we restore the mocked return value to what it is by default, so it doesn't
      // impact the tests that run after this one.
      asMockedFunction(getChannelsForUser).mockResolvedValue([])

      expect(result).toEqual([
        {
          channelInfo: shieldBatteryBasicInfo,
          detailedChannelInfo: shieldBatteryDetailedInfo,
          joinedChannelInfo: shieldBatteryJoinedInfo,
          activeUserIds: [user1.id],
          selfPreferences: channelPreferences,
          selfPermissions: channelPermissions,
        },
        {
          channelInfo: testBasicInfo,
          detailedChannelInfo: testDetailedInfo,
          joinedChannelInfo: testJoinedInfo,
          activeUserIds: [user1.id],
          selfPreferences: channelPreferences,
          selfPermissions: channelPermissions,
        },
      ])
    })
  })

  describe('joinInitialChannel', () => {
    const addUserToChannelMock = asMockedFunction(addUserToChannel)
    const addMessageToChannelMock = asMockedFunction(addMessageToChannel)

    test("should throw if user doesn't exist", async () => {
      await expect(
        chatService.joinInitialChannel(
          makeSbUserId(Number.MAX_SAFE_INTEGER),
          dbClient,
          Promise.resolve(),
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"User doesn't exist"`)
    })

    test("should throw if channel doesn't exist", async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.joinInitialChannel(user1.id, dbClient, Promise.resolve()),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('works when user exists', async () => {
      // NOTE(2Pac): We pre-join user2 to the channel so we can check it sees correct websocket
      // messages from user1 joining initially.
      await joinUserToChannel(
        user2,
        shieldBatteryChannel,
        user2ShieldBatteryChannelEntry,
        joinUser2ShieldBatteryChannelMessage,
      )

      asMockedFunction(getChannelInfo).mockResolvedValue(shieldBatteryChannel)
      addUserToChannelMock.mockResolvedValue(user1ShieldBatteryChannelEntry)
      addMessageToChannelMock.mockResolvedValue(joinUser1ShieldBatteryChannelMessage)
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user1ShieldBatteryChannelEntry)

      const transactionPromise = createDeferred<void>()

      await chatService.joinInitialChannel(user1.id, dbClient, transactionPromise)

      expect(addUserToChannelMock).toHaveBeenCalledWith(user1.id, shieldBatteryChannel.id, dbClient)
      expect(addMessageToChannelMock).toHaveBeenCalledWith(
        user1.id,
        shieldBatteryChannel.id,
        { type: ServerChatMessageType.JoinChannel },
        dbClient,
      )

      jest.clearAllMocks()

      transactionPromise.resolve()
      await Promise.resolve()

      expect(client2.publish).toHaveBeenCalledWith(getChannelPath(shieldBatteryChannel.id), {
        action: 'join2',
        user: user1,
        message: toJoinChannelMessageJson(joinUser1ShieldBatteryChannelMessage),
      })
      // TODO(2Pac): Add something to FakeNydusServer to resolve when all current subscription
      // promises are complete?
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client1,
        getChannelPath(shieldBatteryChannel.id),
        undefined,
      )
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client1,
        getChannelUserPath(shieldBatteryChannel.id, user1.id),
        undefined,
      )
      expect(client1.publish).toHaveBeenCalledWith(
        getChannelUserPath(shieldBatteryChannel.id, user1.id),
        {
          action: 'init3',
          channelInfo: shieldBatteryBasicInfo,
          detailedChannelInfo: shieldBatteryDetailedInfo,
          joinedChannelInfo: shieldBatteryJoinedInfo,
          activeUserIds: [user2.id, user1.id],
          selfPreferences: channelPreferences,
          selfPermissions: channelPermissions,
        },
      )
    })
  })

  describe('joinChannel', () => {
    const addUserToChannelMock = asMockedFunction(addUserToChannel)
    const addMessageToChannelMock = asMockedFunction(addMessageToChannel)
    const createChannelMock = asMockedFunction(createChannel)

    beforeEach(async () => {
      asMockedFunction(findChannelByName).mockResolvedValue(shieldBatteryChannel)
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)
      asMockedFunction(isUserBannedFromChannel).mockResolvedValue(false)
      asMockedFunction(countBannedIdentifiersForChannel).mockResolvedValue(0)
    })

    test("should throw if user doesn't exist", async () => {
      await expect(
        chatService.joinChannel(shieldBatteryChannel.name, makeSbUserId(Number.MAX_SAFE_INTEGER)),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"User doesn't exist"`)
    })

    test("should throw if can't join anymore channels", async () => {
      addUserToChannelMock.mockResolvedValue(undefined)

      await expect(
        chatService.joinChannel(shieldBatteryChannel.name, user1.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Maximum joined channels reached"`)
    })

    test("should throw if can't own anymore channels", async () => {
      asMockedFunction(findChannelByName).mockResolvedValue(undefined)
      createChannelMock.mockResolvedValue(undefined)

      await expect(
        chatService.joinChannel(shieldBatteryChannel.name, user1.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Maximum owned channels reached"`)
    })

    test('should throw if user is banned', async () => {
      asMockedFunction(isUserBannedFromChannel).mockResolvedValue(true)

      await expect(
        chatService.joinChannel(shieldBatteryChannel.name, user1.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"User is banned"`)
    })

    test('should throw if smurf account is banned', async () => {
      asMockedFunction(countBannedIdentifiersForChannel).mockResolvedValue(
        MIN_IDENTIFIER_MATCHES + 1,
      )

      await expect(
        chatService.joinChannel(shieldBatteryChannel.name, user1.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"User is banned"`)
    })

    test('works when channel already exists', async () => {
      // NOTE(2Pac): We pre-join user2 to the channel so we can check it sees correct websocket
      // messages from user1 joining.
      await joinUserToChannel(
        user2,
        shieldBatteryChannel,
        user2ShieldBatteryChannelEntry,
        joinUser2ShieldBatteryChannelMessage,
      )

      asMockedFunction(findChannelByName).mockResolvedValue(shieldBatteryChannel)
      let isUserInChannel = false
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (!isUserInChannel) {
            return null
          }
          return user1ShieldBatteryChannelEntry
        },
      )
      addUserToChannelMock.mockImplementation(async (userId: SbUserId, channelId: SbChannelId) => {
        isUserInChannel = true
        return user1ShieldBatteryChannelEntry
      })
      addMessageToChannelMock.mockResolvedValue(joinUser1ShieldBatteryChannelMessage)
      asMockedFunction(getChannelInfo).mockResolvedValue(shieldBatteryChannel)

      await chatService.joinChannel(shieldBatteryChannel.name, user1.id)

      expect(addUserToChannelMock).toHaveBeenCalledWith(user1.id, shieldBatteryChannel.id, dbClient)
      expect(addMessageToChannelMock).toHaveBeenCalledWith(
        user1.id,
        shieldBatteryChannel.id,
        { type: ServerChatMessageType.JoinChannel },
        dbClient,
      )
      expect(client2.publish).toHaveBeenCalledWith(getChannelPath(shieldBatteryChannel.id), {
        action: 'join2',
        user: user1,
        message: toJoinChannelMessageJson(joinUser1ShieldBatteryChannelMessage),
      })
      // TODO(2Pac): Add something to FakeNydusServer to resolve when all current subscription
      // promises are complete?
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client1,
        getChannelPath(shieldBatteryChannel.id),
        undefined,
      )
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client1,
        getChannelUserPath(shieldBatteryChannel.id, user1.id),
        undefined,
      )
      expect(client1.publish).toHaveBeenCalledWith(
        getChannelUserPath(shieldBatteryChannel.id, user1.id),
        {
          action: 'init3',
          channelInfo: shieldBatteryBasicInfo,
          detailedChannelInfo: shieldBatteryDetailedInfo,
          joinedChannelInfo: shieldBatteryJoinedInfo,
          activeUserIds: [user2.id, user1.id],
          selfPreferences: channelPreferences,
          selfPermissions: channelPermissions,
        },
      )
    })

    test("creates a new channel when it doesn't exist", async () => {
      asMockedFunction(findChannelByName).mockResolvedValue(undefined)
      createChannelMock.mockResolvedValue(testChannel)
      addUserToChannelMock.mockResolvedValue(user1TestChannelEntry)
      addMessageToChannelMock.mockResolvedValue(joinUser1TestChannelMessage)
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user1TestChannelEntry)
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)

      await chatService.joinChannel(testChannel.name, user1.id)

      expect(createChannelMock).toHaveBeenCalledWith(user1.id, testChannel.name, dbClient)
      expect(addUserToChannelMock).toHaveBeenCalledWith(user1.id, testChannel.id, dbClient)
      expect(addMessageToChannelMock).toHaveBeenCalledWith(
        user1.id,
        testChannel.id,
        { type: ServerChatMessageType.JoinChannel },
        dbClient,
      )

      // NOTE(2Pac): Since there are no users in this channel, we don't bother checking to see if
      // the publish message was sent/received.

      // TODO(2Pac): Add something to FakeNydusServer to resolve when all current subscription
      // promises are complete?
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client1,
        getChannelPath(testChannel.id),
        undefined,
      )
      expect(nydus.subscribeClient).toHaveBeenCalledWith(
        client1,
        getChannelUserPath(testChannel.id, user1.id),
        undefined,
      )
      expect(client1.publish).toHaveBeenCalledWith(getChannelUserPath(testChannel.id, user1.id), {
        action: 'init3',
        channelInfo: testBasicInfo,
        detailedChannelInfo: testDetailedInfo,
        joinedChannelInfo: testJoinedInfo,
        activeUserIds: [user1.id],
        selfPreferences: channelPreferences,
        selfPermissions: channelPermissions,
      })
    })
  })

  describe('editChannel', () => {
    test("should throw if channel doesn't exist", async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.editChannel({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: false,
          updates: {},
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('should throw if not a channel owner or an admin', async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)

      await expect(
        chatService.editChannel({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: false,
          updates: {},
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Only channel owner and admins can edit the channel"`,
      )
    })

    test('works when updating description', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      asMockedFunction(getChannelInfo).mockResolvedValue({
        ...testChannel,
        ownerId: user1.id,
      })

      const updates = {
        description: 'NEW_DESCRIPTION',
      }
      asMockedFunction(updateChannel).mockResolvedValue({
        ...testChannel,
        ...updates,
      })

      const result = await chatService.editChannel({
        channelId: testChannel.id,
        userId: user1.id,
        isAdmin: false,
        updates,
      })

      const channelInfo = {
        channelInfo: testBasicInfo,
        detailedChannelInfo: {
          ...testDetailedInfo,
          description: updates.description,
        },
        joinedChannelInfo: testJoinedInfo,
      }

      expect(client1.publish).toHaveBeenCalledWith(getChannelPath(testChannel.id), {
        action: 'edit',
        ...channelInfo,
      })
      expect(result).toEqual(channelInfo)
    })

    test('works when updating topic', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      asMockedFunction(getChannelInfo).mockResolvedValue({
        ...testChannel,
        ownerId: user1.id,
      })

      const updates = {
        topic: 'NEW_TOPIC',
      }
      asMockedFunction(updateChannel).mockResolvedValue({
        ...testChannel,
        ...updates,
      })

      const result = await chatService.editChannel({
        channelId: testChannel.id,
        userId: user1.id,
        isAdmin: false,
        updates,
      })

      const channelInfo = {
        channelInfo: testBasicInfo,
        detailedChannelInfo: testDetailedInfo,
        joinedChannelInfo: {
          ...testJoinedInfo,
          topic: updates.topic,
        },
      }

      expect(client1.publish).toHaveBeenCalledWith(getChannelPath(testChannel.id), {
        action: 'edit',
        ...channelInfo,
      })
      expect(result).toEqual(channelInfo)
    })
  })

  describe('leaveChannel', () => {
    const removeUserFromChannelMock = asMockedFunction(removeUserFromChannel)

    beforeEach(async () => {
      removeUserFromChannelMock.mockResolvedValue({ newOwnerId: undefined })
    })

    test('should throw if not in channel', async () => {
      await expect(
        chatService.leaveChannel(testChannel.id, user1.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Must be in channel to leave it"`)
    })

    describe('when in ShieldBattery channel', () => {
      beforeEach(async () => {
        await joinUserToChannel(
          user1,
          shieldBatteryChannel,
          user1ShieldBatteryChannelEntry,
          joinUser1ShieldBatteryChannelMessage,
        )
        await joinUserToChannel(
          user2,
          shieldBatteryChannel,
          user2ShieldBatteryChannelEntry,
          joinUser2ShieldBatteryChannelMessage,
        )
      })

      test("should throw if it's not allowed", async () => {
        flagsMock.CAN_LEAVE_SHIELDBATTERY_CHANNEL = false

        await expect(
          chatService.leaveChannel(shieldBatteryChannel.id, user1.id),
        ).rejects.toThrowErrorMatchingInlineSnapshot(`"Can't leave ShieldBattery channel"`)
      })

      test("works when it's allowed", async () => {
        flagsMock.CAN_LEAVE_SHIELDBATTERY_CHANNEL = true

        await chatService.leaveChannel(shieldBatteryChannel.id, user1.id)

        expect(removeUserFromChannelMock).toHaveBeenCalledWith(user1.id, shieldBatteryChannel.id)
        expect(client2.publish).toHaveBeenCalledWith(getChannelPath(shieldBatteryChannel.id), {
          action: 'leave2',
          userId: user1.id,
          newOwnerId: undefined,
        })

        await expectMessageWasNotReceived(user2, shieldBatteryChannel, client1)
        expect(client1.unsubscribe).toHaveBeenCalledWith(
          getChannelUserPath(shieldBatteryChannel.id, user1.id),
        )
      })
    })

    test('works when in non-ShieldBattery channel', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )
      await joinUserToChannel(
        user2,
        testChannel,
        user2TestChannelEntry,
        joinUser2TestChannelMessage,
      )

      await chatService.leaveChannel(testChannel.id, user1.id)

      expect(removeUserFromChannelMock).toHaveBeenCalledWith(user1.id, testChannel.id)
      expect(client2.publish).toHaveBeenCalledWith(getChannelPath(testChannel.id), {
        action: 'leave2',
        userId: user1.id,
        newOwnerId: undefined,
      })

      await expectMessageWasNotReceived(user2, testChannel, client1)
      expect(client1.unsubscribe).toHaveBeenCalledWith(getChannelUserPath(testChannel.id, user1.id))
    })

    // NOTE(2Pac): This test covers a rare bug that happened once when the user tried to leave a
    // channel that didn't exist in state anymore.
    test("works when trying to leave channel that doesn't exist", async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      let mockCalled = false
      asMockedFunction(removeUserFromChannelMock).mockImplementation(async () => {
        if (mockCalled) {
          return { newOwnerId: undefined }
        }

        mockCalled = true
        await chatService.leaveChannel(testChannel.id, user1.id)

        return { newOwnerId: undefined }
      })

      await chatService.leaveChannel(testChannel.id, user1.id)

      expect(client1.unsubscribe).toHaveBeenCalledWith(getChannelUserPath(testChannel.id, user1.id))
    })
  })

  describe('moderateUser', () => {
    const removeUserFromChannelMock = asMockedFunction(removeUserFromChannel)

    beforeEach(async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
      asMockedFunction(getPermissions).mockResolvedValue(userPermissions)
      removeUserFromChannelMock.mockResolvedValue({ newOwnerId: undefined })
    })

    test("should throw if channel doesn't exist", async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.moderateUser(testChannel.id, user1.id, user2.id, ChannelModerationAction.Kick),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('should throw if not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

      await expect(
        chatService.moderateUser(testChannel.id, user1.id, user2.id, ChannelModerationAction.Kick),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Must be in channel to moderate users"`)
    })

    test('should throw if target user not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          }
          return null
        },
      )

      await expect(
        chatService.moderateUser(testChannel.id, user1.id, user2.id, ChannelModerationAction.Kick),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"User must be in channel to moderate them"`)
    })

    test('should throw if moderating yourself', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user1TestChannelEntry)

      await expect(
        chatService.moderateUser(testChannel.id, user1.id, user1.id, ChannelModerationAction.Kick),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Can't moderate yourself"`)
    })

    describe('when moderating ShieldBattery channel', () => {
      beforeEach(async () => {
        await joinUserToChannel(
          user1,
          shieldBatteryChannel,
          user1ShieldBatteryChannelEntry,
          joinUser1ShieldBatteryChannelMessage,
        )
        await joinUserToChannel(
          user2,
          shieldBatteryChannel,
          user2ShieldBatteryChannelEntry,
          joinUser2ShieldBatteryChannelMessage,
        )

        asMockedFunction(getChannelInfo).mockResolvedValue(shieldBatteryChannel)
        asMockedFunction(getPermissions).mockResolvedValue({
          ...userPermissions,
          moderateChatChannels: true,
        })
        asMockedFunction(getUserChannelEntryForUser).mockImplementation(
          async (userId: SbUserId, channelId: SbChannelId) => {
            if (userId === user1.id && channelId === shieldBatteryChannel.id) {
              return user1ShieldBatteryChannelEntry
            } else if (userId === user2.id && channelId === shieldBatteryChannel.id) {
              return user2ShieldBatteryChannelEntry
            }
            return null
          },
        )
      })

      test("should throw if it's not allowed", async () => {
        flagsMock.CAN_LEAVE_SHIELDBATTERY_CHANNEL = false

        await expect(
          chatService.moderateUser(
            shieldBatteryChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          ),
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"Can't moderate users in the ShieldBattery channel"`,
        )
      })

      test("works when it's allowed", async () => {
        flagsMock.CAN_LEAVE_SHIELDBATTERY_CHANNEL = true

        await chatService.moderateUser(
          shieldBatteryChannel.id,
          user1.id,
          user2.id,
          ChannelModerationAction.Kick,
        )

        expect(removeUserFromChannelMock).toHaveBeenCalledWith(user2.id, shieldBatteryChannel.id)
        expect(client1.publish).toHaveBeenCalledWith(getChannelPath(shieldBatteryChannel.id), {
          action: ChannelModerationAction.Kick,
          targetId: user2.id,
          channelName: shieldBatteryChannel.name,
          newOwnerId: undefined,
        })

        await expectMessageWasNotReceived(user1, shieldBatteryChannel, client2)
        expect(client2.unsubscribe).toHaveBeenCalledWith(
          getChannelUserPath(shieldBatteryChannel.id, user2.id),
        )
      })
    })

    describe('when moderating non-ShieldBattery channel', () => {
      const expectItWorks = async () => {
        expect(removeUserFromChannelMock).toHaveBeenCalledWith(user2.id, testChannel.id)
        expect(client1.publish).toHaveBeenCalledWith(getChannelPath(testChannel.id), {
          action: ChannelModerationAction.Kick,
          targetId: user2.id,
          channelName: testChannel.name,
          newOwnerId: undefined,
        })

        await expectMessageWasNotReceived(user1, testChannel, client2)
        expect(client2.unsubscribe).toHaveBeenCalledWith(
          getChannelUserPath(testChannel.id, user2.id),
        )
      }

      beforeEach(async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )
        await joinUserToChannel(
          user2,
          testChannel,
          user2TestChannelEntry,
          joinUser2TestChannelMessage,
        )
      })

      test('should throw if not enough permissions to moderate channel owners', async () => {
        asMockedFunction(getChannelInfo).mockResolvedValue({
          ...testChannel,
          topic: 'CHANNEL_TOPIC',
          ownerId: user2.id,
        })
        asMockedFunction(getUserChannelEntryForUser).mockImplementation(
          async (userId: SbUserId, channelId: SbChannelId) => {
            if (userId === user1.id && channelId === testChannel.id) {
              return user1TestChannelEntry
            } else if (userId === user2.id && channelId === testChannel.id) {
              return user2TestChannelEntry
            }
            return null
          },
        )

        await expect(
          chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          ),
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"Only server moderators can moderate channel owners"`,
        )
      })

      test('should throw if not enough permissions to moderate channel moderators', async () => {
        asMockedFunction(getUserChannelEntryForUser).mockImplementation(
          async (userId: SbUserId, channelId: SbChannelId) => {
            if (userId === user1.id && channelId === testChannel.id) {
              return user1TestChannelEntry
            } else if (userId === user2.id && channelId === testChannel.id) {
              return {
                ...user2TestChannelEntry,
                channelPermissions: { ...channelPermissions, editPermissions: true },
              }
            }
            return null
          },
        )

        await expect(
          chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          ),
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"Only server moderators and channel owners can moderate channel moderators"`,
        )
      })

      test('should throw if not enough permissions to moderate the user', async () => {
        asMockedFunction(getUserChannelEntryForUser).mockImplementation(
          async (userId: SbUserId, channelId: SbChannelId) => {
            if (userId === user1.id && channelId === testChannel.id) {
              return user1TestChannelEntry
            } else if (userId === user2.id && channelId === testChannel.id) {
              return user2TestChannelEntry
            }
            return null
          },
        )

        await expect(
          chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          ),
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"Not enough permissions to moderate the user"`,
        )
      })

      describe('when user is server moderator', () => {
        beforeEach(() => {
          asMockedFunction(getPermissions).mockResolvedValue({
            ...userPermissions,
            moderateChatChannels: true,
          })
        })

        test('works when target is channel owner', async () => {
          asMockedFunction(getChannelInfo).mockResolvedValue({
            ...testChannel,
            topic: 'CHANNEL_TOPIC',
            ownerId: user2.id,
          })
          asMockedFunction(getUserChannelEntryForUser).mockImplementation(
            async (userId: SbUserId, channelId: SbChannelId) => {
              if (userId === user1.id && channelId === testChannel.id) {
                return user1TestChannelEntry
              } else if (userId === user2.id && channelId === testChannel.id) {
                return user2TestChannelEntry
              }
              return null
            },
          )

          await chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          )

          await expectItWorks()
        })

        test('works when target is channel moderator', async () => {
          asMockedFunction(getUserChannelEntryForUser).mockImplementation(
            async (userId: SbUserId, channelId: SbChannelId) => {
              if (userId === user1.id && channelId === testChannel.id) {
                return user1TestChannelEntry
              } else if (userId === user2.id && channelId === testChannel.id) {
                return {
                  ...user2TestChannelEntry,
                  channelPermissions: { ...channelPermissions, editPermissions: true },
                }
              }
              return null
            },
          )

          await chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          )

          await expectItWorks()
        })

        test('works when target is regular user', async () => {
          asMockedFunction(getUserChannelEntryForUser).mockImplementation(
            async (userId: SbUserId, channelId: SbChannelId) => {
              if (userId === user1.id && channelId === testChannel.id) {
                return user1TestChannelEntry
              } else if (userId === user2.id && channelId === testChannel.id) {
                return user2TestChannelEntry
              }
              return null
            },
          )

          await chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          )

          await expectItWorks()
        })
      })

      describe('when user is channel owner', () => {
        beforeEach(() => {
          asMockedFunction(getChannelInfo).mockResolvedValue({
            ...testChannel,
            topic: 'CHANNEL_TOPIC',
            ownerId: user1.id,
          })
        })

        test('works when target is channel moderator', async () => {
          asMockedFunction(getUserChannelEntryForUser).mockImplementation(
            async (userId: SbUserId, channelId: SbChannelId) => {
              if (userId === user1.id && channelId === testChannel.id) {
                return user1TestChannelEntry
              } else if (userId === user2.id && channelId === testChannel.id) {
                return {
                  ...user2TestChannelEntry,
                  channelPermissions: { ...channelPermissions, editPermissions: true },
                }
              }
              return null
            },
          )

          await chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          )

          await expectItWorks()
        })

        test('works when target is regular user', async () => {
          asMockedFunction(getUserChannelEntryForUser).mockImplementation(
            async (userId: SbUserId, channelId: SbChannelId) => {
              if (userId === user1.id && channelId === testChannel.id) {
                return user1TestChannelEntry
              } else if (userId === user2.id && channelId === testChannel.id) {
                return user2TestChannelEntry
              }
              return null
            },
          )

          await chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          )

          await expectItWorks()
        })
      })

      describe('when user is channel moderator', () => {
        beforeEach(() => {
          asMockedFunction(getUserChannelEntryForUser).mockImplementation(
            async (userId: SbUserId, channelId: SbChannelId) => {
              if (userId === user1.id && channelId === testChannel.id) {
                return {
                  ...user1TestChannelEntry,
                  channelPermissions: { ...channelPermissions, editPermissions: true },
                }
              } else if (userId === user2.id && channelId === testChannel.id) {
                return user2TestChannelEntry
              }
              return null
            },
          )
        })

        test('works when target is regular user', async () => {
          await chatService.moderateUser(
            testChannel.id,
            user1.id,
            user2.id,
            ChannelModerationAction.Kick,
          )

          await expectItWorks()
        })
      })

      test('should ban user if moderation action is "Ban"', async () => {
        const banUserFromChannelMock = asMockedFunction(banUserFromChannel)
        const banAllIdentifiersFromChannelMock = asMockedFunction(banAllIdentifiersFromChannel)

        asMockedFunction(getPermissions).mockResolvedValue({
          ...userPermissions,
          moderateChatChannels: true,
        })
        asMockedFunction(getUserChannelEntryForUser).mockImplementation(
          async (userId: SbUserId, channelId: SbChannelId) => {
            if (userId === user1.id && channelId === testChannel.id) {
              return user1TestChannelEntry
            } else if (userId === user2.id && channelId === testChannel.id) {
              return user2TestChannelEntry
            }
            return null
          },
        )

        await chatService.moderateUser(
          testChannel.id,
          user1.id,
          user2.id,
          ChannelModerationAction.Ban,
          'MODERATION_REASON',
        )

        expect(banUserFromChannelMock).toHaveBeenCalledWith(
          {
            channelId: testChannel.id,
            moderatorId: user1.id,
            targetId: user2.id,
            reason: 'MODERATION_REASON',
          },
          dbClient,
        )
        expect(banAllIdentifiersFromChannelMock).toHaveBeenCalledWith(
          {
            channelId: testChannel.id,
            targetId: user2.id,
          },
          dbClient,
        )
      })
    })
  })

  describe('sendChatMessage', () => {
    test('should throw if not in channel', async () => {
      await expect(
        chatService.sendChatMessage(testChannel.id, user1.id, 'Hello World!'),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Must be in a channel to send a message to it"`)
    })

    describe('when in channel', () => {
      const expectItWorks = (
        processedMessageString: string,
        userMentions: SbUser[],
        channelMentions: FullChannelInfo[],
      ) => {
        expect(addMessageToChannelMock).toHaveBeenCalledWith(user1.id, testChannel.id, {
          type: textMessage.data.type,
          text: processedMessageString,
          mentions: userMentions.length > 0 ? userMentions.map(m => m.id) : undefined,
          channelMentions: channelMentions.length > 0 ? channelMentions.map(c => c.id) : undefined,
        })
        expect(client2.publish).toHaveBeenCalledWith(getChannelPath(testChannel.id), {
          action: 'message2',
          message: toTextMessageJson(textMessage),
          user: user1,
          mentions: userMentions,
          channelMentions: channelMentions.map(c => toBasicChannelInfo(c)),
        })
      }

      beforeEach(async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )
        await joinUserToChannel(
          user2,
          testChannel,
          user2TestChannelEntry,
          joinUser2TestChannelMessage,
        )
      })

      test('works for regular text messages', async () => {
        const messageString = 'Hello World!'
        mockTextMessage(user1, testChannel, messageString, [], [])

        await chatService.sendChatMessage(testChannel.id, user1.id, messageString)

        expectItWorks(messageString, [], [])
      })

      test('works when there are user mentions in a message', async () => {
        const messageString = `Hello @${user1.name}, @${user2.name}, and @unknown.`
        const processedText = `Hello <@${user1.id}>, <@${user2.id}>, and @unknown.`
        const userMentions = [user1, user2]
        mockTextMessage(user1, testChannel, processedText, userMentions, [])

        await chatService.sendChatMessage(testChannel.id, user1.id, messageString)

        expectItWorks(processedText, userMentions, [])
      })

      test('works when there are channel mentions in a message', async () => {
        const messageString = `#${shieldBatteryChannel.name} #${testChannel.name} and #unknown.`
        const processedText = `<#${shieldBatteryChannel.id}> <#${testChannel.id}> and #unknown.`
        const channelMentions = [shieldBatteryChannel, testChannel]
        mockTextMessage(user1, testChannel, processedText, [], channelMentions)

        await chatService.sendChatMessage(testChannel.id, user1.id, messageString)

        expectItWorks(processedText, [], channelMentions)
      })

      test('works when there are both user and channel mentions in a message', async () => {
        const messageString = `Hello @${user1.name}, join #${testChannel.name} please.`
        const processedText = `Hello <@${user1.id}>, join <#${testChannel.id}> please.`
        const userMentions = [user1]
        const channelMentions = [testChannel]
        mockTextMessage(user1, testChannel, processedText, userMentions, channelMentions)

        await chatService.sendChatMessage(testChannel.id, user1.id, messageString)

        expectItWorks(processedText, userMentions, channelMentions)
      })
    })
  })

  describe('deleteMessage', () => {
    test('should throw if not an admin', async () => {
      await expect(
        chatService.deleteMessage({
          channelId: testChannel.id,
          messageId: 'MESSAGE_ID',
          userId: user1.id,
          isAdmin: false,
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Not enough permissions to delete a message"`)
    })

    test('works when an admin', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      const messageId = 'MESSAGE_ID'
      const deleteChannelMessageMock = asMockedFunction(deleteChannelMessage)

      await chatService.deleteMessage({
        channelId: testChannel.id,
        messageId,
        userId: user1.id,
        isAdmin: true,
      })

      expect(deleteChannelMessageMock).toHaveBeenCalledWith(messageId, testChannel.id)
      expect(client1.publish).toHaveBeenCalledWith(getChannelPath(testChannel.id), {
        action: 'messageDeleted',
        messageId,
      })
    })
  })

  describe('getChannelInfo', () => {
    beforeEach(() => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)
    })

    test('should throw if channel not found', async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.getChannelInfo(testChannel.id, user1.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('returns channel info when found', async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)

      const result = await chatService.getChannelInfo(testChannel.id, user1.id)

      expect(result).toEqual({
        channelInfo: testBasicInfo,
        detailedChannelInfo: testDetailedInfo,
        joinedChannelInfo: testJoinedInfo,
      })
    })

    describe('when channel is private', () => {
      test("doesn't return detailed channel info", async () => {
        asMockedFunction(getChannelInfo).mockResolvedValue({ ...testChannel, private: true })

        const result = await chatService.getChannelInfo(testChannel.id, user1.id)

        expect(result).toEqual({
          channelInfo: {
            ...testBasicInfo,
            private: true,
          },
          detailedChannelInfo: undefined,
          joinedChannelInfo: undefined,
        })
      })

      test('returns detailed channel info if user is in channel', async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )

        asMockedFunction(getChannelInfo).mockResolvedValue({ ...testChannel, private: true })

        const result = await chatService.getChannelInfo(testChannel.id, user1.id)

        expect(result).toEqual({
          channelInfo: {
            ...testBasicInfo,
            private: true,
          },
          detailedChannelInfo: testDetailedInfo,
          joinedChannelInfo: testJoinedInfo,
        })
      })
    })
  })

  describe('getChannelInfos', () => {
    beforeEach(() => {
      asMockedFunction(getUserChannelEntriesForUser).mockResolvedValue([])
    })

    test('returns no channel infos when no channels are found', async () => {
      asMockedFunction(getChannelInfos).mockResolvedValue([])

      const result = await chatService.getChannelInfos([], user1.id)

      expect(result).toEqual({
        channelInfos: [],
        detailedChannelInfos: [],
        joinedChannelInfos: [],
      })
    })

    test('returns channel infos when found', async () => {
      asMockedFunction(getChannelInfos).mockResolvedValue([shieldBatteryChannel, testChannel])

      const result = await chatService.getChannelInfos(
        [shieldBatteryChannel.id, testChannel.id],
        user1.id,
      )

      expect(result).toEqual({
        channelInfos: [shieldBatteryBasicInfo, testBasicInfo],
        detailedChannelInfos: [shieldBatteryDetailedInfo, testDetailedInfo],
        joinedChannelInfos: [shieldBatteryJoinedInfo, testJoinedInfo],
      })
    })

    describe('when any of the channels is private', () => {
      beforeEach(() => {
        asMockedFunction(getChannelInfos).mockResolvedValue([
          shieldBatteryChannel,
          { ...testChannel, private: true },
        ])
      })

      test("doesn't return detailed and joined channel infos for private channels", async () => {
        const result = await chatService.getChannelInfos(
          [shieldBatteryChannel.id, testChannel.id],
          user1.id,
        )

        expect(result).toEqual({
          channelInfos: [shieldBatteryBasicInfo, { ...testBasicInfo, private: true }],
          detailedChannelInfos: [shieldBatteryDetailedInfo],
          joinedChannelInfos: [shieldBatteryJoinedInfo],
        })
      })

      test('returns detailed and joined channel info if user is in a private channel', async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )

        const result = await chatService.getChannelInfos(
          [shieldBatteryChannel.id, testChannel.id],
          user1.id,
        )

        expect(result).toEqual({
          channelInfos: [shieldBatteryBasicInfo, { ...testBasicInfo, private: true }],
          detailedChannelInfos: [
            shieldBatteryDetailedInfo,
            { ...testDetailedInfo, userCount: testChannel.userCount },
          ],
          joinedChannelInfos: [shieldBatteryJoinedInfo, testJoinedInfo],
        })
      })
    })
  })

  describe('searchChannels', () => {
    test('returns no channel infos when no channels are found', async () => {
      asMockedFunction(searchChannels).mockResolvedValue([])
      asMockedFunction(getChannelsForUser).mockResolvedValue([])

      const result = await chatService.searchChannels({ userId: user1.id, limit: 40, offset: 0 })

      expect(result).toEqual({
        channelInfos: [],
        detailedChannelInfos: [],
        joinedChannelInfos: [],
        hasMoreChannels: false,
      })
    })

    test('returns channel infos when found', async () => {
      asMockedFunction(searchChannels).mockResolvedValue([shieldBatteryChannel, testChannel])
      asMockedFunction(getChannelsForUser).mockResolvedValue([])

      const result = await chatService.searchChannels({ userId: user1.id, limit: 40, offset: 0 })

      expect(result).toEqual({
        channelInfos: [shieldBatteryBasicInfo, testBasicInfo],
        detailedChannelInfos: [shieldBatteryDetailedInfo, testDetailedInfo],
        joinedChannelInfos: [shieldBatteryJoinedInfo, testJoinedInfo],
        hasMoreChannels: false,
      })
    })

    describe('when any of the channels is private', () => {
      test("doesn't return detailed and joined channel infos for private channels", async () => {
        asMockedFunction(searchChannels).mockResolvedValue([
          shieldBatteryChannel,
          { ...testChannel, private: true },
        ])
        asMockedFunction(getChannelsForUser).mockResolvedValue([])

        const result = await chatService.searchChannels({ userId: user1.id, limit: 40, offset: 0 })

        expect(result).toEqual({
          channelInfos: [shieldBatteryBasicInfo, { ...testBasicInfo, private: true }],
          detailedChannelInfos: [shieldBatteryDetailedInfo],
          joinedChannelInfos: [shieldBatteryJoinedInfo],
          hasMoreChannels: false,
        })
      })

      test('returns detailed and joined channel info if user is in a private channel', async () => {
        asMockedFunction(searchChannels).mockResolvedValue([
          shieldBatteryChannel,
          { ...testChannel, private: true },
        ])
        asMockedFunction(getChannelsForUser).mockResolvedValue([user1TestChannelEntry])

        const result = await chatService.searchChannels({ userId: user1.id, limit: 40, offset: 0 })

        // NOTE(2Pac): This method is used every time a user connects (so basically before each
        // test), so we restore the mocked return value to what it is by default, so it doesn't
        // impact the tests that run after this one.
        asMockedFunction(getChannelsForUser).mockResolvedValue([])

        expect(result).toEqual({
          channelInfos: [shieldBatteryBasicInfo, { ...testBasicInfo, private: true }],
          detailedChannelInfos: [
            shieldBatteryDetailedInfo,
            { ...testDetailedInfo, userCount: testChannel.userCount },
          ],
          joinedChannelInfos: [shieldBatteryJoinedInfo, testJoinedInfo],
          hasMoreChannels: false,
        })
      })
    })
  })

  describe('getChannelHistory', () => {
    const textMessage1: FakeDbTextChannelMessage = {
      msgId: 'MESSAGE_1_ID',
      userId: user1.id,
      userName: user1.name,
      channelId: testChannel.id,
      sent: new Date('2023-03-11T00:00:00.000Z'),
      data: {
        type: ServerChatMessageType.TextMessage,
        text: 'Hello World!',
      },
    }
    const textMessage2: FakeDbTextChannelMessage = {
      msgId: 'MESSAGE_2_ID',
      userId: user1.id,
      userName: user1.name,
      channelId: testChannel.id,
      sent: new Date('2023-03-11T00:00:00.000Z'),
      data: {
        type: ServerChatMessageType.TextMessage,
        text: `Hello <@${user1.id}>, <@${user2.id}>, and @unknown.`,
        mentions: [user1.id, user2.id],
      },
    }
    const textMessage3: FakeDbTextChannelMessage = {
      msgId: 'MESSAGE_3_ID',
      userId: user1.id,
      userName: user1.name,
      channelId: testChannel.id,
      sent: new Date('2023-03-11T00:00:00.000Z'),
      data: {
        type: ServerChatMessageType.TextMessage,
        text: `Join <#${shieldBatteryChannel.id}> <#${testChannel.id}> and #unknown.`,
        channelMentions: [shieldBatteryChannel.id, testChannel.id],
      },
    }
    const textMessage4: FakeDbTextChannelMessage = {
      msgId: 'MESSAGE_4_ID',
      userId: user1.id,
      userName: user1.name,
      channelId: testChannel.id,
      sent: new Date('2023-03-11T00:00:00.000Z'),
      data: {
        type: ServerChatMessageType.TextMessage,
        text: `Hello <@${user1.id}>, join <#${testChannel.id}> please.`,
        mentions: [user1.id],
        channelMentions: [testChannel.id],
      },
    }

    const mockTextMessages = () => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user1TestChannelEntry)
      asMockedFunction(getMessagesForChannel).mockResolvedValue([
        joinUser1TestChannelMessage,
        textMessage1,
        textMessage2,
        textMessage3,
        textMessage4,
      ])
      asMockedFunction(getChannelInfos).mockResolvedValue([shieldBatteryChannel, testChannel])
    }
    const expectItWorks = (result: GetChannelHistoryServerResponse) => {
      expect(result).toEqual({
        messages: [
          toJoinChannelMessageJson(joinUser1TestChannelMessage),
          toTextMessageJson(textMessage1),
          toTextMessageJson(textMessage2),
          toTextMessageJson(textMessage3),
          toTextMessageJson(textMessage4),
        ],
        users: [user1],
        mentions: [user1, user2],
        channelMentions: [
          toBasicChannelInfo(shieldBatteryChannel),
          toBasicChannelInfo(testChannel),
        ],
        deletedChannels: [],
      })
    }

    describe('when an admin', () => {
      test('works when not in channel', async () => {
        asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

        mockTextMessages()

        const result = await chatService.getChannelHistory({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: true,
        })

        expectItWorks(result)
      })

      test('works when in channel', async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )

        mockTextMessages()

        const result = await chatService.getChannelHistory({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: true,
        })

        expectItWorks(result)
      })
    })

    describe('when not an admin', () => {
      test('should throw when not in channel', async () => {
        asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

        await expect(
          chatService.getChannelHistory({
            channelId: testChannel.id,
            userId: user1.id,
            isAdmin: false,
          }),
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"Must be in a channel to retrieve message history"`,
        )
      })

      test('works when in channel', async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )

        mockTextMessages()

        const result = await chatService.getChannelHistory({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: false,
        })

        expectItWorks(result)
      })
    })

    test('should include deleted channels if there are any in chat message', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      const DELETED_ID = makeSbChannelId(999)
      const message: FakeDbTextChannelMessage = {
        msgId: 'MESSAGE_5_ID',
        userId: user1.id,
        userName: user1.name,
        channelId: testChannel.id,
        sent: new Date('2023-03-11T00:00:00.000Z'),
        data: {
          type: ServerChatMessageType.TextMessage,
          text: `Join <#${shieldBatteryChannel.id}> <#${testChannel.id}> and <#${DELETED_ID}>.`,
          channelMentions: [shieldBatteryChannel.id, testChannel.id, DELETED_ID],
        },
      }

      asMockedFunction(getMessagesForChannel).mockResolvedValue([message])
      asMockedFunction(getChannelInfos).mockResolvedValue([shieldBatteryChannel, testChannel])

      const result = await chatService.getChannelHistory({
        channelId: testChannel.id,
        userId: user1.id,
        isAdmin: false,
      })

      expect(result).toEqual({
        messages: [toTextMessageJson(message)],
        users: [user1],
        mentions: [],
        channelMentions: [
          toBasicChannelInfo(shieldBatteryChannel),
          toBasicChannelInfo(testChannel),
        ],
        deletedChannels: [DELETED_ID],
      })
    })
  })

  describe('getChannelUsers', () => {
    beforeEach(() => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user1TestChannelEntry)
      asMockedFunction(getUsersForChannel).mockResolvedValue([user1, user2])
    })

    describe('when an admin', () => {
      test('works when not in channel', async () => {
        asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

        const result = await chatService.getChannelUsers({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: true,
        })

        expect(result).toEqual([user1, user2])
      })

      test('works when in channel', async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )

        const result = await chatService.getChannelUsers({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: true,
        })

        expect(result).toEqual([user1, user2])
      })
    })

    describe('when not an admin', () => {
      test('should throw when not in channel', async () => {
        asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

        await expect(
          chatService.getChannelUsers({
            channelId: testChannel.id,
            userId: user1.id,
            isAdmin: false,
          }),
        ).rejects.toThrowErrorMatchingInlineSnapshot(`"Must be in a channel to retrieve user list"`)
      })

      test('works when in channel', async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )

        const result = await chatService.getChannelUsers({
          channelId: testChannel.id,
          userId: user1.id,
          isAdmin: false,
        })

        expect(result).toEqual([user1, user2])
      })
    })
  })

  describe('getChatUserProfile', () => {
    test('should throw when not in channel', async () => {
      await expect(
        chatService.getChatUserProfile(testChannel.id, user1.id, user2.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Must be in a channel to retrieve user profile"`,
      )
    })

    test('works when target user is not in channel', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

      const result = await chatService.getChatUserProfile(testChannel.id, user1.id, user2.id)

      expect(result).toEqual({
        userId: user2.id,
        channelId: testChannel.id,
      })
    })

    describe('when target user is in channel', () => {
      beforeEach(async () => {
        await joinUserToChannel(
          user1,
          testChannel,
          user1TestChannelEntry,
          joinUser1TestChannelMessage,
        )
        await joinUserToChannel(
          user2,
          testChannel,
          user2TestChannelEntry,
          joinUser2TestChannelMessage,
        )

        asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user2TestChannelEntry)
      })

      test("should throw when channel doesn't exist", async () => {
        asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

        await expect(
          chatService.getChatUserProfile(testChannel.id, user1.id, user2.id),
        ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
      })

      test('works when channel exists', async () => {
        asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)

        const result = await chatService.getChatUserProfile(testChannel.id, user1.id, user2.id)

        expect(result).toEqual({
          userId: user2TestChannelEntry.userId,
          channelId: user2TestChannelEntry.channelId,
          profile: {
            userId: user2TestChannelEntry.userId,
            channelId: user2TestChannelEntry.channelId,
            joinDate: Number(user2TestChannelEntry.joinDate),
            isModerator: false,
          },
        })
      })
    })
  })

  describe('getUserPermissions', () => {
    beforeEach(async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
    })

    test("should throw if channel doesn't exist", async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.getUserPermissions(testChannel.id, user1.id, user2.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('should throw if not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

      await expect(
        chatService.getUserPermissions(testChannel.id, user1.id, user2.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Must be in channel to get user's permissions"`)
    })

    test('should throw if target user not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          }
          return null
        },
      )

      await expect(
        chatService.getUserPermissions(testChannel.id, user1.id, user2.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"User must be in channel to get their permissions"`,
      )
    })

    test('should throw if not enough permissions', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          } else if (userId === user2.id && channelId === testChannel.id) {
            return user2TestChannelEntry
          }
          return null
        },
      )

      await expect(
        chatService.getUserPermissions(testChannel.id, user1.id, user2.id),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"You don't have enough permissions to get other user's permissions"`,
      )
    })

    test('works when channel owner', async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue({
        ...testChannel,
        topic: 'CHANNEL_TOPIC',
        ownerId: user1.id,
      })
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          } else if (userId === user2.id && channelId === testChannel.id) {
            return user2TestChannelEntry
          }
          return null
        },
      )

      const result = await chatService.getUserPermissions(testChannel.id, user1.id, user2.id)

      expect(result).toEqual({
        userId: user2TestChannelEntry.userId,
        channelId: user2TestChannelEntry.channelId,
        permissions: user2TestChannelEntry.channelPermissions,
      })
    })

    test('works when can edit channel permissions', async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return {
              ...user1TestChannelEntry,
              channelPermissions: { ...channelPermissions, editPermissions: true },
            }
          } else if (userId === user2.id && channelId === testChannel.id) {
            return user2TestChannelEntry
          }
          return null
        },
      )

      const result = await chatService.getUserPermissions(testChannel.id, user1.id, user2.id)

      expect(result).toEqual({
        userId: user2TestChannelEntry.userId,
        channelId: user2TestChannelEntry.channelId,
        permissions: user2TestChannelEntry.channelPermissions,
      })
    })
  })

  describe('updateUserPreferences', () => {
    const updateUserPreferencesMock =
      asMockedFunction(updateUserPreferences).mockResolvedValue(user1TestChannelEntry)

    beforeEach(async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
    })

    test("should throw if channel doesn't exist", async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.updateUserPreferences(testChannel.id, user1.id, channelPreferences),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('should throw if not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

      await expect(
        chatService.updateUserPreferences(testChannel.id, user1.id, channelPreferences),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Must be in channel to update preferences"`)
    })

    test('works when updating channel preferences', async () => {
      await joinUserToChannel(
        user1,
        testChannel,
        user1TestChannelEntry,
        joinUser1TestChannelMessage,
      )

      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(user1TestChannelEntry)

      await chatService.updateUserPreferences(testChannel.id, user1.id, channelPreferences)

      expect(updateUserPreferencesMock).toHaveBeenCalledWith(
        testChannel.id,
        user1.id,
        channelPreferences,
      )
      expect(client1.publish).toHaveBeenCalledWith(getChannelUserPath(testChannel.id, user1.id), {
        action: 'preferencesChanged',
        selfPreferences: channelPreferences,
      })
    })
  })

  describe('updateUserPermissions', () => {
    const updateUserPermissionsMock = asMockedFunction(updateUserPermissions)

    beforeEach(async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
    })

    test("should throw if channel doesn't exist", async () => {
      asMockedFunction(getChannelInfo).mockResolvedValue(undefined)

      await expect(
        chatService.updateUserPermissions(testChannel.id, user1.id, user2.id, channelPermissions),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`"Channel not found"`)
    })

    test('should throw if not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockResolvedValue(null)

      await expect(
        chatService.updateUserPermissions(testChannel.id, user1.id, user2.id, channelPermissions),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Must be in channel to update user's permissions"`,
      )
    })

    test('should throw if target user not in channel', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          }
          return null
        },
      )

      await expect(
        chatService.updateUserPermissions(testChannel.id, user1.id, user2.id, channelPermissions),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"User must be in channel to update their permissions"`,
      )
    })

    test('should throw if not enough permissions', async () => {
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          } else if (userId === user2.id && channelId === testChannel.id) {
            return user2TestChannelEntry
          }
          return null
        },
      )

      await expect(
        chatService.updateUserPermissions(testChannel.id, user1.id, user2.id, channelPermissions),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"You don't have enough permissions to update other user's permissions"`,
      )
    })

    test('works when channel owner', async () => {
      await joinUserToChannel(
        user2,
        testChannel,
        user2TestChannelEntry,
        joinUser2TestChannelMessage,
      )

      asMockedFunction(getChannelInfo).mockResolvedValue({
        ...testChannel,
        topic: 'CHANNEL_TOPIC',
        ownerId: user1.id,
      })
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return user1TestChannelEntry
          } else if (userId === user2.id && channelId === testChannel.id) {
            return user2TestChannelEntry
          }
          return null
        },
      )

      await chatService.updateUserPermissions(
        testChannel.id,
        user1.id,
        user2.id,
        channelPermissions,
      )

      expect(updateUserPermissionsMock).toHaveBeenCalledWith(
        testChannel.id,
        user2.id,
        channelPermissions,
      )
      expect(client2.publish).toHaveBeenCalledWith(getChannelUserPath(testChannel.id, user2.id), {
        action: 'permissionsChanged',
        selfPermissions: channelPermissions,
      })
    })

    test('works when can edit channel permissions', async () => {
      await joinUserToChannel(
        user2,
        testChannel,
        user2TestChannelEntry,
        joinUser2TestChannelMessage,
      )

      asMockedFunction(getChannelInfo).mockResolvedValue(testChannel)
      asMockedFunction(getUserChannelEntryForUser).mockImplementation(
        async (userId: SbUserId, channelId: SbChannelId) => {
          if (userId === user1.id && channelId === testChannel.id) {
            return {
              ...user1TestChannelEntry,
              channelPermissions: { ...channelPermissions, editPermissions: true },
            }
          } else if (userId === user2.id && channelId === testChannel.id) {
            return user2TestChannelEntry
          }
          return null
        },
      )

      await chatService.updateUserPermissions(
        testChannel.id,
        user1.id,
        user2.id,
        channelPermissions,
      )

      expect(updateUserPermissionsMock).toHaveBeenCalledWith(
        testChannel.id,
        user2.id,
        channelPermissions,
      )
      expect(client2.publish).toHaveBeenCalledWith(getChannelUserPath(testChannel.id, user2.id), {
        action: 'permissionsChanged',
        selfPermissions: channelPermissions,
      })
    })
  })
})
