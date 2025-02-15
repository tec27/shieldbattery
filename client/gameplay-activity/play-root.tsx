import { TFunction } from 'i18next'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { Redirect, Route, Switch, useRoute } from 'wouter'
import JoinLobby from '../lobbies/join-lobby'
import { FindMatch } from '../matchmaking/find-match'
import { TabItem, TabItemContainer, Tabs } from '../material/tabs'
import { push } from '../navigation/routing'
import { useStableCallback, useUserLocalStorageValue } from '../state-hooks'
import { CenteredContentContainer } from '../styles/centered-container'

enum PlayTab {
  Matchmaking = 'matchmaking',
  Lobbies = 'lobbies',
}

const ALL_TABS: ReadonlyArray<PlayTab> = [PlayTab.Matchmaking, PlayTab.Lobbies]

function normalizeTab(tab: PlayTab | string | undefined): PlayTab | undefined {
  switch (tab) {
    case PlayTab.Matchmaking:
    case PlayTab.Lobbies:
      return tab
    default:
      return undefined
  }
}

// TODO(tec27): Add active lobby count to the lobby string
function tabToLabel(t: TFunction, tab: PlayTab): string {
  switch (tab) {
    case PlayTab.Matchmaking:
      return t('matchmaking.activity.title', 'Matchmaking')
    case PlayTab.Lobbies:
      return t('lobbies.activity.title', 'Lobbies')
    default:
      return tab satisfies never
  }
}

export function PlayRoot() {
  const [routeMatches, routeParams] = useRoute('/play/:tab?')
  if (!routeMatches) {
    return undefined
  }

  // NOTE(tec27): We use a key to ensure the whole component gets re-rendered if the tab in the URL
  // changes, so that we don't have to call `setActiveTab` in a `useEffect` if the user hits a
  // matchmaking/lobby hotkey while already under `/play/`
  return <RoutedPlayRoot routeParams={routeParams} key={routeParams.tab} />
}

const ContentGrid = styled.div`
  width: 100%;
  height: 100%;

  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;
`

// NOTE(tec27): Using a container here instead of styling directly because styling it results in
// TS not being able to figure out the generic param, so it doesn't like our tab change handler
const TabsContainer = styled.div`
  display: flex;
  justify-content: center;

  & ${TabItemContainer} {
    min-width: 268px;
  }
`

function RoutedPlayRoot({ routeParams }: { routeParams: { tab?: string } }) {
  const { t } = useTranslation()
  const routeTab = normalizeTab(routeParams.tab)
  const [storedLastActiveTab, setLastActiveTab] =
    useUserLocalStorageValue<PlayTab>('play.lastActiveTab')
  const lastActiveTab = normalizeTab(storedLastActiveTab) ?? PlayTab.Matchmaking
  const [activeTab, setActiveTab] = useState(routeTab ?? lastActiveTab)
  const onTabChange = useStableCallback((tab: PlayTab) => {
    setLastActiveTab(tab)
    setActiveTab(tab)
    push(`/play/${tab}`)
  })

  useEffect(() => {
    // Handle tab changes that happen only as URL changes
    if (routeTab && routeTab !== lastActiveTab) {
      setLastActiveTab(routeTab)
    }
  }, [routeTab, lastActiveTab, setLastActiveTab])

  return (
    <CenteredContentContainer>
      <ContentGrid>
        <TabsContainer>
          <Tabs activeTab={activeTab} onChange={onTabChange}>
            {ALL_TABS.map(tab => (
              <TabItem key={tab} value={tab} text={tabToLabel(t, tab)} />
            ))}
          </Tabs>
        </TabsContainer>
        <Switch>
          <Route path='/play/matchmaking/*?' component={Matchmaking} />
          <Route path='/play/lobbies/*?' component={Lobbies} />
          <Redirect to={`/play/${activeTab}`} replace={true} />
        </Switch>
      </ContentGrid>
    </CenteredContentContainer>
  )
}

function Matchmaking() {
  return IS_ELECTRON ? <FindMatch /> : <div>FIXME: only available in app, download</div>
}

function Lobbies() {
  return <JoinLobby />
}
