import { app } from 'electron'
import { promises as fsPromises } from 'fs'
import { Set } from 'immutable'
import path from 'path'
import { singleton } from 'tsyringe'
import {
  GameLaunchConfig,
  GameRoute,
  isReplayLaunchConfig,
  isReplayMapInfo,
} from '../../common/game-launch-config'
import { GameStatus, ReportedGameStatus, statusToString } from '../../common/game-status'
import { GameClientPlayerResult, SubmitGameResultsRequest } from '../../common/games/results'
import { EventMap, TypedEventEmitter } from '../../common/typed-emitter'
import { makeSbUserId, SbUserId } from '../../common/users/sb-user'
import log from '../logger'
import { LocalSettings, ScrSettings } from '../settings'
import { checkStarcraftPath } from './check-starcraft-path'
import { MapStore } from './map-store'

// Overrides the default rally-point bind port in the game. Not recommended for use outside of
// specific development testing, as it can cause game processes to conflict with each other.
const RALLY_POINT_PORT = Number(process.env.SB_RALLY_POINT_PORT ?? 0)

interface ActiveGameInfo {
  id: string
  status?: {
    state: GameStatus
    extra: any // TODO(tec27): Type the extra param based on the GameStatus
  }
  /**
   * A promise for when the game process has been launched, returning an instance of the process.
   */
  promise?: Promise<any>
  config?: GameLaunchConfig
  routes?: GameRoute[]
  /**
   * Whether or not this game instance has been told it can start.
   */
  startWhenReadySent?: boolean
  /**
   * The results of the game delivered once our local process has completed.
   */
  result?: {
    result: Record<SbUserId, GameClientPlayerResult>
    /** How long the game was played, in milliseconds. */
    time: number
  }
  /**
   * Whether or not the game result was successfully reported to the server by the game process.
   */
  resultSent?: boolean
}

function isGameConfig(
  possibleConfig: GameLaunchConfig | Record<string, never>,
): possibleConfig is GameLaunchConfig {
  return !!(possibleConfig as any).setup
}

export interface ActiveGameManagerEvents extends EventMap {
  gameCommand: (gameId: string, command: string, ...args: any[]) => void
  gameResult: (info: {
    gameId: string
    /** A mapping of player user ID -> result. */
    result: Record<SbUserId, GameClientPlayerResult>
    /** The time the game took in milliseconds. */
    time: number
  }) => void
  gameStatus: (statusInfo: ReportedGameStatus) => void
  replaySaved: (gameId: string, path: string) => void
  resendResults: (gameId: string, requestBody: SubmitGameResultsRequest) => void
}

@singleton()
export class ActiveGameManager extends TypedEventEmitter<ActiveGameManagerEvents> {
  private activeGame: ActiveGameInfo | null = null
  private serverPort = 0

  constructor(
    private mapStore: MapStore,
    private localSettings: LocalSettings,
    private scrSettings: ScrSettings,
  ) {
    super()
  }

  getStatus(): ReportedGameStatus | null {
    const game = this.activeGame
    if (game) {
      return {
        id: game.id,
        state: statusToString(game.status?.state ?? GameStatus.Unknown),
        extra: game.status?.extra,
        isReplay: game.config ? isReplayLaunchConfig(game.config) : false,
      }
    } else {
      return null
    }
  }

  setServerPort(port: number) {
    this.serverPort = port
  }

  /**
   * Sets the current game configuration. If this differs from the previous one, a new game client
   * will be launched.
   *
   * @returns the ID of the active game client, or null if there isn't one
   */
  setGameConfig(config: GameLaunchConfig | Record<string, never>): string | null {
    const current = this.activeGame
    if (current && current.id !== config.setup?.gameId) {
      // Means that a previous game left hanging somehow; quit it
      this.emit('gameCommand', current.id, 'quit')
    }
    if (!isGameConfig(config)) {
      this.setStatus(GameStatus.Unknown)
      this.activeGame = null
      return null
    }
    if (current && current.routes && isGameConfig(config)) {
      const routesIds = Set(current.routes.map(r => r.for))
      const slotIds = Set(config.setup.slots.filter(s => s.userId !== undefined).map(s => s.userId))

      if (!slotIds.isSuperset(routesIds)) {
        this.setStatus(GameStatus.Error)
        this.activeGame = null

        log.error(`Slots and routes don't match:\nslots: ${slotIds}\nroutes: ${routesIds}`)
        throw new Error("Slots and routes don't match")
      }
    }

    const gameId = config.setup.gameId
    const activeGamePromise = doLaunch(
      gameId,
      this.serverPort,
      this.localSettings,
      this.scrSettings,
    ).then(
      async proc => {
        try {
          const code = await proc.waitForExit()
          this.handleGameExit(gameId, code)
        } catch (err) {
          this.handleGameExitWaitError(gameId, err as Error)
        }
      },
      err => this.handleGameLaunchError(gameId, err),
    )
    this.activeGame = {
      ...current,
      id: gameId,
      promise: activeGamePromise,
      config,
      status: { state: GameStatus.Unknown, extra: null },
    }
    log.verbose(`Creating new game ${gameId}`)
    this.setStatus(GameStatus.Launching)
    return gameId
  }

