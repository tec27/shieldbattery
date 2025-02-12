import { Set } from 'immutable'
import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { ALL_TILESETS, NumPlayers, Tileset, tilesetToName } from '../../common/maps'
import { MaterialIcon } from '../icons/material/material-icon'
import { useKeyListener } from '../keyboard/key-listener'
import { IconButton, TextButton } from '../material/button'
import { CheckBox } from '../material/check-box'
import { fastOutSlowInShort } from '../material/curves'
import { FloatingActionButton } from '../material/floating-action-button'
import { MenuList } from '../material/menu/menu'
import { SelectableMenuItem } from '../material/menu/selectable-item'
import { Popover, useAnchorPosition, usePopoverController } from '../material/popover'
import { SearchInput } from '../search/search-input'
import { useValueAsRef } from '../state-hooks'
import { colorTextSecondary } from '../styles/colors'
import { overline } from '../styles/typography'

const ENTER = 'Enter'
const ENTER_NUMPAD = 'NumpadEnter'

const Container = styled.div`
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 56px;
  padding: 16px;
`

const LeftActions = styled.div`
  flex-shrink: 0;
`

const ActionButton = styled(IconButton)`
  ${LeftActions} > & {
    margin-right: 8px;
  }
`

const PositionedFloatingActionButton = styled(FloatingActionButton)`
  position: absolute;
  top: -28px;
  left: calc(50% - 28px);
`

const StyledSearchInput = styled(SearchInput)`
  width: 200px;
  ${fastOutSlowInShort};

  &:focus-within {
    width: 256px;
  }
`

const FilterOverlayContents = styled.div`
  position: relative;
  min-width: 288px;
  padding: 0 16px 4px;
`

function FilterOverlay({ children, onApply }: { children: React.ReactNode; onApply: () => void }) {
  useKeyListener({
    onKeyDown(event: KeyboardEvent) {
      if (event.code === ENTER || event.code === ENTER_NUMPAD) {
        onApply()
        return true
      }

      return false
    },
  })

  return <FilterOverlayContents>{children}</FilterOverlayContents>
}

const SectionOverline = styled.div`
  ${overline};
  color: ${colorTextSecondary};
  margin-top: 8px;
`

const ColumnGroup = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-column-gap: 16px;
`

const FilterActions = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
`

export interface BrowserFooterProps {
  thumbnailSize: number
  sortOption: number
  numPlayersFilter: Set<NumPlayers>
  tilesetFilter: Set<Tileset>
  searchQuery: string
  onSizeChange: (index: number) => void
  onFilterApply: (numPlayersFilter: Set<NumPlayers>, tilesetFilter: Set<Tileset>) => void
  onSortChange: (index: number) => void
  onSearchChange: (value: string) => void
  onBrowseLocalMaps?: () => void
}

