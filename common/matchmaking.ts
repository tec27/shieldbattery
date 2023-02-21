import { TFunction } from 'i18next'
import { Opaque, SetRequired } from 'type-fest'
import { assertUnreachable } from './assert-unreachable'
import { binarySearch } from './data-structures/arrays'
import { GameRoute } from './games/games'
import { Jsonify } from './json'
import { Slot } from './lobbies/slot'
import { MapInfoJson } from './maps'
import { BwTurnRate, BwUserLatency } from './network'
import { AssignedRaceChar, RaceChar } from './races'
import { SbUserId } from './users/sb-user'

/**
 * A string representation of each of the matchmaking types that we support.
 */
export enum MatchmakingType {
  Match1v1 = '1v1',
  Match2v2 = '2v2',
}

export const ALL_MATCHMAKING_TYPES: ReadonlyArray<MatchmakingType> = Object.values(MatchmakingType)

// TODO(2Pac): Remove the optionality of the translation function here once all the places this is
// used is updated: https://github.com/ShieldBattery/ShieldBattery/issues/886
export function matchmakingTypeToLabel(type: MatchmakingType, t?: TFunction): string {
  switch (type) {
    case MatchmakingType.Match1v1:
      return t ? t('common.matchmakingType1v1', '1v1') : '1v1'
    case MatchmakingType.Match2v2:
      return t ? t('common.matchmakingType2v2', '2v2') : '2v2'
    default:
      return assertUnreachable(type)
  }
}

/**
 * Divisions that players can place into, based on their MMR.
 *
 * NOTE(tec27): Be careful changing the values of these, they are expected to match image filenames.
 */
export enum MatchmakingDivision {
  Unrated = 'unrated',
  Bronze1 = 'bronze1',
  Bronze2 = 'bronze2',
  Bronze3 = 'bronze3',
  Silver1 = 'silver1',
  Silver2 = 'silver2',
  Silver3 = 'silver3',
  Gold1 = 'gold1',
  Gold2 = 'gold2',
  Gold3 = 'gold3',
  Platinum1 = 'platinum1',
  Platinum2 = 'platinum2',
  Platinum3 = 'platinum3',
  Diamond1 = 'diamond1',
  Diamond2 = 'diamond2',
  Diamond3 = 'diamond3',
  Champion = 'champion',
}

export const ALL_MATCHMAKING_DIVISIONS: ReadonlyArray<MatchmakingDivision> =
  Object.values(MatchmakingDivision)

export type MatchmakingDivisionWithBounds = [
  division: MatchmakingDivision,
  ratingLow: number,
  ratingHigh: number,
]

const DIVISIONS_TO_RATING: ReadonlyArray<MatchmakingDivisionWithBounds> = [
  [MatchmakingDivision.Bronze1, 0, 1040],
  [MatchmakingDivision.Bronze2, 1040, 1120],
  [MatchmakingDivision.Bronze3, 1120, 1200],
  [MatchmakingDivision.Silver1, 1200, 1280],
  [MatchmakingDivision.Silver2, 1280, 1360],
  [MatchmakingDivision.Silver3, 1360, 1440],
  [MatchmakingDivision.Gold1, 1440, 1520],
  [MatchmakingDivision.Gold2, 1520, 1600],
  [MatchmakingDivision.Gold3, 1600, 1680],
  [MatchmakingDivision.Platinum1, 1680, 1760],
  [MatchmakingDivision.Platinum2, 1760, 1840],
  [MatchmakingDivision.Platinum3, 1840, 1920],
  [MatchmakingDivision.Diamond1, 1920, 2000],
  [MatchmakingDivision.Diamond2, 2000, 2080],
  [MatchmakingDivision.Diamond3, 2080, 2400],
  [MatchmakingDivision.Champion, 2400, Infinity],
]

