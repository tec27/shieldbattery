import { TFunction } from 'i18next'
import { Immutable } from 'immer'
import { assertUnreachable } from './assert-unreachable'
import { GameType } from './games/configuration'
import { Jsonify } from './json'
import { RaceChar } from './races'

export enum Tileset {
  // NOTE(tec27): These are ordered to match their int values ingame
  Badlands = 0,
  Platform,
  Installation,
  Ashworld,
  Jungle,
  Desert,
  Ice,
  Twilight,
}

export const ALL_TILESETS: ReadonlyArray<Tileset> = [
  Tileset.Badlands,
  Tileset.Platform,
  Tileset.Installation,
  Tileset.Ashworld,
  Tileset.Jungle,
  Tileset.Desert,
  Tileset.Ice,
  Tileset.Twilight,
]

export function tilesetToName(tileset: Tileset, t: TFunction) {
  switch (tileset) {
    case Tileset.Badlands:
      return t('maps.tileset.badlands', 'Badlands')
    case Tileset.Platform:
      return t('maps.tileset.spacePlatform', 'Space platform')
    case Tileset.Installation:
      return t('maps.tileset.installation', 'Installation')
    case Tileset.Ashworld:
      return t('maps.tileset.ashworld', 'Ashworld')
    case Tileset.Jungle:
      return t('maps.tileset.jungleWorld', 'Jungle world')
    case Tileset.Desert:
      return t('maps.tileset.desert', 'Desert')
    case Tileset.Ice:
      return t('maps.tileset.ice', 'Ice')
    case Tileset.Twilight:
      return t('maps.tileset.twilight', 'Twilight')
    default:
      return assertUnreachable(tileset)
  }
}

export enum MapSortType {
  Name = 0,
  NumberOfPlayers = 1,
  Date = 2,
}
export const ALL_MAP_SORT_TYPES: Readonly<MapSortType[]> = [
  MapSortType.Name,
  MapSortType.NumberOfPlayers,
  MapSortType.Date,
]

export enum MapVisibility {
  Private = 'PRIVATE',
  Public = 'PUBLIC',
  Official = 'OFFICIAL',
}
export const ALL_MAP_VISIBILITIES: Readonly<MapVisibility[]> = Object.values(MapVisibility)

export type NumPlayers = 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface MapFilters {
  numPlayers: NumPlayers[]
  tileset: Tileset[]
}

export type MapExtension = 'scx' | 'scm'
export const ALL_MAP_EXTENSIONS: Readonly<MapExtension[]> = ['scx', 'scm']

export interface MapPreferences {
  // TODO(2Pac): This should probably not be a part of map preferences, but instead should be a part
  // of user's session, similar to the `lastQueuedMatchmakingType` used by the find-match overlay.
  visibility: MapVisibility
  // TODO(2Pac): This can probably be typed even further
  thumbnailSize: number
  sortOption: MapSortType
  numPlayersFilter: NumPlayers[]
  tilesetFilter: Tileset[]
}

export interface MapForcePlayer {
  id: number
  race: 'any' | RaceChar
  // TODO(tec27): Make an enum for these types
  typeId: number
  computer: boolean
}

export interface MapForce {
  name: string
  teamId: number
  players: MapForcePlayer[]
}

export interface MapData {
  format: MapExtension
  tileset: Tileset
  originalName: string
  originalDescription: string
  slots: number
  umsSlots: number
  umsForces: MapForce[]
  width: number
  height: number
  isEud: boolean
  parserVersion: number
}

export interface MapInfo {
  id: string
  hash: string
  name: string
  description: string
  // TODO(tec27): Just pass back the user ID in here, let our typical user pattern handle converting
  // that to a name and such
  uploadedBy: {
    id: number
    name: string
  }
  uploadDate: Date
  visibility: MapVisibility
  mapData: MapData
  mapUrl?: string
  image256Url?: string
  image512Url?: string
  image1024Url?: string
  image2048Url?: string
  imageVersion: number

  // TODO(tec27): Remove this from this structure, as it makes query responses user-specific in a
  // bad way
  isFavorited: boolean
}

export type MapInfoJson = Jsonify<MapInfo>

export function toMapInfoJson(mapInfo: MapInfo): MapInfoJson {
  return {
    ...mapInfo,
    uploadDate: Number(mapInfo.uploadDate),
  }
}

/** Returns the number of teams for a map/game type. */
export function numTeams(
  gameType: GameType,
  gameSubType: number,
  umsForces: Immutable<MapForce[]>,
): number {
  switch (gameType) {
    case GameType.Melee:
    case GameType.FreeForAll:
    case GameType.OneVsOne:
      return 1
    case GameType.TopVsBottom:
      return 2
    case GameType.TeamMelee:
    case GameType.TeamFreeForAll:
      return gameSubType
    case GameType.UseMapSettings:
      return umsForces.length
    default:
      return assertUnreachable(gameType)
  }
}

/**
 * Returns a list of labels for each of the teams for a map/game type. List will be empty if there
 * aren't any teams.
 */
export function getTeamNames(
  {
    gameType,
    gameSubType,
    umsForces,
  }: {
    gameType: GameType
    gameSubType: number
    umsForces: Immutable<MapForce[]>
  },
  t?: TFunction,
): string[] {
  switch (gameType) {
    case GameType.Melee:
    case GameType.FreeForAll:
    case GameType.OneVsOne:
      return []
    case GameType.TopVsBottom:
      return [
        t ? t('game.teamName.top', 'Top') : 'Top',
        t ? t('game.teamName.bottom', 'Bottom') : 'Bottom',
      ]
    case GameType.TeamMelee:
    case GameType.TeamFreeForAll: {
      const teamNames = []
      const amount = numTeams(gameType, gameSubType, umsForces)
      for (let i = 1; i <= amount; i++) {
        teamNames.push(
          t
            ? t('game.teamName.number', {
                defaultValue: 'Team {{teamNumber}}',
                teamNumber: i,
              })
            : `Team ${i}`,
        )
      }
      return teamNames
    }
    case GameType.UseMapSettings:
      return umsForces.map(f => f.name)
    default:
      return assertUnreachable(gameType)
  }
}

/**
 * Filters out unprintable characters used for color codes in BW (we don't utilize these in our
 * client, and they just show up as tofu).
 */
export function filterColorCodes(str: string): string {
  return Array.from(str)
    .filter(c => {
      const code = c.charCodeAt(0)
      return (
        code > 0x1f ||
        /** newline */
        code === 0x0a ||
        /** carriage return */
        code === 0x0d
      )
    })
    .join('')
}

export interface UploadMapResponse {
  map: MapInfoJson
}

export interface GetMapsResponse {
  maps: MapInfoJson[]
  favoritedMaps: MapInfoJson[]
  total: number
}

export interface GetMapDetailsResponse {
  map: MapInfoJson
}

export interface GetBatchMapInfoResponse {
  maps: MapInfoJson[]
}

export interface UpdateMapServerRequest {
  mapId: string
  name: string
  description: string
}

export interface UpdateMapResponse {
  map: MapInfoJson
}
