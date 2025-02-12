import { Set } from 'immutable'
import { debounce, DebouncedFunc } from 'lodash-es'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { ReadonlyDeep } from 'type-fest'
import {
  ALL_TILESETS,
  MapInfoJson,
  MapSortType,
  MapVisibility,
  NumPlayers,
  Tileset,
} from '../../common/maps'
import { SbUserId } from '../../common/users/sb-user'
import { ActivityBackButton } from '../activities/activity-back-button'
import InfiniteScrollList from '../lists/infinite-scroll-list'
import ImageList from '../material/image-list'
import { TabItem, Tabs } from '../material/tabs'
import LoadingIndicator from '../progress/dots'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { useStableCallback } from '../state-hooks'
import { colorDividers, colorError, colorTextSecondary } from '../styles/colors'
import { Headline5, Subtitle1, subtitle1 } from '../styles/typography'
import {
  clearMapsList,
  getMapPreferences,
  getMapsList,
  openMapPreviewDialog,
  toggleFavoriteMap,
  updateMapPreferences,
} from './action-creators'
import { BrowserFooter as Footer } from './browser-footer'
import { MapThumbnail } from './map-thumbnail'

const MAPS_LIMIT = 30

const LoadingArea = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 100%;
`

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const TitleBar = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  margin: 16px 24px;
`

const Contents = styled.div`
  flex-grow: 1;
  contain: strict;
  overflow-y: auto;
`

const ContentsBody = styled.div`
  padding: 0 24px 40px;
`

const SectionHeader = styled.div`
  ${subtitle1};
  color: ${colorTextSecondary};
  margin-top: 24px;
  margin-bottom: 16px;
`

const ErrorText = styled.div`
  ${subtitle1};
  color: ${colorError};
`

const TabArea = styled.div`
  position: relative;
  padding: 0px 24px 8px;
`

const ScrollDivider = styled.div<{ position: 'top' | 'bottom' }>`
  width: 100%;
  height: 1px;
  margin-top: ${props => (props.position === 'top' ? '-1px' : '0')};
  margin-bottom: ${props => (props.position === 'bottom' ? '-1px' : '0')};
  background-color: ${colorDividers};
`

enum MapTab {
  OfficialMaps = 0,
  MyMaps = 1,
  CommunityMaps = 2,
}

function tabToVisibility(tab: MapTab): MapVisibility {
  switch (tab) {
    case MapTab.OfficialMaps:
      return MapVisibility.Official
    case MapTab.MyMaps:
      return MapVisibility.Private
    case MapTab.CommunityMaps:
      return MapVisibility.Public
    default:
      return tab satisfies never
  }
}

function visibilityToTab(visibility: MapVisibility): MapTab {
  switch (visibility) {
    case MapVisibility.Official:
      return MapTab.OfficialMaps
    case MapVisibility.Private:
      return MapTab.MyMaps
    case MapVisibility.Public:
      return MapTab.CommunityMaps
    default:
      return visibility satisfies never
  }
}

const THUMBNAIL_SIZES = [
  { columnCount: 4, padding: 4 },
  { columnCount: 3, padding: 4 },
  { columnCount: 2, padding: 4 },
] as const

interface MapListProps {
  maps: ReadonlyDeep<MapInfoJson[]>
  userId?: SbUserId
  canManageMaps: boolean
  thumbnailSize: number
  favoriteStatusRequests: ReadonlySet<string>
  onMapSelect?: (map: ReadonlyDeep<MapInfoJson>) => void
  onMapPreview?: (map: ReadonlyDeep<MapInfoJson>) => void
  onToggleFavoriteMap?: (map: ReadonlyDeep<MapInfoJson>) => void
  onMapDetails?: (map: ReadonlyDeep<MapInfoJson>) => void
  onRemoveMap?: (map: ReadonlyDeep<MapInfoJson>) => void
  onRegenMapImage?: (map: ReadonlyDeep<MapInfoJson>) => void
}

function MapList({
  maps,
  userId,
  canManageMaps,
  thumbnailSize,
  favoriteStatusRequests,
  onMapSelect,
  onMapPreview,
  onToggleFavoriteMap,
  onMapDetails,
  onRemoveMap,
  onRegenMapImage,
}: MapListProps) {
  return maps.map(map => {
    const canRemoveMap =
      onRemoveMap &&
      ((map.visibility !== MapVisibility.Private && canManageMaps) ||
        (map.visibility === MapVisibility.Private && map.uploadedBy.id === userId))
    const canRegenMapImage = onRegenMapImage && canManageMaps

    return (
      <MapThumbnail
        key={map.id}
        map={map}
        forceAspectRatio={1}
        size={THUMBNAIL_SIZES[thumbnailSize].columnCount === 2 ? 512 : 256}
        showMapName={true}
        isFavoriting={favoriteStatusRequests.has(map.id)}
        onClick={onMapSelect ? () => onMapSelect(map) : undefined}
        onPreview={onMapPreview ? () => onMapPreview(map) : undefined}
        onToggleFavorite={onToggleFavoriteMap ? () => onToggleFavoriteMap(map) : undefined}
        onMapDetails={onMapDetails ? () => onMapDetails(map) : undefined}
        onRemove={canRemoveMap ? () => onRemoveMap(map) : undefined}
        onRegenMapImage={canRegenMapImage ? () => onRegenMapImage(map) : undefined}
      />
    )
  })
}

