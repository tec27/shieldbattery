import { NydusServer } from 'nydus'
import promClient from 'prom-client'
import RallyPointCreator, { CreatedRoute } from 'rally-point-creator'
import { GameConfig, GameSource, GameType } from '../../../common/games/configuration'
import {
  GameLoadBeginEvent,
  GameLoadCountdownEvent,
  GameLoadProgressEvent,
  GameLoadRoutesEvent,
} from '../../../common/games/games'
import { BwUserLatency } from '../../../common/network'
import { RallyPointServer, ResolvedRallyPointServer } from '../../../common/rally-point'
import { asMockedFunction } from '../../../common/testing/mocks'
import { makeSbUserId, SbUser, SbUserId } from '../../../common/users/sb-user'
import { deleteUserRecordsForGame } from '../models/games-users'
import { RallyPointService } from '../rally-point/rally-point-service'
import { FakeClock, StopCriteria } from '../time/testing/fake-clock'
import { RequestSessionLookup } from '../websockets/session-lookup'
import { ClientSocketsGroup, ClientSocketsManager } from '../websockets/socket-groups'
import {
  clearTestLogs,
  createFakeNydusServer,
  InspectableNydusClient,
  NydusConnector,
} from '../websockets/testing/websockets'
import { TypedPublisher } from '../websockets/typed-publisher'
import { COUNTDOWN_TIME_MS, GameLoaderService, GAME_LAUNCH_TIMEOUT_MS } from './game-loader-service'
import { deleteRecordForGame } from './game-models'
import { GameplayActivityRegistry } from './gameplay-activity-registry'
import { registerGame } from './registration'

const RALLY_POINT_SERVERS: ReadonlyArray<RallyPointServer> = [
  {
    id: 1,
    enabled: true,
    description: 'East',
    hostname: 'east.example.org',
    port: 1234,
  },
  {
    id: 2,
    enabled: true,
    description: 'West',
    hostname: 'west.example.org',
    port: 1234,
  },
]
const RESOLVED_RALLY_POINT_EAST: ResolvedRallyPointServer = {
  ...RALLY_POINT_SERVERS[0],
  address4: '::ffff:192.168.0.2',
  address6: '::beef:192.168.0.2',
}
const RESOLVED_RALLY_POINT_WEST: ResolvedRallyPointServer = {
  ...RALLY_POINT_SERVERS[1],
  address4: '::ffff:192.168.0.3',
  address6: '::beef:192.168.0.3',
}
const MAP_ID = 'my-cool-map-id'

jest.mock('rally-point-creator')
jest.mock('../rally-point/models', () => ({
  retrieveRallyPointServers: jest.fn().mockImplementation(async () => {
    return [...RALLY_POINT_SERVERS]
  }),
}))

jest.mock('./registration')
jest.mock('./game-models')
jest.mock('../models/games-users')
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn().mockImplementation(async (host, opts) => {
    const is6 = opts?.family === 6
    if (host === 'east.example.org') {
      return { address: is6 ? '::beef:192.168.0.2' : '192.168.0.2', family: is6 ? 6 : 4 }
    } else if (host === 'west.example.org') {
      return { address: is6 ? '::beef:192.168.0.3' : '192.168.0.3', family: is6 ? 6 : 4 }
    } else {
      throw new Error('unknown server being looked up: ' + host)
    }
  }),
}))

jest.mock('../users/user-model', () => {
  const USERS: ReadonlyMap<SbUserId, SbUser> = new Map([
    [1 as any, { id: 1 as any, name: 'One' }],
    [2 as any, { id: 2 as any, name: 'Two' }],
    [3 as any, { id: 3 as any, name: 'Three' }],
    [4 as any, { id: 4 as any, name: 'Four' }],
  ])

  return {
    findUsersById: jest.fn().mockImplementation(async (ids: ReadonlyArray<SbUserId>) => {
      return ids.map(id => USERS.get(id)).filter(u => !!u)
    }),
  }
})
jest.mock('../maps/map-models', () => ({
  getMapInfo: jest.fn().mockImplementation(async (mapIds: string[]) => {
    return mapIds.map(id => ({
      id,
      hash: `hash-${id}`,
      name: `name-${id}`,
      description: '',
      uploadedBy: { id: 1, name: 'One' },
      visibility: 'public',
      mapData: {} as any,
      mapUrl: 'http://example.org/map.scm',
      imageVersion: 0,
      isFavorited: false,
    }))
  }),
}))

const USER_1: SbUser = { id: makeSbUserId(1), name: 'One' }
const USER_2: SbUser = { id: makeSbUserId(2), name: 'Two' }
const USER_3: SbUser = { id: makeSbUserId(3), name: 'Three' }
const USER_4: SbUser = { id: makeSbUserId(4), name: 'Four' }

