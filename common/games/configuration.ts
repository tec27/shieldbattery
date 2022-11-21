import { SetOptional } from 'type-fest'
import { assertUnreachable } from '../assert-unreachable'
import { MatchmakingType } from '../matchmaking'
import { RaceChar } from '../races'
import { SbUserId } from '../users/sb-user'

export enum GameSource {
  Lobby = 'LOBBY',
  Matchmaking = 'MATCHMAKING',
}

export const ALL_GAME_SOURCES: ReadonlyArray<GameSource> = Object.values(GameSource)

export enum GameType {
  Melee = 'melee',
  FreeForAll = 'ffa',
  OneVsOne = 'oneVOne',
  TopVsBottom = 'topVBottom',
  TeamMelee = 'teamMelee',
  TeamFreeForAll = 'teamFfa',
  UseMapSettings = 'ums',
}
export const ALL_GAME_TYPES: ReadonlyArray<GameType> = Object.values(GameType)

export function isValidGameType(type: string): boolean {
  return ALL_GAME_TYPES.includes(type as GameType)
}

export function isValidGameSubType(type?: number | null): boolean {
  return type === null || type === undefined || (type >= 1 && type <= 7)
}

export function gameTypeToLabel(gameType: GameType): string {
  switch (gameType) {
    case GameType.Melee:
      return 'Melee'
    case GameType.FreeForAll:
      return 'Free for all'
    case GameType.TopVsBottom:
      return 'Top vs bottom'
    case GameType.TeamMelee:
      return 'Team melee'
    case GameType.TeamFreeForAll:
      return 'Team free for all'
    case GameType.UseMapSettings:
      return 'Use map settings'
    case GameType.OneVsOne:
      return 'One on one'
    default:
      return assertUnreachable(gameType)
  }
}

/**
 * Checks if the given `gameType` is a "team" type, meaning that a user can select the configuration
 * of the slots when creating a lobby, and the slots will be divided into different teams with
 * labels.
 */
export function isTeamType(gameType: GameType): boolean {
  switch (gameType) {
    case GameType.Melee:
      return false
    case GameType.FreeForAll:
      return false
    case GameType.OneVsOne:
      return false
    case GameType.UseMapSettings:
      return false
    case GameType.TeamMelee:
      return true
    case GameType.TeamFreeForAll:
      return true
    case GameType.TopVsBottom:
      return true
    default:
      return assertUnreachable(gameType)
  }
}

export interface GameConfigPlayer {
  id: SbUserId
  race: RaceChar
  isComputer: boolean
  /**
   * The number of the player's slot (also referred to as BW's Player ID), between 0 and 7. This was
   * not included in earlier versions of the data, and so may not be present on entries retrieved
   * from the database.
   *
   * @see LegacyGameConfigPlayer
   */
  slotNumber: number
}

export interface LegacyGameConfigPlayer {
  id: SbUserId
  race: RaceChar
  isComputer: boolean
}

export type PossiblyLegacyGameConfigPlayer = GameConfigPlayer | LegacyGameConfigPlayer

interface BaseGameConfig<Source extends GameSource, SourceExtra, UseLegacy extends boolean> {
  gameSource: Source
  gameSourceExtra: SourceExtra
  gameType: GameType
  gameSubType: number
  teams: UseLegacy extends false ? GameConfigPlayer[][] : PossiblyLegacyGameConfigPlayer[][]
}

export type LobbyGameConfig<PossiblyLegacy extends boolean = false> = SetOptional<
  BaseGameConfig<GameSource.Lobby, undefined, PossiblyLegacy>,
  'gameSourceExtra'
>

export interface MatchmakingExtra1v1 {
  type: MatchmakingType.Match1v1
}

export interface MatchmakingExtra2v2 {
  type: MatchmakingType.Match2v2
  /**
   * The user IDs of players in the match, grouped into lists by party. Players not in a party
   * will be in a list by themselves.
   */
  parties: SbUserId[][]
}

export type MatchmakingExtra = MatchmakingExtra1v1 | MatchmakingExtra2v2

export type MatchmakingGameConfig<PossiblyLegacy extends boolean = false> = BaseGameConfig<
  GameSource.Matchmaking,
  MatchmakingExtra,
  PossiblyLegacy
>

export type GameConfig<PossiblyLegacy extends boolean = false> =
  | LobbyGameConfig<PossiblyLegacy>
  | MatchmakingGameConfig<PossiblyLegacy>

/** Returns the type of the `gameSourceExtra` param for a given `GameSource` type. */
export type GameSourceExtraType<Source extends GameSource> = (GameConfig & {
  gameSource: Source
})['gameSourceExtra']