  setGameRoutes(gameId: string, routes: GameRoute[]) {
    const current = this.activeGame
    if (current && current.id !== gameId) {
      return
    }

    if (current && current.config) {
      const routesIds = Set(routes.map(r => r.for))
      const slotIds = Set(
        current.config.setup.slots.filter(s => s.userId !== undefined).map(s => s.userId),
      )

      if (!slotIds.isSuperset(routesIds)) {
        this.setStatus(GameStatus.Error)
        this.activeGame = null

        const err = new Error("Slots and routes don't match")
        this.setStatus(GameStatus.Error, err)
        return
      }
    }

    this.activeGame = {
      ...current,
      id: gameId,
      routes,
    }
    this.setStatus(GameStatus.Launching)

    // `setGameRoutes` can be called before `setGameConfig`, in which case the config won't be set
    // yet; we also don't send the routes, since the game couldn't be connected in that case either.
    if (current && current.config) {
      this.emit('gameCommand', gameId, 'routes', routes)
      this.emit('gameCommand', gameId, 'setupGame', current.config.setup)
    }
  }

  /** Tells a particular game instance that it is okay to begin (starting actual gameplay). */
  startWhenReady(gameId: string) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }

    this.emit('gameCommand', gameId, 'startWhenReady')
    this.activeGame.startWhenReadySent = true
  }

  /** Notifies the manager that a game instance has connected and is ready for configuration. */
  async handleGameConnected(id: string) {
    if (!this.activeGame || this.activeGame.id !== id) {
      // Not our active game, must be one we started before and abandoned
      this.emit('gameCommand', id, 'quit')
      log.verbose(`Game ${id} is not any of our active games, sending quit command`)
      return
    }

    const game = this.activeGame
    this.setStatus(GameStatus.Configuring)
    const config = game.config!
    const { map } = config.setup
    config.setup.mapPath = isReplayMapInfo(map)
      ? map.path
      : this.mapStore.getPath(map.hash, map.mapData.format)

    this.emit('gameCommand', id, 'localUser', {
      // NOTE(tec27): We explicitly send these fields to avoid the Rust code logging private info
      // (emails), to make the log files safer to post publicly
      id: config.localUser.id,
      name: config.localUser.name,
    })
    this.emit('gameCommand', id, 'settings', {
      local: await this.localSettings.get(),
      scr: await this.scrSettings.get(),
      settingsFilePath: this.scrSettings.gameFilepath,
    })

    if (game.routes) {
      this.emit('gameCommand', id, 'routes', game.routes)
      this.emit('gameCommand', id, 'setupGame', config.setup)
    }

    // If the `startWhenReady` command was already sent by this point, it means it was sent while
    // the game wasn't even connected; we resend it here, otherwise the game wouldn't start at all.
    if (this.activeGame.startWhenReadySent) {
      this.emit('gameCommand', this.activeGame.id, 'startWhenReady')
    }
  }

  handleGameLaunchError(id: string, err: Error) {
    log.error(`Error while launching game ${id}: ${err.stack}`)
    if (this.activeGame && this.activeGame.id === id) {
      this.setStatus(GameStatus.Error, err)
      this.activeGame = null
    }
  }

  handleSetupProgress(gameId: string, info: any) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }
    this.setStatus(info.state, info.extra)
  }

  handleGameStart(gameId: string) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }
    this.setStatus(GameStatus.Playing)
  }

  handleGameResult(gameId: string, result: Record<SbUserId, GameClientPlayerResult>, time: number) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }

    log.verbose(`Game results: ${JSON.stringify({ result, time })}`)

    this.activeGame = {
      ...this.activeGame,
      result: { result, time },
    }
    this.setStatus(GameStatus.HasResult)

    this.emit('gameResult', { gameId, result, time })
  }

  handleGameResultSent(gameId: string) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }

    this.activeGame = {
      ...this.activeGame,
      resultSent: true,
    }
    this.setStatus(GameStatus.ResultSent)
  }

  handleGameFinished(gameId: string) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }

    this.setStatus(GameStatus.Finished)
    this.emit('gameCommand', gameId, 'cleanup_and_quit')
  }

  handleReplaySaved(gameId: string, path: string) {
    if (!this.activeGame || this.activeGame.id !== gameId) {
      return
    }

    log.verbose(`Replay saved to: ${path}`)
    this.emit('replaySaved', gameId, path)
  }

  handleGameExit(id: string, exitCode: number) {
    if (!this.activeGame || this.activeGame.id !== id) {
      return
    }

    log.verbose(`Game ${id} exited with code 0x${exitCode.toString(16)}`)

    Promise.resolve()
      .then(() => this.scrSettings.syncWithGameSettingsFile())
      .catch(err => {
        log.error(`Error syncing settings with game settings file: ${err?.stack ?? err}`)
      })

    let status = this.activeGame.status?.state ?? GameStatus.Unknown
    if (status < GameStatus.Finished) {
      if (status >= GameStatus.Playing) {
        // TODO(tec27): report a disc to the server
        this.setStatus(GameStatus.Unknown)
      } else {
        this.setStatus(
          GameStatus.Error,
          new Error(`Game exited unexpectedly with code 0x${exitCode.toString(16)}`),
        )
      }
    }

    status = this.activeGame.status?.state ?? GameStatus.Unknown
    // TODO(#541): Convert a game config to a "blank" result if one was not delivered by the
    // game before exit
    if (
      status >= GameStatus.Playing &&
      this.activeGame.config?.setup.resultCode &&
      !this.activeGame.resultSent &&
      this.activeGame.result
    ) {
      const config = this.activeGame.config!
      const submission: SubmitGameResultsRequest = {
        userId: config.localUser.id,
        resultCode: config.setup.resultCode!,
        time: this.activeGame.result.time,
        playerResults: Array.from(Object.entries(this.activeGame.result.result), ([id, result]) => [
          makeSbUserId(Number(id)),
          result,
        ]),
      }

      this.emit('resendResults', this.activeGame.id, submission)
    }

    this.activeGame = null
  }

  handleGameExitWaitError(id: string, err: Error) {
    log.error(`Error while waiting for game ${id} to exit: ${err}`)
  }

  private setStatus(state: GameStatus, extra: any = null) {
    if (this.activeGame) {
      this.activeGame.status = { state, extra }
      this.emit('gameStatus', this.getStatus()!)
      log.verbose(`Game status updated to '${statusToString(state)}' [${JSON.stringify(extra)}]`)
    }
  }
}

