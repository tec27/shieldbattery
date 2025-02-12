import { ReadonlyDeep } from 'type-fest'
import {
  GetBatchMapInfoResponse,
  GetMapDetailsResponse,
  GetMapsResponse,
  MapInfoJson,
  MapPreferences,
  MapSortType,
  MapVisibility,
  NumPlayers,
  Tileset,
  UpdateMapResponse,
  UpdateMapServerRequest,
  UploadMapResponse,
} from '../../common/maps'
import { BaseFetchFailure } from '../network/fetch-errors'

export type MapsActions =
  | UploadLocalMapBegin
  | UploadLocalMapSuccess
  | UploadLocalMapFailure
  | GetMapsBegin
  | GetMapsSuccess
  | GetMapsFailure
  | ToggleFavoriteMapBegin
  | ToggleFavoriteMapSuccess
  | ToggleFavoriteMapFailure
  | RemoveMapBegin
  | RemoveMapSuccess
  | RemoveMapFailure
  | RegenMapImageBegin
  | RegenMapImageSuccess
  | RegenMapImageFailure
  | ClearMaps
  | GetMapDetailsBegin
  | GetMapDetailsSuccess
  | GetMapDetailsFailure
  | UpdateMapBegin
  | UpdateMapSuccess
  | UpdateMapFailure
  | GetMapPreferencesBegin
  | GetMapPreferencesSuccess
  | GetMapPreferencesFailure
  | UpdateMapPreferencesBegin
  | UpdateMapPreferencesSuccess
  | UpdateMapPreferencesFailure
  | GetBatchMapInfoSuccess
  | GetBatchMapInfoFailure

/**
 * A request is being made to the server to upload a local map.
 */
export interface UploadLocalMapBegin {
  type: '@maps/uploadLocalMapBegin'
  payload: {
    path: string
  }
}

/**
 * The server has returned the map that was uploaded.
 */
export interface UploadLocalMapSuccess {
  type: '@maps/uploadLocalMap'
  payload: UploadMapResponse
  error?: false
  meta: {
    path: string
  }
}

/**
 * A request to upload a local map has failed.
 */
export interface UploadLocalMapFailure extends BaseFetchFailure<'@maps/uploadLocalMap'> {
  meta: {
    path: string
  }
}

export interface GetMapsListParams {
  visibility: MapVisibility
  limit: number
  page: number
  sort: MapSortType
  numPlayers: NumPlayers[]
  tileset: Tileset[]
  searchQuery: string
}

/**
 * A request is being made to the server to retrieve the list of maps with a particular visibility
 * and other filters.
 */
export interface GetMapsBegin {
  type: '@maps/getMapsBegin'
  payload: GetMapsListParams
}

/**
 * The server has returned the list of maps with a particular visibility and other filters applied.
 */
export interface GetMapsSuccess {
  type: '@maps/getMaps'
  payload: GetMapsResponse
  error?: false
  meta: GetMapsListParams
}

/**
 * A request to get the list of maps has failed.
 */
export interface GetMapsFailure extends BaseFetchFailure<'@maps/getMaps'> {
  meta: GetMapsListParams
}

/**
 * The server returned a response to our request for map info about one or more maps.
 */
export interface GetBatchMapInfoSuccess {
  type: '@maps/getBatchMapInfo'
  payload: GetBatchMapInfoResponse
  error?: false
}

export type GetBatchMapInfoFailure = BaseFetchFailure<'@maps/getBatchMapInfo'>

/**
 * A request is being made to the server to toggle the favorite status of a map.
 */