interface BrowseServerMapsProps {
  title: string
  uploadedMap?: ReadonlyDeep<MapInfoJson>
  onMapSelect?: (map: ReadonlyDeep<MapInfoJson>) => void
  onMapDetails?: (map: ReadonlyDeep<MapInfoJson>) => void
  onRemoveMap?: (map: ReadonlyDeep<MapInfoJson>) => void
  onRegenMapImage?: (map: ReadonlyDeep<MapInfoJson>) => void
  onBrowseLocalMaps?: () => void
}

export function BrowseServerMaps({
  title,
  uploadedMap,
  onMapSelect,
  onMapDetails,
  onRemoveMap,
  onRegenMapImage,
  onBrowseLocalMaps,
}: BrowseServerMapsProps) {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const auth = useAppSelector(s => s.auth)
  const mapsState = useAppSelector(s => s.maps)
  const mapPreferences = useAppSelector(s => s.mapPreferences)

  const [activeTab, setActiveTab] = useState(uploadedMap ? MapTab.MyMaps : MapTab.OfficialMaps)
  const [currentPage, setCurrentPage] = useState(0)
  const [thumbnailSize, setThumbnailSize] = useState(1)
  const [sortOption, setSortOption] = useState<MapSortType>(MapSortType.Name)
  const [numPlayersFilter, setNumPlayersFilter] = useState<Set<NumPlayers>>(() =>
    Set([2, 3, 4, 5, 6, 7, 8]),
  )
  const [tilesetFilter, setTilesetFilter] = useState<Set<Tileset>>(() => Set(ALL_TILESETS))
  const [searchQuery, setSearchQuery] = useState('')
  const [hasInitializedState, setHasInitializedState] = useState(false)

  const refreshTokenRef = useRef(0)

  const savePreferences = useStableCallback(() => {
    dispatch(
      updateMapPreferences({
        visibility: tabToVisibility(activeTab),
        thumbnailSize,
        sortOption,
        numPlayersFilter: numPlayersFilter.toArray(),
        tilesetFilter: tilesetFilter.toArray(),
      }),
    )
  })

  const debouncedSetSearchQuery = useRef<DebouncedFunc<typeof setSearchQuery>>()
  const reset = useStableCallback(() => {
    debouncedSetSearchQuery.current?.cancel()
    dispatch(clearMapsList())
    refreshTokenRef.current++
    setCurrentPage(0)
  })
  debouncedSetSearchQuery.current = useMemo(
    () =>
      debounce((query: string) => {
        setSearchQuery(query)
        reset()
      }, 100),
    [reset],
  )

  useEffect(() => {
    dispatch(getMapPreferences())
    window.addEventListener('beforeunload', savePreferences)
    return () => {
      dispatch(clearMapsList())
      savePreferences()
      window.removeEventListener('beforeunload', savePreferences)
      debouncedSetSearchQuery.current?.cancel()
    }
  }, [dispatch, savePreferences])

  useEffect(() => {
    const {
      isRequesting,
      visibility,
      thumbnailSize: prefThumbnailSize,
      sortOption: prefSortOption,
      numPlayersFilter: prefNumPlayers,
      tilesetFilter: prefTileset,
      lastError,
    } = mapPreferences
    if (isRequesting) return

    setHasInitializedState(true)
    if (!lastError) {
      setActiveTab(uploadedMap ? MapTab.MyMaps : visibilityToTab(visibility))
      setThumbnailSize(prefThumbnailSize)
      setSortOption(prefSortOption)
      setNumPlayersFilter(Set(prefNumPlayers))
      setTilesetFilter(Set(prefTileset))
    }
  }, [mapPreferences, uploadedMap])

  const onLoadMoreMaps = useStableCallback(() => {
    dispatch(
      getMapsList({
        visibility: tabToVisibility(activeTab),
        limit: MAPS_LIMIT,
        page: currentPage,
        sort: sortOption,
        numPlayers: numPlayersFilter.toArray(),
        tileset: tilesetFilter.toArray(),
        searchQuery,
      }),
    )
    setCurrentPage(p => p + 1)
  })

  const onMapPreview = useStableCallback((map: ReadonlyDeep<MapInfoJson>) => {
    dispatch(openMapPreviewDialog(map.id))
  })

  const onToggleFavoriteMap = useStableCallback((map: ReadonlyDeep<MapInfoJson>) => {
    dispatch(toggleFavoriteMap(map))
  })

  const onThumbnailSizeChange = useStableCallback((size: number) => {
    if (thumbnailSize !== size) {
      setThumbnailSize(size)
    }
  })

  const onFilterApply = useStableCallback((players: Set<NumPlayers>, tileset: Set<Tileset>) => {
    setNumPlayersFilter(players)
    setTilesetFilter(tileset)
    reset()
  })

  const onSortOptionChange = useStableCallback((option: MapSortType) => {
    if (sortOption !== option) {
      setSortOption(option)
      reset()
    }
  })

  const onTabChange = useStableCallback((value: MapTab) => {
    setActiveTab(value)
    reset()
  })

  const renderMaps = (header: string, maps: ReadonlyDeep<MapInfoJson[]>) => {
    return (
      <>
        <SectionHeader>{header}</SectionHeader>
        <ImageList
          $columnCount={THUMBNAIL_SIZES[thumbnailSize].columnCount}
          $padding={THUMBNAIL_SIZES[thumbnailSize].padding}>
          <MapList
            maps={maps}
            userId={auth.self?.user.id}
            canManageMaps={!!auth.self?.permissions.manageMaps}
            thumbnailSize={thumbnailSize}
            favoriteStatusRequests={mapsState.favoriteStatusRequests}
            onMapSelect={onMapSelect}
            onMapPreview={onMapPreview}
            onToggleFavoriteMap={onToggleFavoriteMap}
            onMapDetails={onMapDetails}
            onRemoveMap={onRemoveMap}
            onRegenMapImage={onRegenMapImage}
          />
        </ImageList>
      </>
    )
  }

  const renderUploadedMap = () => {
    if (!uploadedMap || activeTab !== MapTab.MyMaps) {
      return null
    }

    return renderMaps(t('maps.server.uploadedMap', 'Uploaded map'), [uploadedMap])
  }

  const renderFavoritedMaps = () => {
    if (mapsState.favoritedById.size < 1) return null

    return renderMaps(
      t('maps.server.favoritedMaps', 'Favorited maps'),
      Array.from(mapsState.favoritedById.values()),
    )
  }

  const renderAllMaps = () => {
    if (mapsState.total === -1) return null
    if (mapsState.total === 0) {
      let text
      if (searchQuery) {
        text = t('maps.server.noResults', 'No results.')
      } else if (activeTab === MapTab.OfficialMaps) {
        text = t('maps.server.noOfficialMaps', 'No official maps have been uploaded yet.')
      } else if (activeTab === MapTab.MyMaps) {
        text = t(
          'maps.server.noUploadedMaps',
          "You haven't uploaded any maps. You can upload a map by clicking on the browse button " +
            'below.',
        )
      } else if (activeTab === MapTab.CommunityMaps) {
        text = t(
          'maps.server.noCommunityMaps',
          'No maps by the community have been made public yet.',
        )
      }
      return (
        <>
          <SectionHeader>{t('maps.server.allMaps', 'All maps')}</SectionHeader>
          <Subtitle1>{text}</Subtitle1>
        </>
      )
    }

    return renderMaps(t('maps.server.allMaps', 'All maps'), Array.from(mapsState.byId.values()))
  }

  if (mapPreferences.isRequesting) {
    return (
      <LoadingArea>
        <LoadingIndicator />
      </LoadingArea>
    )
  }

  if (!hasInitializedState) return null

  const hasMoreMaps = mapsState.total === -1 || mapsState.total > mapsState.byId.size

  return (
    <Container>
      <TitleBar>
        <ActivityBackButton />
        <Headline5>{title}</Headline5>
      </TitleBar>
      <TabArea>
        <Tabs activeTab={activeTab} onChange={onTabChange}>
          <TabItem text={t('maps.server.tab.official', 'Official')} value={MapTab.OfficialMaps} />
          <TabItem text={t('maps.server.tab.myMaps', 'My maps')} value={MapTab.MyMaps} />
          <TabItem
            text={t('maps.server.tab.community', 'Community')}
            value={MapTab.CommunityMaps}
          />
        </Tabs>
      </TabArea>
      <ScrollDivider position='top' />
      <Contents>
        <ContentsBody>
          {mapsState.lastError ? (
            <ErrorText>
              {t('maps.server.error', {
                defaultValue: 'Something went wrong: {{errorMessage}}',
                errorMessage: mapsState.lastError.message,
              })}
            </ErrorText>
          ) : (
            <>
              {renderUploadedMap()}
              {renderFavoritedMaps()}
              <InfiniteScrollList
                nextLoadingEnabled={true}
                isLoadingNext={mapsState.isRequesting}
                hasNextData={hasMoreMaps}
                refreshToken={refreshTokenRef.current}
                onLoadNextData={onLoadMoreMaps}>
                {renderAllMaps()}
              </InfiniteScrollList>
            </>
          )}
        </ContentsBody>
      </Contents>
      <ScrollDivider position='bottom' />
      <Footer
        onBrowseLocalMaps={onBrowseLocalMaps}
        thumbnailSize={thumbnailSize}
        onSizeChange={onThumbnailSizeChange}
        numPlayersFilter={numPlayersFilter}
        tilesetFilter={tilesetFilter}
        onFilterApply={onFilterApply}
        sortOption={sortOption}
        onSortChange={onSortOptionChange}
        searchQuery={searchQuery}
        onSearchChange={debouncedSetSearchQuery.current}
      />
    </Container>
  )
}
