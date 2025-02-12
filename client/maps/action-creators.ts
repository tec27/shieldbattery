import { Immutable } from 'immer'
import { ReadonlyDeep } from 'type-fest'
import { getErrorStack } from '../../common/errors'
import {
  GetBatchMapInfoResponse,
  GetMapDetailsResponse,
  GetMapsResponse,
  MapInfoJson,
  MapPreferences,
  UpdateMapResponse,
  UpdateMapServerRequest,
  UploadMapResponse,
} from '../../common/maps'
import { apiUrl, urlPath } from '../../common/urls'
import { openDialog } from '../dialogs/action-creators'
import { DialogType } from '../dialogs/dialog-type'
import { ThunkAction } from '../dispatch-registry'
import i18n from '../i18n/i18next'
import logger from '../logging/logger'
import { MicrotaskBatchRequester } from '../network/batch-requests'
import { fetchJson } from '../network/fetch'
import { openSnackbar } from '../snackbars/action-creators'
import { ClearMaps, GetMapsListParams } from './actions'
import { upload } from './upload'

async function uploadMap(filePath: string) {
  if (IS_ELECTRON) {
    return upload<UploadMapResponse>(filePath, apiUrl`maps`)
  } else {
    throw new Error('cannot upload maps on non-electron clients')
  }
}

export function uploadLocalMap(path: string, onMapSelect: (map: MapInfoJson) => void): ThunkAction {
  return dispatch => {
    const promise = uploadMap(path)

    promise.then(
      ({ map }) => {
        onMapSelect(map)
      },
      () => {
        dispatch(
          openSnackbar({
            message: i18n.t(
              'maps.local.uploadMapError',
              'An error occurred while uploading the map',
            ),
          }),
        )
      },
    )

    dispatch({
      type: '@maps/uploadLocalMapBegin',
      payload: { path },
    })

    dispatch({
      type: '@maps/uploadLocalMap',
      payload: promise,
      meta: { path },
    })
  }
}

export function getMapsList(params: GetMapsListParams): ThunkAction {
  return dispatch => {
    const { visibility, limit, page, sort, numPlayers, tileset, searchQuery } = params

    dispatch({
      type: '@maps/getMapsBegin',
      payload: params,
    })

    const reqUrl = apiUrl`maps?visibility=${visibility}&sort=${sort}&numPlayers=${JSON.stringify(
      numPlayers,
    )}&tileset=${JSON.stringify(tileset)}&q=${searchQuery}&limit=${limit}&page=${page}`

    dispatch({
      type: '@maps/getMaps',
      payload: fetchJson<GetMapsResponse>(reqUrl),
      meta: params,
    })
  }
}

export function toggleFavoriteMap(map: ReadonlyDeep<MapInfoJson>): ThunkAction {
  return dispatch => {
    const params = { map }

    dispatch({
      type: '@maps/toggleFavoriteBegin',
      payload: params,
    })

    const reqPromise = fetchJson<void>(apiUrl`maps/${map.id}/favorite`, {
      method: map.isFavorited ? 'DELETE' : 'POST',
    })

    reqPromise.then(
      () => {
        dispatch(
          openSnackbar({
            message: map.isFavorited
              ? i18n.t('maps.server.favorites.removed', 'Removed from favorites')
              : i18n.t('maps.server.favorites.added', 'Added to favorites'),
          }),
        )
      },
      () => {
        dispatch(
          openSnackbar({
            message: map.isFavorited
              ? i18n.t(
                  'maps.server.favorites.removedError',
                  'An error occurred while removing from favorites',
                )
              : i18n.t(
                  'maps.server.favorites.addedError',
                  'An error occurred while adding to favorites',
                ),
          }),
        )
      },
    )

    dispatch({
      type: '@maps/toggleFavorite',
      payload: reqPromise,
      meta: params,
    })
  }
}

export function removeMap(map: Immutable<MapInfoJson>): ThunkAction {
  return dispatch => {
    dispatch({
      type: '@maps/removeMapBegin',
      payload: { map },
    })

    dispatch({
      type: '@maps/removeMap',
      payload: fetchJson<void>(apiUrl`maps/${map.id}`, { method: 'DELETE' }),
      meta: { map },
    })
  }
}

