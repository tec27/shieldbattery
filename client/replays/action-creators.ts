import cuid from 'cuid'
import { PlayerInfo } from '../../common/game-launch-config'
import { GameType } from '../../common/games/configuration'
import { TypedIpcRenderer } from '../../common/ipc'
import { SlotType } from '../../common/lobbies/slot'
import { REPLAYS_START_REPLAY } from '../actions'
import { SelfUserRecord } from '../auth/auth-records'
import { openSimpleDialog } from '../dialogs/action-creators'
import { ThunkAction } from '../dispatch-registry'
import { FileBrowserFileEntry } from '../file-browser/file-browser-types'
import logger from '../logging/logger'
import { makeServerUrl } from '../network/server-url'

const ipcRenderer = new TypedIpcRenderer()

async function setGameConfig(replay: { name: string; path: string }, user: SelfUserRecord) {
  const player: PlayerInfo = {
    type: SlotType.Human,
    typeId: 6,
    name: user.name,
    teamId: 0,
    userId: user.id,
  }
  const slots = [player]

  const header = (await ipcRenderer.invoke('replayParseMetadata', replay.path))?.headerData

  return ipcRenderer.invoke('activeGameSetConfig', {
    localUser: {
      id: user.id,
      name: user.name,
    },
    setup: {
      gameId: cuid(),
      name: replay.name,
      map: { isReplay: true, path: replay.path },
      gameType: GameType.Melee,
      gameSubType: 0,
      slots,
      host: player,
      seed: header?.seed ?? 0,
      serverUrl: makeServerUrl(''),
    },
  })
}

function setGameRoutes(gameId: string) {
  ipcRenderer.invoke('activeGameSetRoutes', gameId, [])
  ipcRenderer.invoke('activeGameStartWhenReady', gameId)
}

export function startReplay(replay: FileBrowserFileEntry): ThunkAction {
  return (dispatch, getState) => {
    const {
      auth: { user },
    } = getState()

    dispatch({
      type: REPLAYS_START_REPLAY,
      payload: replay,
    } as any)

    // TODO(2Pac): Use the game loader on the server to register watching a replay, so we can show
    // to other people (like their friends) when a user is watching a replay.
    setGameConfig(replay, user).then(
      gameId => {
        if (gameId) {
          setGameRoutes(gameId)
        }
      },
      err => {
        logger.error(`Error starting replay file [${replay.path}]: ${err?.stack ?? err}`)
        dispatch(
          openSimpleDialog(
            'Error loading replay',
            'The selected replay could not be loaded. It may either be corrupt, or was created ' +
              'by a version of StarCraft newer than is currently supported.',
          ),
        )
      },
    )
  }
}

export function startReplayFromPath(path: string): ThunkAction {
  return (dispatch, getState) => {
    const {
      auth: { user },
    } = getState()

    setGameConfig({ path, name: 'Replay' }, user).then(
      gameId => {
        if (gameId) {
          setGameRoutes(gameId)
        }
      },
      err => {
        logger.error(`Error starting replay file [${path}]: ${err?.stack ?? err}`)
        dispatch(
          openSimpleDialog(
            'Error loading replay',
            'The selected replay could not be loaded. It may either be corrupt, or was created ' +
              'by a version of StarCraft newer than is currently supported.',
          ),
        )
      },
    )
  }
}
