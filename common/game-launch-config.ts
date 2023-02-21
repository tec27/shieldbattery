import { GameType } from './games/configuration'
import { SlotType } from './lobbies/slot'
import { MapInfoJson } from './maps'
import { BwTurnRate, BwUserLatency } from './network'
import { RaceChar } from './races'
import { SbUser, SbUserId } from './users/sb-user'

/**
 * Configuration for a particular player in a game. This is similar to Lobby's `Slot` structure,
 * but has been flattened slightly to remove the need to send info about teams.
 */
export interface PlayerInfo {
  /** The name of the player in this slot (e.g. their username). */
  name: string
  /** The race set for this slot. */
  race?: RaceChar
  /** The BW player ID for this slot (a number between 0 and 7). */
  playerId?: number
  /** The ID of the team this slot is a part of. */
  teamId: number
  /** The type of this slot. */
  type: SlotType
  /** The BW id of the type of this slot. */
  typeId: number
  /** Shieldbattery user ID of the player. Only set for 'human' and 'observer' */
  userId?: SbUserId
}

export interface ReplayMapInfo {
  isReplay: true
  path: string
}

export function isReplayLaunchConfig(config: GameLaunchConfig) {
  return isReplayMapInfo(config.setup.map)
}

export function isReplayMapInfo(map: MapInfoJson | ReplayMapInfo): map is ReplayMapInfo {
  return (map as ReplayMapInfo).isReplay
}

/** Configuration info for launching a local game client to play a specific game. */
export interface GameLaunchConfig {
  /** The user currently logged into the application and playing the game. */
  localUser: SbUser
  /** Setup configuration for the game, such as the map, game type, etc. */
  setup: {
    /**
     * The id of the game, used by the server to identify it for sending commands and receiving
     * results.
     */
    gameId: string
    /**
     * The name of the game. Not really that important generally, as we don't display this directly
     * to users.
     */
    name: string
    map: MapInfoJson | ReplayMapInfo
    /**
     * The file path of the map file. Note that this gets set during the launch process, it's not
     * provided directly by the code that triggers the launch.
     * TODO(tec27): make it provided directly instead?
     */
    mapPath?: string
    gameType: GameType
    gameSubType: number
    slots: PlayerInfo[]
    host: PlayerInfo
    /**
     * Whether changing allies during the game is disabled. Optional, defaults to false (i.e. use
     * the default for the game mode). */
    disableAllianceChanges?: boolean
    /**
     * Turn rate for the game. 0 means dynamic, other values mean N turns per second. If not
     * provided, defaults to dynamic.
     */
    turnRate?: BwTurnRate | 0
    /**
     * The initial user latency setting to use. If not set, will default to Low.
     */
    userLatency?: BwUserLatency
    seed: number
    /**
     * The code used to submit results for this game to the server. This is secret and unique per
     * player in the game. In certain cases (when observing, or when watching a replay), a result
     * code may not be given, meaning no result is to be reported.
     */
    resultCode?: string
    /** The URL of the server, so that the game client can communicate with it as necessary. */
    serverUrl: string
  }
}