export function regenMapImage(map: Immutable<MapInfoJson>): ThunkAction {
  return dispatch => {
    dispatch({
      type: '@maps/regenMapImageBegin',
      payload: { map },
    })

    const reqPromise = fetchJson<void>(apiUrl`maps/${map.id}/regenerate`, { method: 'POST' })

    reqPromise.then(
      () => {
        dispatch(
          openSnackbar({
            message: 'Images regenerated',
          }),
        )
      },
      () => {
        dispatch(
          openSnackbar({
            message: i18n.t(
              'maps.server.regenerateError',
              'An error occurred while regenerating images',
            ),
          }),
        )
      },
    )

    dispatch({
      type: '@maps/regenMapImage',
      payload: reqPromise,
      meta: { map },
    })
  }
}

export function clearMapsList(): ClearMaps {
  return {
    type: '@maps/clearMaps',
  }
}

export function getMapDetails(mapId: string): ThunkAction {
  return dispatch => {
    dispatch({
      type: '@maps/getMapDetailsBegin',
      payload: { mapId },
    })
    dispatch({
      type: '@maps/getMapDetails',
      payload: fetchJson<GetMapDetailsResponse>(apiUrl`maps/${mapId}`),
      meta: { mapId },
    })
  }
}

export function updateMap(mapId: string, name: string, description: string): ThunkAction {
  return dispatch => {
    const params: UpdateMapServerRequest = { mapId, name, description }

    dispatch({
      type: '@maps/updateMapBegin',
      payload: params,
    })

    dispatch({
      type: '@maps/updateMap',
      payload: fetchJson<UpdateMapResponse>(apiUrl`maps/${mapId}`, {
        method: 'PATCH',
        body: JSON.stringify(params),
      }),
      meta: params,
    })
  }
}

export function getMapPreferences(): ThunkAction {
  return dispatch => {
    dispatch({
      type: '@maps/getMapPreferencesBegin',
    })

    dispatch({
      type: '@maps/getMapPreferences',
      payload: fetchJson<MapPreferences>(apiUrl`mapPreferences`),
    })
  }
}

export function updateMapPreferences(preferences: MapPreferences): ThunkAction {
  return dispatch => {
    dispatch({
      type: '@maps/updateMapPreferencesBegin',
      payload: preferences,
    })

    dispatch({
      type: '@maps/updateMapPreferences',
      payload: fetchJson<MapPreferences>(apiUrl`mapPreferences`, {
        method: 'post',
        body: JSON.stringify(preferences),
      }),
      meta: preferences,
    })
  }
}

const MAX_BATCH_MAP_REQUESTS = 50

const mapsBatchRequester = new MicrotaskBatchRequester<string>(
  MAX_BATCH_MAP_REQUESTS,
  (dispatch, items) => {
    const params = items.map(m => urlPath`m=${m}`).join('&')
    const promise = fetchJson<GetBatchMapInfoResponse>(apiUrl`maps/batch-info` + '?' + params)
    dispatch({
      type: '@maps/getBatchMapInfo',
      payload: promise,
    })

    return promise
  },
  err => {
    logger.error('error while batch requesting maps: ' + getErrorStack(err))
  },
)

/**
 * Queues a request to the server for map information, if necessary. This will batch multiple
 * requests that happen close together into one request to the server.
 */
export function batchGetMapInfo(mapId: string, maxCacheAgeMillis = 60000): ThunkAction {
  return (dispatch, getState) => {
    const {
      maps2: { byId, lastRetrieved },
    } = getState()

    if (
      !byId.has(mapId) ||
      !lastRetrieved.has(mapId) ||
      window.performance.now() - lastRetrieved.get(mapId)! > maxCacheAgeMillis
    ) {
      mapsBatchRequester.request(dispatch, mapId)
    }
  }
}

export function openMapPreviewDialog(mapId: string) {
  return openDialog({ type: DialogType.MapPreview, initData: { mapId } })
}