export function matchmakingDivisionToLabel(rank: MatchmakingDivision): string {
  switch (rank) {
    case MatchmakingDivision.Unrated:
      return 'Unrated'
    case MatchmakingDivision.Bronze1:
      return 'Bronze 1'
    case MatchmakingDivision.Bronze2:
      return 'Bronze 2'
    case MatchmakingDivision.Bronze3:
      return 'Bronze 3'
    case MatchmakingDivision.Silver1:
      return 'Silver 1'
    case MatchmakingDivision.Silver2:
      return 'Silver 2'
    case MatchmakingDivision.Silver3:
      return 'Silver 3'
    case MatchmakingDivision.Gold1:
      return 'Gold 1'
    case MatchmakingDivision.Gold2:
      return 'Gold 2'
    case MatchmakingDivision.Gold3:
      return 'Gold 3'
    case MatchmakingDivision.Platinum1:
      return 'Platinum 1'
    case MatchmakingDivision.Platinum2:
      return 'Platinum 2'
    case MatchmakingDivision.Platinum3:
      return 'Platinum 3'
    case MatchmakingDivision.Diamond1:
      return 'Diamond 1'
    case MatchmakingDivision.Diamond2:
      return 'Diamond 2'
    case MatchmakingDivision.Diamond3:
      return 'Diamond 3'
    case MatchmakingDivision.Champion:
      return 'Champion'
    default:
      return assertUnreachable(rank)
  }
}

function binarySearchRating(rating: number): number {
  return binarySearch(DIVISIONS_TO_RATING, rating, ([_, low, high], rating) => {
    if (low > rating) {
      return 1
    } else if (high <= rating) {
      return -1
    } else {
      return 0
    }
  })
}

/** Converts a given rating into a matching `MatchmakingDivision`. */
export function ratingToMatchmakingDivision(rating: number): MatchmakingDivision {
  const index = binarySearchRating(rating)
  return index >= 0 ? DIVISIONS_TO_RATING[index][0] : MatchmakingDivision.Unrated
}

/**
 * Converts a given rating into a matching `MatchmakingDivision` and returns it, as well as the
 * low (inclusive) and high (exclusive) rating bound for the division.
 */
export function ratingToMatchmakingDivisionAndBounds(
  rating: number,
): Readonly<MatchmakingDivisionWithBounds> {
  const index = binarySearchRating(rating)
  return index >= 0 ? DIVISIONS_TO_RATING[index] : [MatchmakingDivision.Unrated, 0, Infinity]
}

/**
 * Retrieves all the relevant divisions for a rating change (that is, if a player goes from
 * Silver 1 to Gold 2, it would return a list of [Silver 1, Silver 2, Silver 3, Gold 1, Gold 2]).
 * The resulting list will be ordered correctly such that the starting division is first, and ending
 * is last.
 */
export function getDivisionsForRatingChange(
  startingRating: number,
  endingRating: number,
): Array<Readonly<MatchmakingDivisionWithBounds>> {
  const startingIndex = binarySearchRating(startingRating)
  const endingIndex = binarySearchRating(endingRating)

  if (startingIndex === -1 && endingIndex === -1) {
    return [[MatchmakingDivision.Unrated, 0, Infinity]]
  } else if (startingIndex === -1) {
    return [[MatchmakingDivision.Unrated, 0, Infinity], DIVISIONS_TO_RATING[endingIndex]]
  } else if (endingIndex === -1) {
    return [[MatchmakingDivision.Unrated, 0, Infinity], DIVISIONS_TO_RATING[startingIndex]]
  }

  if (startingIndex > endingIndex) {
    return DIVISIONS_TO_RATING.slice(endingIndex, startingIndex + 1).reverse()
  } else {
    return DIVISIONS_TO_RATING.slice(startingIndex, endingIndex + 1)
  }
}

export function getDivisionColor(division: MatchmakingDivision) {
  switch (division) {
    case MatchmakingDivision.Bronze1:
    case MatchmakingDivision.Bronze2:
    case MatchmakingDivision.Bronze3:
      return '#BD7956'
    case MatchmakingDivision.Silver1:
    case MatchmakingDivision.Silver2:
    case MatchmakingDivision.Silver3:
      return '#9CA1A3'
    case MatchmakingDivision.Gold1:
    case MatchmakingDivision.Gold2:
    case MatchmakingDivision.Gold3:
      return '#D5BF6D'
    case MatchmakingDivision.Platinum1:
    case MatchmakingDivision.Platinum2:
    case MatchmakingDivision.Platinum3:
      return '#72CBF4'
    case MatchmakingDivision.Diamond1:
    case MatchmakingDivision.Diamond2:
    case MatchmakingDivision.Diamond3:
      return '#B96CED'
    case MatchmakingDivision.Champion:
      return '#F27537'
    case MatchmakingDivision.Unrated:
      return '#87ABCA'
    default:
      return assertUnreachable(division)
  }
}