describe('games/game-loader-service', () => {
  let nydus: NydusServer
  let clientSocketsManager: ClientSocketsManager
  let gameplayActivityRegistry: GameplayActivityRegistry
  let connector: NydusConnector
  let clock: FakeClock
  let rallyPointService: RallyPointService

  let gameLoaderService: GameLoaderService

  let client1: InspectableNydusClient
  let client2: InspectableNydusClient
  let client3: InspectableNydusClient
  let client4: InspectableNydusClient

  function registerActive(userId: number, client: InspectableNydusClient): ClientSocketsGroup {
    const clientGroup = clientSocketsManager.getById(makeSbUserId(userId), String(userId))
    expect(clientGroup).toBeDefined()
    expect(clientGroup?.sockets.contains(client)).toBe(true)
    gameplayActivityRegistry.registerActiveClient(makeSbUserId(userId), clientGroup!)

    return clientGroup!
  }

  beforeEach(async () => {
    let curRoutePlayerId = 0
    let curRouteId = 0
    asMockedFunction(RallyPointCreator as any).mockImplementation((): RallyPointCreator => {
      return {
        bind: jest.fn().mockResolvedValue(undefined),
        close: jest.fn(),
        addErrorHandler: jest.fn(),
        removeErrorHandler: jest.fn(),
        createRoute: jest.fn().mockImplementation((): CreatedRoute => {
          return {
            p1Id: curRoutePlayerId++,
            p2Id: curRoutePlayerId++,
            routeId: `route-${curRouteId++}`,
          }
        }),
      }
    })

    let curGameId = 0
    let curResultCode = 0
    asMockedFunction(registerGame).mockImplementation(async (mapId, gameConfig) => {
      const humanPlayers = gameConfig.teams.reduce((r, team) => {
        const humans = team.filter(p => !p.isComputer)
        r.push(...humans)
        return r
      }, [])
      const resultCodes = new Map(humanPlayers.map(p => [p.id, `result-${curResultCode++}`]))
      return { gameId: `game-${curGameId++}`, resultCodes }
    })

    promClient.register.clear()

    nydus = createFakeNydusServer()
    const sessionLookup = new RequestSessionLookup()
    clientSocketsManager = new ClientSocketsManager(nydus, sessionLookup)
    gameplayActivityRegistry = new GameplayActivityRegistry()

    const typedPublisher = new TypedPublisher(nydus)
    rallyPointService = new RallyPointService(nydus, clientSocketsManager)
    await rallyPointService.initialize('host', 0, 'SUPERSECRET')
    clock = new FakeClock()
    clock.setCurrentTime(Number(new Date('2023-03-23T15:00:00.000Z')))

    gameLoaderService = new GameLoaderService(
      gameplayActivityRegistry,
      typedPublisher,
      rallyPointService,
      clock,
    )

    connector = new NydusConnector(nydus, sessionLookup)
    client1 = connector.connectClient(USER_1, '1', 'electron')
    client2 = connector.connectClient(USER_2, '2', 'electron')
    client3 = connector.connectClient(USER_3, '3', 'electron')
    client4 = connector.connectClient(USER_4, '4', 'electron')

    asMockedFunction(client1.publish).mockClear()
    asMockedFunction(client2.publish).mockClear()
    asMockedFunction(client3.publish).mockClear()
    asMockedFunction(client4.publish).mockClear()
    clearTestLogs(nydus)

    clock.autoRunTimeouts = false
  })

  test('1 human vs AI - success', async () => {
    registerActive(1, client1)
    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(-1), race: 'z', isComputer: true, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(1))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'progress',
      id: 'game-0',
      completed: [makeSbUserId(1)],
    } satisfies GameLoadProgressEvent)
    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'countdown',
      id: 'game-0',
    } satisfies GameLoadCountdownEvent)
    asMockedFunction(client1.publish).mockClear()

    await clock.runTimeoutsUntil({
      criteria: StopCriteria.TimeReached,
      timeMillis: clock.now() + COUNTDOWN_TIME_MS,
    })
    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'complete',
      id: 'game-0',
    })

    await expect(gameLoadPromise).resolves.toBeUndefined()
  })

  test('1 human vs AI - timeout', async () => {
    registerActive(1, client1)
    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(-1), race: 'z', isComputer: true, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    await Promise.all([
      clock.runTimeoutsUntil({
        criteria: StopCriteria.TimeReached,
        timeMillis: clock.now() + GAME_LAUNCH_TIMEOUT_MS,
      }),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(
        `"one or more players failed to launch in time"`,
      ),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('1 human vs AI - failure', async () => {
    registerActive(1, client1)
    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(-1), race: 'z', isComputer: true, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    gameLoadPromise.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    gameLoaderService.registerPlayerFailed('game-0', makeSbUserId(1))

    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 10)),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(`"player failed to load"`),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('2 humans - success', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    const clientGroup2 = registerActive(2, client2)
    rallyPointService.updatePing(clientGroup2, 1, 10)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'routes',
        id: 'game-0',
        routes: [
          {
            for: makeSbUserId(2),
            server: RESOLVED_RALLY_POINT_EAST,
            routeId: expect.any(String),
            playerId: expect.any(Number),
          },
        ],
        turnRate: 24,
        userLatency: BwUserLatency.Low,
      } satisfies GameLoadRoutesEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'routes',
        id: 'game-0',
        routes: [
          {
            for: makeSbUserId(1),
            server: RESOLVED_RALLY_POINT_EAST,
            routeId: expect.any(String),
            playerId: expect.any(Number),
          },
        ],
        turnRate: 24,
        userLatency: BwUserLatency.Low,
      } satisfies GameLoadRoutesEvent,
    )

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(1))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'progress',
      id: 'game-0',
      completed: [makeSbUserId(1)],
    } satisfies GameLoadProgressEvent)
    asMockedFunction(client1.publish).mockClear()

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(2))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'progress',
      id: 'game-0',
      completed: [makeSbUserId(1), makeSbUserId(2)],
    } satisfies GameLoadProgressEvent)
    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'countdown',
      id: 'game-0',
    } satisfies GameLoadCountdownEvent)
    asMockedFunction(client1.publish).mockClear()

    await clock.runTimeoutsUntil({
      criteria: StopCriteria.TimeReached,
      timeMillis: clock.now() + COUNTDOWN_TIME_MS,
    })
    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'complete',
      id: 'game-0',
    })

    await expect(gameLoadPromise).resolves.toBeUndefined()
  })

  test('2 humans - route timeout', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    registerActive(2, client2)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client2.publish).mockClear()

    await Promise.all([
      clock.runTimeoutsUntil({ criteria: StopCriteria.EmptyQueue }),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(
        `"player did not report pings"`,
      ),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(client2.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('2 humans - no route between players', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    const clientGroup2 = registerActive(2, client2)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client2.publish).mockClear()

    rallyPointService.updatePing(clientGroup2, 2, 10)

    await Promise.all([
      clock.runTimeoutsUntil({ criteria: StopCriteria.EmptyQueue }),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(
        `"could not find a route between players"`,
      ),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(client2.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('2 humans - player fails to load', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    const clientGroup2 = registerActive(2, client2)
    rallyPointService.updatePing(clientGroup2, 1, 10)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client2.publish).mockClear()

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(1))
    await new Promise(resolve => setTimeout(resolve, 10))

    gameLoaderService.registerPlayerFailed('game-0', makeSbUserId(2))

    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 10)),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(`"player failed to load"`),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(client2.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('2 humans - player times out', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    const clientGroup2 = registerActive(2, client2)
    rallyPointService.updatePing(clientGroup2, 1, 10)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client2.publish).mockClear()

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(1))

    await Promise.all([
      clock.runTimeoutsUntil({ criteria: StopCriteria.EmptyQueue }),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(
        `"one or more players failed to launch in time"`,
      ),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(client2.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('2 humans - player disconnects before loading', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    const clientGroup2 = registerActive(2, client2)
    rallyPointService.updatePing(clientGroup2, 1, 10)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client2.publish).mockClear()

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(1))
    client2.disconnect()

    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 10)),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(`"player failed to load"`),
    ])

    expect(client1.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })

  test('2 humans - player disconnects after loading', async () => {
    const clientGroup1 = registerActive(1, client1)
    rallyPointService.updatePing(clientGroup1, 1, 10)
    const clientGroup2 = registerActive(2, client2)
    rallyPointService.updatePing(clientGroup2, 1, 10)

    const gameConfig: GameConfig = {
      gameSource: GameSource.Lobby,
      gameType: GameType.Melee,
      gameSubType: 0,
      teams: [
        [
          { id: makeSbUserId(1), race: 'p', isComputer: false, slotNumber: 0 },
          { id: makeSbUserId(2), race: 'z', isComputer: false, slotNumber: 1 },
        ],
      ],
    }

    const gameLoadPromise = gameLoaderService.loadGame({
      mapId: MAP_ID,
      gameConfig,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(client1.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(1)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client1.publish).mockClear()

    expect(client2.publish).toHaveBeenCalledWith(
      GameLoaderService.getLoaderPlayerPath('game-0', makeSbUserId(2)),
      {
        type: 'begin',
        id: 'game-0',
        gameConfig,
        mapInfo: expect.anything(),
        userInfos: [USER_1, USER_2],
        resultCode: expect.any(String),
        routes: undefined,
      } satisfies GameLoadBeginEvent,
    )
    asMockedFunction(client2.publish).mockClear()

    gameLoaderService.registerPlayerLoaded('game-0', makeSbUserId(1))
    client1.disconnect()

    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 10)),

      expect(gameLoadPromise).rejects.toThrowErrorMatchingInlineSnapshot(`"player failed to load"`),
    ])

    expect(client2.publish).toHaveBeenCalledWith(GameLoaderService.getLoaderPath('game-0'), {
      type: 'cancel',
      id: 'game-0',
    })
    expect(deleteRecordForGame).toHaveBeenCalledWith('game-0')
    expect(deleteUserRecordsForGame).toHaveBeenCalledWith('game-0')
  })
})