export interface ToggleFavoriteMapBegin {
  type: '@maps/toggleFavoriteBegin'
  payload: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * The server has returned a status indicating that the favorite status of a map was successfully
 * toggled.
 */
export interface ToggleFavoriteMapSuccess {
  type: '@maps/toggleFavorite'
  payload: void
  error?: false
  meta: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * A request to toggle the favorite status of a map has failed.
 */
export interface ToggleFavoriteMapFailure extends BaseFetchFailure<'@maps/toggleFavorite'> {
  meta: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * A request is being made to the server to remove a map. Map admins can remove all maps, while a
 * regular user can only remove their own private maps. This is a soft-delete.
 */
export interface RemoveMapBegin {
  type: '@maps/removeMapBegin'
  payload: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * The server has returned a status indicating that the map was successfully removed.
 */
export interface RemoveMapSuccess {
  type: '@maps/removeMap'
  payload: void
  error?: false
  meta: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * A request to remove the map has failed.
 */
export interface RemoveMapFailure extends BaseFetchFailure<'@maps/removeMap'> {
  meta: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * A request is being made to the server to regenerate a map image.
 */
export interface RegenMapImageBegin {
  type: '@maps/regenMapImageBegin'
  payload: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * The server has returned a status indicating that the map image was successfully regenerated.
 */
export interface RegenMapImageSuccess {
  type: '@maps/regenMapImage'
  payload: void
  error?: false
  meta: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

/**
 * A request to regenerate the map image has failed.
 */
export interface RegenMapImageFailure extends BaseFetchFailure<'@maps/regenMapImage'> {
  meta: {
    map: ReadonlyDeep<MapInfoJson>
  }
}

// TODO(2Pac): This action is probably ill-advised and should be removed, if possible. Currently the
// maps-reducer only holds maps used by the maps browser, so this action was a convenient way to
// quickly clear all the maps from it. However, soon we're gonna start using the maps-reducer for
// maps that are not only used by the maps browser, e.g. by matchmaking preferences, in which case
// we can't just clear the maps state willy-nilly.
/**
 * An action which clears all of the maps from the store.
 */
export interface ClearMaps {
  type: '@maps/clearMaps'
}

/**
 * A request is being made to the server to retrieve details of a map.
 */
export interface GetMapDetailsBegin {
  type: '@maps/getMapDetailsBegin'
  payload: {
    mapId: string
  }
}

/**
 * The server has returned the map with its details included.
 */
export interface GetMapDetailsSuccess {
  type: '@maps/getMapDetails'
  payload: GetMapDetailsResponse
  error?: false
  meta: {
    mapId: string
  }
}

/**
 * A request to get map details has failed.
 */
export interface GetMapDetailsFailure extends BaseFetchFailure<'@maps/getMapDetails'> {
  meta: {
    mapId: string
  }
}

/**
 * A request is being made to the server to update a map. Only map's name and descriptions can be
 * updated for now.
 */
export interface UpdateMapBegin {
  type: '@maps/updateMapBegin'
  payload: UpdateMapServerRequest
}

/**
 * The server has updated the map.
 */
export interface UpdateMapSuccess {
  type: '@maps/updateMap'
  payload: UpdateMapResponse
  error?: false
  meta: UpdateMapServerRequest
}

/**
 * A request to update the map has failed.
 */
export interface UpdateMapFailure extends BaseFetchFailure<'@maps/updateMap'> {
  meta: UpdateMapServerRequest
}

/**
 * A request is being made to the server to retrieve map preferences. These are the preferences
 * which are used by the server maps browser.
 */
export interface GetMapPreferencesBegin {
  type: '@maps/getMapPreferencesBegin'
}

/**
 * The server has returned the map preferences.
 */
export interface GetMapPreferencesSuccess {
  type: '@maps/getMapPreferences'
  payload: MapPreferences
  error?: false
}

/**
 * A request to get the map preferences has failed.
 */
export type GetMapPreferencesFailure = BaseFetchFailure<'@maps/getMapPreferences'>

/**
 * A request is being made to the server to update map preferences.
 */
export interface UpdateMapPreferencesBegin {
  type: '@maps/updateMapPreferencesBegin'
  payload: MapPreferences
}

/**
 * The server has updated the map preferences.
 */
export interface UpdateMapPreferencesSuccess {
  type: '@maps/updateMapPreferences'
  payload: MapPreferences
  error?: false
  meta: MapPreferences
}

/**
 * A request to update the map preferences has failed.
 */
export interface UpdateMapPreferencesFailure
  extends BaseFetchFailure<'@maps/updateMapPreferences'> {
  meta: MapPreferences
}