/**
 * Rating floors to be used to determine if a user is still converging towards their target point
 * total. If they are still converging, they'll receive extra points for each win until they hit
 * the value listed here.
 */
const RATING_CONVERGENCE_BUCKETS: ReadonlyArray<[minRating: number, extraPoints: number]> = [
  [960, 100],
  [1200, 150],
  [1440, 200],
  [1680, 250],
  [1920, 300],
]

function getRatingConvergenceBucket(rating: number) {
  let index = 0
  for (
    ;
    index < RATING_CONVERGENCE_BUCKETS.length - 1 &&
    RATING_CONVERGENCE_BUCKETS[index + 1][0] <= rating;
    index++
  ) {
    // This space intentionally left blank
  }
  return RATING_CONVERGENCE_BUCKETS[index]
}

export function getConvergencePoints(rating: number): number {
  const [_, extraPoints] = getRatingConvergenceBucket(rating)
  return extraPoints
}

export function arePointsConverged(rating: number, points: number): boolean {
  const [minRating, _] = getRatingConvergenceBucket(rating)
  return points >= minRating * 4
}

/** How many matches a user must play before we calculate a division for them. */
export const NUM_PLACEMENT_MATCHES = 5

export type SeasonId = Opaque<number, 'SeasonId'>

/**
 * Converts a season ID number into a properly typed version. Alternative methods of retrieving a
 * SeasonId should be preferred, such as using a value retrieved rom the database.
 */
export function makeSeasonId(id: number): SeasonId {
  return id as SeasonId
}

export interface MatchmakingSeason {
  id: SeasonId
  startDate: Date
  name: string
  resetMmr: boolean
}

export type MatchmakingSeasonJson = Jsonify<MatchmakingSeason>

export function toMatchmakingSeasonJson(season: MatchmakingSeason): MatchmakingSeasonJson {
  return {
    id: season.id,
    startDate: Number(season.startDate),
    name: season.name,
    resetMmr: season.resetMmr,
  }
}

/**
 * The amount of bonus points accrued per millisecond since the start of a season. Bonus points are
 * used to improve wins and offset losses, until the bonus pool has been exhausted.
 */
export const MATCHMAKING_BONUS_EARNED_PER_MS = 200 / (7 * 24 * 60 * 60 * 1000) // 200 per week

/**
 * A Record of MatchmakingType -> the size of a team within a match.
 */
export const TEAM_SIZES: Readonly<Record<MatchmakingType, number>> = {
  [MatchmakingType.Match1v1]: 1,
  [MatchmakingType.Match2v2]: 2,
}

export function isValidMatchmakingType(type: string) {
  return Object.values(MatchmakingType).includes(type as MatchmakingType)
}

/** The time period after which a user who has played no games will be considered "inactive". */
export const MATCHMAKING_INACTIVE_TIME_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

/**
 * Returns whether a player was considered inactive by the system given the last time they played a
 * game and the time of a new game.
 */
export function wasPlayerInactive(lastPlayedDate: Date, gameDate: Date): boolean {
  return Number(lastPlayedDate) > 0
    ? Number(gameDate) - Number(lastPlayedDate) >= MATCHMAKING_INACTIVE_TIME_MS
    : false
}

/** How long users have to accept a match, in milliseconds. */
export const MATCHMAKING_ACCEPT_MATCH_TIME_MS = 30000

/**
 * Describes a player in the matchmaking. This only includes information that are relevant and safe
 * to send to other players in the matchmaking.
 */
export interface MatchmakingPlayer {
  id: number
  // TODO(2Pac): Don't send `name` and instead get it from the store
  name: string
  race: RaceChar
  rating: number
}

export type MatchmakingResult = 'loss' | 'win'

