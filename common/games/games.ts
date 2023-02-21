import { TFunction } from 'i18next'
import { Immutable } from 'immer'
import { assertUnreachable } from '../assert-unreachable'
import { Jsonify } from '../json'
import { ClientLeagueUserChangeJson, LeagueJson } from '../leagues'
import { MapInfoJson } from '../maps'
import { matchmakingTypeToLabel, PublicMatchmakingRatingChangeJson } from '../matchmaking'
import { ResolvedRallyPointServer } from '../rally-point'
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

/** A network route configuration for communication between two players in a game. */
export interface GameRoute {
  /** The user ID of the player who will be connected to over this network route. */
  for: SbUserId
  /** The rally-point server to connect to for this route. */
  server: ResolvedRallyPointServer
  /** The ID of the route, used to identify it to the rally-point server. */
  routeId: string
  /** The ID of the local player, used to identify themselves to the rally-point server. */
  playerId: number
}

export type GameLoadEvent =
  | GameLoadBeginEvent
  | GameLoadRoutesEvent
  | GameLoadProgressEvent
  | GameLoadCancelEvent
  | GameLoadCountdownEvent
  | GameLoadCompleteEvent

/**
 * Websocket event signaling a new game is loading (or a new client has connected to the server when
 * a game load was in progress).
 */
export interface GameLoadBeginEvent {
  type: 'begin'
  id: string
  gameConfig: GameConfig
  userInfos: SbUser[]
  resultCode: string
  routes?: GameRoute[]
}

/**
 * Websocket event signaling that rally-point routes have been assigned for a game.
 */
export interface GameLoadRoutesEvent {
  type: 'routes'
  id: string
  routes: GameRoute[]
}

// TODO(tec27): Is this actually useful?
/** Websocket event signaling that one or more users' load progress has changed. */
export interface GameLoadProgressEvent {
  type: 'progress'
  id: string
  completed: SbUserId[]
}

/**
 * Websocket event signaling that a particular loading game was canceled and any associated
 * resources should be cleaned up (e.g. the game process should be closed).
 */
export interface GameLoadCancelEvent {
  type: 'cancel'
  id: string
}

/**
 * Websocket event signaling that a loading game is about to start, and clients should show a
 * countdown.
 */
export interface GameLoadCountdownEvent {
  type: 'countdown'
  id: string
}

/**
 * Websocket event signaling that a game has fully loaded (and can be shown to the user).
 */
export interface GameLoadCompleteEvent {
  type: 'complete'
  id: string
}