const injectPath = path.resolve(app.getAppPath(), '../game/dist/shieldbattery.dll')

const initialCompatLayer = process.env.__COMPAT_LAYER

async function doLaunch(
  gameId: string,
  serverPort: number,
  localSettings: LocalSettings,
  scrSettings: ScrSettings,
) {
  try {
    await fsPromises.access(injectPath)
  } catch (err) {
    throw new Error(`Could not access/find shieldbattery dll at ${injectPath}`)
  }

  const settings = await localSettings.get()

  const { starcraftPath } = settings
  if (!starcraftPath) {
    throw new Error('No Starcraft path set')
  }
  const checkResult = await checkStarcraftPath(starcraftPath)
  if (!checkResult.path || !checkResult.version) {
    throw new Error(`StarCraft path ${starcraftPath} not valid: ` + JSON.stringify(checkResult))
  }

  // Ensure that our local settings file is up-to-date with the current settings
  await scrSettings.writeGameSettingsFile()

  const userDataPath = app.getPath('userData')
  const appPath = path.join(starcraftPath, 'x86', 'starcraft.exe')
  log.debug(`Attempting to launch ${appPath} with StarCraft path: ${starcraftPath}`)

  const rallyPointPort = !isNaN(RALLY_POINT_PORT) ? RALLY_POINT_PORT : 0
  // NOTE(tec27): SC:R uses -launch as an argument to skip bnet launcher.
  const args = `"${appPath}" ${gameId} ${serverPort} "${userDataPath}" ${rallyPointPort} -launch`

  // NOTE(tec27): We dynamically import this so that it doesn't crash the process on startup if
  // an antivirus decides to delete the native module
  const { launchProcess } = await import('./native/process/index')
  // People sometimes turn on compatibility settings for the game process for misguided reasons,
  // which then cause issues that they blame on us. So, we turn off what we can (which seems to be
  // just the Run As Admin setting) to avoid those problems
  log.debug('Setting __COMPAT_LAYER to remove Run As Admin setting')
  process.env.__COMPAT_LAYER = 'RunAsInvoker'
  const proc = await launchProcess({
    appPath,
    args: args as any,
    currentDir: starcraftPath,
    dllPath: injectPath,
    dllFunc: 'OnInject',
    logCallback: ((msg: string) => log.verbose(`[Inject] ${msg}`)) as any,
  })
  process.env.__COMPAT_LAYER = initialCompatLayer
  log.verbose('Process launched')
  return proc
}