export const BrowserFooter = React.memo((props: BrowserFooterProps) => {
  const { t } = useTranslation()
  const [filterOverlayOpen, openFilterOverlay, closeFilterOverlay] = usePopoverController()
  const [sizeMenuOpen, openSizeMenu, closeSizeMenu] = usePopoverController()
  const [sortMenuOpen, openSortMenu, closeSortMenu] = usePopoverController()
  const [tempNumPlayersFilter, setTempNumPlayersFilter] = useState(props.numPlayersFilter)
  const [tempTilesetFilter, setTempTilesetFilter] = useState(props.tilesetFilter)

  const [filterButtonRef, filterAnchorX, filterAnchorY] = useAnchorPosition('right', 'bottom')
  const [sizeRef, sizeAnchorX, sizeAnchorY] = useAnchorPosition('right', 'bottom')
  const [sortMenuRef, sortAnchorX, sortAnchorY] = useAnchorPosition('right', 'bottom')

  const numPlayersFilterRef = useValueAsRef(props.numPlayersFilter)
  const tilesetFilterRef = useValueAsRef(props.tilesetFilter)

  const { searchQuery, onSearchChange, onSizeChange, onSortChange, onFilterApply } = props

  // TODO(tec27): These should probably return focus to the button that opens these menus, so that
  // keyboard navigation of this interface is reasonably possible
  const onSizeSelected = useCallback(
    (index: number) => {
      onSizeChange(index)
      closeSizeMenu()
    },
    [closeSizeMenu, onSizeChange],
  )
  const onSortSelected = useCallback(
    (index: number) => {
      onSortChange(index)
      closeSortMenu()
    },
    [closeSortMenu, onSortChange],
  )
  const onNumPlayersFilterChange = useCallback((numPlayers: NumPlayers) => {
    setTempNumPlayersFilter(value =>
      value.has(numPlayers) ? value.delete(numPlayers) : value.add(numPlayers),
    )
  }, [])
  const onTilesetFilterChange = useCallback((tilesetId: Tileset) => {
    setTempTilesetFilter(value =>
      value.has(tilesetId) ? value.delete(tilesetId) : value.add(tilesetId),
    )
  }, [])
  const onFilterCancel = useCallback(() => {
    // Since the filter overlay doesn't get unmounted after it's closed, we need to reset the
    // temporary filter state to its initial value manually.
    setTempNumPlayersFilter(numPlayersFilterRef.current)
    setTempTilesetFilter(tilesetFilterRef.current)
    closeFilterOverlay()
  }, [numPlayersFilterRef, tilesetFilterRef, closeFilterOverlay])
  const forwardOnFilterApply = useCallback(() => {
    onFilterApply(tempNumPlayersFilter, tempTilesetFilter)
    closeFilterOverlay()
  }, [onFilterApply, tempNumPlayersFilter, tempTilesetFilter, closeFilterOverlay])

  const numPlayersItems = useMemo(() => {
    const values: Array<[n: NumPlayers, label: string]> = [
      [2, '2 players'],
      [3, '3 players'],
      [4, '4 players'],
      [5, '5 players'],
      [6, '6 players'],
      [7, '7 players'],
      [8, '8 players'],
    ]

    return values.map(([numPlayers, label]) => (
      <CheckBox
        key={numPlayers}
        label={label}
        checked={tempNumPlayersFilter.has(numPlayers)}
        onChange={() => onNumPlayersFilterChange(numPlayers)}
      />
    ))
  }, [tempNumPlayersFilter, onNumPlayersFilterChange])
  const tilesetItems = useMemo(() => {
    return ALL_TILESETS.map(tilesetId => (
      <CheckBox
        key={tilesetId}
        label={tilesetToName(tilesetId, t)}
        checked={tempTilesetFilter.has(tilesetId)}
        onChange={() => onTilesetFilterChange(tilesetId)}
      />
    ))
  }, [t, tempTilesetFilter, onTilesetFilterChange])

  return (
    <Container>
      {props.onBrowseLocalMaps ? (
        <PositionedFloatingActionButton
          title={t('maps.server.browseLocal', 'Browse local maps')}
          icon={<MaterialIcon icon='folder' invertColor={true} filled={false} />}
          onClick={props.onBrowseLocalMaps}
        />
      ) : undefined}
      <LeftActions>
        <ActionButton
          ref={sizeRef}
          icon={<MaterialIcon icon='view_list' />}
          title={t('maps.server.thumbnailSize.title', 'Thumbnail size')}
          onClick={openSizeMenu}
        />
        <ActionButton
          ref={filterButtonRef}
          icon={<MaterialIcon icon='filter_list' />}
          title={t('maps.server.filterOptions.title', 'Filter options')}
          onClick={openFilterOverlay}
        />
        <ActionButton
          ref={sortMenuRef}
          icon={<MaterialIcon icon='sort_by_alpha' />}
          title={t('maps.server.sortMaps.title', 'Sort maps')}
          onClick={openSortMenu}
        />
      </LeftActions>

      <StyledSearchInput searchQuery={searchQuery} onSearchChange={onSearchChange} />

      <Popover
        open={sizeMenuOpen}
        onDismiss={closeSizeMenu}
        anchorX={sizeAnchorX ?? 0}
        anchorY={sizeAnchorY ?? 0}
        originX='right'
        originY='bottom'>
        <MenuList dense={true}>
          {[
            t('maps.server.thumbnailSize.option.small', 'Small'),
            t('maps.server.thumbnailSize.option.medium', 'Medium'),
            t('maps.server.thumbnailSize.option.large', 'Large'),
          ].map((text, index) => (
            <SelectableMenuItem
              key={index}
              text={text}
              selected={props.thumbnailSize === index}
              onClick={() => onSizeSelected(index)}
            />
          ))}
        </MenuList>
      </Popover>

      <Popover
        open={filterOverlayOpen}
        onDismiss={onFilterCancel}
        anchorX={filterAnchorX ?? 0}
        anchorY={filterAnchorY ?? 0}
        originX='right'
        originY='bottom'>
        <FilterOverlay onApply={forwardOnFilterApply}>
          <SectionOverline>
            {t('maps.server.filterOptions.section.numberOfPlayers', 'Number of players')}
          </SectionOverline>
          <ColumnGroup>{numPlayersItems}</ColumnGroup>
          <SectionOverline>
            {t('maps.server.filterOptions.section.tileset', 'Tileset')}
          </SectionOverline>
          <ColumnGroup>{tilesetItems}</ColumnGroup>
          <FilterActions>
            <TextButton
              label={t('common.actions.cancel', 'Cancel')}
              color='accent'
              onClick={onFilterCancel}
            />
            <TextButton
              label={t('common.actions.apply', 'Apply')}
              color='accent'
              onClick={forwardOnFilterApply}
            />
          </FilterActions>
        </FilterOverlay>
      </Popover>

      <Popover
        open={sortMenuOpen}
        onDismiss={closeSortMenu}
        anchorX={sortAnchorX ?? 0}
        anchorY={sortAnchorY ?? 0}
        originX='right'
        originY='bottom'>
        <MenuList dense={true}>
          {[
            t('maps.server.sortMaps.option.name', 'Name'),
            t('maps.server.sortMaps.option.numberOfPlayers', 'Number of players'),
            t('maps.server.sortMaps.option.dateUploaded', 'Date uploaded'),
          ].map((text, index) => (
            <SelectableMenuItem
              key={index}
              text={text}
              selected={props.sortOption === index}
              onClick={() => onSortSelected(index)}
            />
          ))}
        </MenuList>
      </Popover>
    </Container>
  )
})