/**
 * The change that occurred to a player's matchmaking rating as a result of a game. This only
 * contains fields that can be publicly visible (keeping internal factors hidden).
 */
export interface PublicMatchmakingRatingChange {
  userId: SbUserId
  matchmakingType: MatchmakingType
  gameId: string
  /**
   * When the change occurred (this is when the game was reconciled, not necessarily when it was
   * played or finished).
   */
  changeDate: Date
  outcome: MatchmakingResult
  /** The player's rating after this game. If the user is in placement matches, this will be 0. */
  rating: number
  /** The delta between the user's old rating and their new rating. */
  ratingChange: number
  /** The player's ranked points after this game. */
  points: number
  /** The delta between the user's old points and their new points. */
  pointsChange: number
  /** The amount of bonus points this user has used this season. */
  bonusUsed: number
  /** The amount of bonus points used for this game. */
  bonusUsedChange: number
  /** The number of games this user has played since the last MMR reset. */
  lifetimeGames: number
}

export type PublicMatchmakingRatingChangeJson = Jsonify<PublicMatchmakingRatingChange>

export function toPublicMatchmakingRatingChangeJson(
  input: Readonly<PublicMatchmakingRatingChange>,
): PublicMatchmakingRatingChangeJson {
  const inPlacements = input.lifetimeGames < NUM_PLACEMENT_MATCHES

  return {
    userId: input.userId,
    matchmakingType: input.matchmakingType,
    gameId: input.gameId,
    changeDate: Number(input.changeDate),
    outcome: input.outcome,
    rating: inPlacements ? 0 : input.rating,
    ratingChange: inPlacements ? 0 : input.ratingChange,
    points: input.points,
    pointsChange: input.pointsChange,
    bonusUsed: input.bonusUsed,
    bonusUsedChange: input.bonusUsedChange,
    lifetimeGames: input.lifetimeGames,
  }
}

/**
 * The body data of the API route for adding new matchmaking times.
 */
export interface AddMatchmakingTimeBody {
  /**
   * The start date of the new matchmaking time. As with the JavaScript's `Date` object, the number
   * should represent the amount of milliseconds since January 1st 1970 UTC. No automatic time zone
   * conversions are done on the server side. Similarly, daylight savings time is also not accounted
   * for and should be dealt with manually.
   */
  startDate: number
  /** A boolean flag indicating whether the matchmaking is enabled or not. */
  enabled: boolean
}

/**
 * Describes a map pool that is used in a matchmaking.
 */
export interface MatchmakingMapPool {
  id: number
  type: MatchmakingType
  startDate: Date
  maps: string[]
}

export type MatchmakingMapPoolJson = Jsonify<MatchmakingMapPool>

export function fromMatchmakingMapPoolJson(pool: MatchmakingMapPoolJson): MatchmakingMapPool {
  return {
    id: pool.id,
    type: pool.type,
    startDate: new Date(pool.startDate),
    maps: pool.maps,
  }
}

export interface GetMatchmakingMapPoolBody {
  pool: MatchmakingMapPoolJson
  mapInfos: MapInfoJson[]
}

export interface MatchmakingPreferencesData1v1 {
  /**
   * A flag indicating whether the user has selected to use the alternate race in mirror matchups.
   */
  useAlternateRace?: boolean
  /** The race the user has selected to use in mirror matchups. */
  alternateRace?: AssignedRaceChar
}

interface BaseMatchmakingPreferences<T extends MatchmakingType, D> {
  userId: SbUserId
  matchmakingType: T
  /** The main race the user has selected to play in the matchmaking with. */
  race: RaceChar
  /**
   * The ID of the map pool that will be used in the matchmaking. The way in which this map pool
   * will be used depends on the matchmaking type, as each matchmaking type can create its own rules
   * in which to use it (e.g. preferred maps, map vetoes, etc.). This can also be used to determine
   * if the map pool has changed.
   */
  mapPoolId: number
  /**
   * An array of map IDs that the user has selected through a map selection process. The meaning
   * of this selection depends on the matchmaking type and the system it's using. E.g. 1v1/2v2 might
   * use this list as maps the user has vetoed, while in 3v3 it might be used as as a list of maps
   * that the user wants to queue on.
   */
  mapSelections: string[]
  data: D
}

