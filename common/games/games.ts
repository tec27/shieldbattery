import { TFunction } from 'i18next'
import { Immutable } from 'immer'
import { assertUnreachable } from '../assert-unreachable'
import { Jsonify } from '../json'
import { ClientLeagueUserChangeJson, LeagueJson } from '../leagues'
import { MapInfoJson } from '../maps'
import { matchmakingTypeToLabel, PublicMatchmakingRatingChangeJson } from '../matchmaking'
import { SbUser, SbUserId } from '../users/sb-user'
import { GameConfig, GameSource } from './configuration'
import { ReconciledPlayerResult } from './results'

export interface GameRecord {
  id: string
  startTime: Date
  mapId: string
  config: GameConfig<true>
  disputable: boolean
  disputeRequested: boolean
  disputeReviewed: boolean
  gameLength: number | null
  results: [SbUserId, ReconciledPlayerResult][] | null
}

export type GameRecordJson = Jsonify<GameRecord>

export interface GameRouteDebugInfo {
  p1: SbUserId
  p2: SbUserId
  /** A rally-point server ID. */
  server: number
  /** The estimated latency between the players (1-way) in milliseconds. */
  latency: number
}

export function toGameRecordJson(game: GameRecord): GameRecordJson {
  return {
    id: game.id,
    startTime: Number(game.startTime),
    mapId: game.mapId,
    config: game.config,
    disputable: game.disputable,
    disputeRequested: game.disputeRequested,
    disputeReviewed: game.disputeReviewed,
    gameLength: game.gameLength,
    results: game.results,
  }
}

export function getGameTypeLabel(game: Immutable<GameRecordJson>, t: TFunction): string {
  // TODO(tec27): show mode (UMS, Top v Bottom, etc.?)
  if (game.config.gameSource === GameSource.Lobby) {
    return t('common.gameTypeCustom', 'Custom game')
  } else if (game.config.gameSource === GameSource.Matchmaking) {
    return t('common.gameTypeRanked', {
      defaultValue: `Ranked {{matchmakingType}}`,
      matchmakingType: matchmakingTypeToLabel(game.config.gameSourceExtra.type, t),
    })
  }

  return assertUnreachable(game.config)
}

export interface GetGameResponse {
  game: GameRecordJson
  /** Can be undefined if the map could not be found (e.g. if it has been deleted). */
  map: MapInfoJson | undefined
  users: SbUser[]
  mmrChanges: PublicMatchmakingRatingChangeJson[]
}

/** Events that can be sent when subscribed to changes to a particular game record. */
export type GameSubscriptionEvent = GameRecordUpdate

export interface GameRecordUpdate {
  type: 'update'
  game: GameRecordJson
  mmrChanges: PublicMatchmakingRatingChangeJson[]
}

export interface MatchmakingResultsEvent {
  userId: SbUserId
  game: GameRecordJson
  mmrChange: PublicMatchmakingRatingChangeJson
  leagueChanges: ClientLeagueUserChangeJson[]
  leagues: LeagueJson[]
}

export function getGameDurationString(durationMs: number): string {
  const timeSec = Math.floor(durationMs / 1000)
  const hours = Math.floor(timeSec / 3600)
  const minutes = Math.floor(timeSec / 60) % 60
  const seconds = timeSec % 60

  return [hours, minutes, seconds]
    .map(v => ('' + v).padStart(2, '0'))
    .filter((v, i) => v !== '00' || i > 0)
    .join(':')
}

export type GameLoadEvent =
  | GameLoadStartEvent
  | GameLoadRoutesEvent
  | GameLoadProgressEvent
  | GameLoadCancelEvent

export interface GameLoadStartEvent {
  type: 'start'
  gameConfig: GameConfig
  userInfos: SbUser[]
  resultCode: string
  // FIXME: add routes
}
