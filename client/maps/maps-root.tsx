import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { ReadonlyDeep } from 'type-fest'
import { MapInfoJson } from '../../common/maps'
import { useStableCallback } from '../state-hooks'
import { BrowseServerMaps } from './browse-server-maps'

const LoadableLocalMaps = React.lazy(async () => ({
  default: (await import('./browse-local-maps')).BrowseLocalMaps,
}))

const Container = styled.div`
  width: 100%;
  max-width: calc(1248px + var(--pixel-shove-x));
  height: 100%;
  padding: 0 24px 0 calc(24px + var(--pixel-shove-x));
`

export function MapsRoot() {
  const { t } = useTranslation()
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

  return (
    <Container>
      {IS_ELECTRON && browsingLocalMaps ? (
        <LoadableLocalMaps onMapSelect={onMapUpload} />
      ) : (
        <BrowseServerMaps
          title={t('maps.activity.title', 'Maps')}
          onBrowseLocalMaps={IS_ELECTRON ? onBrowseLocalMaps : undefined}
          uploadedMap={uploadedMap}
        />
      )}
    </Container>
  )
}