export type MatchmakingPreferences1v1 = BaseMatchmakingPreferences<
  MatchmakingType.Match1v1,
  MatchmakingPreferencesData1v1
>

export type MatchmakingPreferences2v2 = BaseMatchmakingPreferences<
  MatchmakingType.Match2v2,
  Record<string, never>
>

/**
 * Describes a user's preferences for finding a match in matchmaking. Each matchmaking type can have
 * its own custom data, with `race`, `mapPoolId`, and `mapSelections` being common among all
 * matchmaking types.
 */
export type MatchmakingPreferences = MatchmakingPreferences1v1 | MatchmakingPreferences2v2

export type PartialMatchmakingPreferences = SetRequired<
  Partial<MatchmakingPreferences>,
  'matchmakingType' | 'userId'
>

export type MatchmakingPreferencesOfType<M extends MatchmakingType> = MatchmakingPreferences & {
  matchmakingType: M
}

export type PreferenceData = MatchmakingPreferences['data']

export function defaultPreferenceData<M extends MatchmakingType>(
  matchmakingType: M,
): MatchmakingPreferencesOfType<M>['data'] {
  switch (matchmakingType) {
    case MatchmakingType.Match1v1:
      return {
        useAlternateRace: false,
        alternateRace: 'z',
      }
    case MatchmakingType.Match2v2:
      return {}
    default:
      return assertUnreachable(matchmakingType)
  }
}

export function defaultPreferences<M extends MatchmakingType>(
  matchmakingType: M,
  userId: SbUserId,
  mapPoolId = 1,
): MatchmakingPreferencesOfType<M> {
  return {
    userId,
    matchmakingType: matchmakingType as any,
    race: 'r',
    mapPoolId,
    mapSelections: [] as string[],
    data: defaultPreferenceData<M>(matchmakingType),
  }
}

export interface GetPreferencesResponse {
  preferences: MatchmakingPreferences | Record<string, never>
  mapPoolOutdated: boolean
  currentMapPoolId: number
  mapInfos: MapInfoJson[]
}

export interface StartSearchEvent {
  type: 'startSearch'
  matchmakingType: MatchmakingType
  race: RaceChar
}

export interface MatchFoundEvent {
  type: 'matchFound'
  matchmakingType: MatchmakingType
  numPlayers: number
}

export interface PlayerAcceptedEvent {
  type: 'playerAccepted'
  /** A number of players that have currently accepted the match. */
  acceptedPlayers: number
}

export interface AcceptTimeoutEvent {
  type: 'acceptTimeout'
}

export interface RequeueEvent {
  type: 'requeue'
}

export interface MatchReadyEvent {
  type: 'matchReady'
  matchmakingType: MatchmakingType
  setup: { gameId: string; seed: number; turnRate?: BwTurnRate | 0; userLatency?: BwUserLatency }
  resultCode?: string
  // TODO(tec27): This is not a correct type, this cannot be a Record, it's deserialized from JSON
  slots: Slot[]
  players: MatchmakingPlayer[]
  chosenMap: MapInfoJson
}

export interface SetRoutesEvent {
  type: 'setRoutes'
  routes: GameRoute[]
  gameId: string
}

export interface StartCountdownEvent {
  type: 'startCountdown'
}

export interface StartWhenReadyEvent {
  type: 'startWhenReady'
  gameId: string
}

export interface CancelLoadingEvent {
  type: 'cancelLoading'
  reason: string
}

export interface GameStartedEvent {
  type: 'gameStarted'
}

export interface QueueStatusEvent {
  type: 'queueStatus'
  /**
   * Indicates what type of matchmaking this user is currently queued for, or `undefined` if they
   * are not queued for anything.
   */
  matchmaking?: { type: MatchmakingType }
}

export type MatchmakingEvent =
  | StartSearchEvent
  | MatchFoundEvent
  | PlayerAcceptedEvent
  | AcceptTimeoutEvent
  | RequeueEvent
  | MatchReadyEvent
  | SetRoutesEvent
  | StartCountdownEvent
  | StartWhenReadyEvent
  | CancelLoadingEvent
  | GameStartedEvent
  | QueueStatusEvent

