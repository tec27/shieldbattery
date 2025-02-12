import React, { useState } from 'react'
import { ReadonlyDeep } from 'type-fest'
import { MapInfoJson } from '../../common/maps'
import { useStableCallback } from '../state-hooks'
import { BrowseServerMaps } from './browse-server-maps'

const LoadableLocalMaps = React.lazy(async () => ({
  default: (await import('./browse-local-maps')).BrowseLocalMaps,
}))

export function MapsRoot() {
  const [browsingLocalMaps, setBrowsingLocalMaps] = useState(false)
  const [uploadedMap, setUploadedMap] = useState<ReadonlyDeep<MapInfoJson>>()

  const onBrowseLocalMaps = useStableCallback(() => {
    setBrowsingLocalMaps(true)
    setUploadedMap(undefined)
  })

  const onMapUpload = useStableCallback((map: ReadonlyDeep<MapInfoJson>) => {
    setBrowsingLocalMaps(false)
    setUploadedMap(map)
  })

  return IS_ELECTRON && browsingLocalMaps ? (
    /** TODO: map select -> upload */
    <LoadableLocalMaps onMapSelect={onMapUpload} />
  ) : (
    <BrowseServerMaps
      title={'FIXME'}
      onBrowseLocalMaps={IS_ELECTRON ? onBrowseLocalMaps : undefined}
      uploadedMap={uploadedMap}
    />
  )
}