/**
 * Describes the current status (enabled/disabled) of a particular MatchmakingType on the server.
 */
export interface MatchmakingStatus {
  type: MatchmakingType
  enabled: boolean
  startDate?: Date
  nextStartDate?: Date
  nextEndDate?: Date
}

/** Compares two MatchmakingStatus objects for equality. */
export function statusesEqual(a?: MatchmakingStatus, b?: MatchmakingStatus): boolean {
  if (a === b) {
    return true
  } else if (a === undefined || b === undefined) {
    return false
  } else {
    return (
      a.type === b.type &&
      a.enabled === b.enabled &&
      a.startDate === b.startDate &&
      a.nextStartDate === b.nextStartDate &&
      a.nextEndDate === b.nextEndDate
    )
  }
}

export type MatchmakingStatusJson = Jsonify<MatchmakingStatus>

export function toMatchmakingStatusJson(status: MatchmakingStatus): MatchmakingStatusJson {
  return {
    type: status.type,
    enabled: status.enabled,
    startDate: status.startDate ? Number(status.startDate) : undefined,
    nextStartDate: status.nextStartDate ? Number(status.nextStartDate) : undefined,
    nextEndDate: status.nextEndDate ? Number(status.nextEndDate) : undefined,
  }
}

export function fromMatchmakingStatusJson(status: MatchmakingStatusJson): MatchmakingStatus {
  return {
    type: status.type,
    enabled: status.enabled,
    startDate: status.startDate ? new Date(status.startDate) : undefined,
    nextStartDate: status.nextStartDate ? new Date(status.nextStartDate) : undefined,
    nextEndDate: status.nextEndDate ? new Date(status.nextEndDate) : undefined,
  }
}

/**
 * An event sent by the MatchmakingStatusService to describe the status of MatchmakingTypes on
 * the server. Sent both to initialize all the statuses, as well as for updates to particular types.
 */
export type MatchmakingStatusUpdateEvent = MatchmakingStatusJson[]

/** Describes how a user completed matchmaking (i.e. how their search process was terminated). */
export enum MatchmakingCompletionType {
  /** The user completed matchmaking by finding a match. */
  Found = 'found',
  /** The user completed matchmaking by canceling out of the search process. */
  Cancel = 'cancel',
  /** The user completed matchmaking by disconnecting from the server. */
  Disconnect = 'disconnect',
}

/** A record of a terminated matchmaking search. */
export interface MatchmakingCompletion {
  id: string
  userId: SbUserId
  matchmakingType: MatchmakingType
  completionType: MatchmakingCompletionType
  searchTimeMillis: number
  completionTime: Date
}

export enum MatchmakingServiceErrorCode {
  ClientDisconnected = 'clientDisconnected',
  GameplayConflict = 'gameplayConflict',
  InParty = 'inParty',
  InvalidClient = 'invalidClient',
  InvalidMapPool = 'invalidMapPool',
  InvalidMaps = 'invalidMaps',
  MatchAlreadyStarting = 'matchAlreadyStarting',
  MatchmakingDisabled = 'matchmakingDisabled',
  NotInQueue = 'notInQueue',
  NoActiveMatch = 'noActiveMatch',
  TooManyPlayers = 'tooManyPlayers',
  UserOffline = 'userOffline',
}

export interface FindMatchRequest {
  clientId: string
  preferences: MatchmakingPreferences
  identifiers: [type: number, hashStr: string][]
}

export enum MatchmakingSeasonsServiceErrorCode {
  MustBeInFuture = 'mustBeInFuture',
  NotFound = 'notFound',
}

export interface GetMatchmakingSeasonsResponse {
  seasons: MatchmakingSeasonJson[]
  current: SeasonId
}

export type ServerAddMatchmakingSeasonRequest = Omit<MatchmakingSeason, 'id'>

export type AddMatchmakingSeasonRequest = Jsonify<ServerAddMatchmakingSeasonRequest>

export interface AddMatchmakingSeasonResponse {
  season: MatchmakingSeasonJson
}

export interface GetCurrentMatchmakingSeasonResponse {
  season: MatchmakingSeasonJson
}
