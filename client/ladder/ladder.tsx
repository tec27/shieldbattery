import { Immutable } from 'immer'
import { List } from 'immutable'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { areEqual, FixedSizeList } from 'react-window'
import styled from 'styled-components'
import { useRoute } from 'wouter'
import { LadderPlayer } from '../../common/ladder'
import {
  ALL_MATCHMAKING_TYPES,
  MatchmakingType,
  matchmakingTypeToLabel,
} from '../../common/matchmaking'
import { RaceChar } from '../../common/races'
import { SbUser, SbUserId } from '../../common/users/sb-user'
import { Avatar } from '../avatars/avatar'
import { useObservedDimensions } from '../dom/dimension-hooks'
import { longTimestamp, shortTimestamp } from '../i18n/date-formats'
import { RaceIcon } from '../lobbies/race-icon'
import { JsonLocalStorageValue } from '../local-storage'
import { animationFrameHandler, AnimationFrameHandler } from '../material/animation-frame-handler'
import { useButtonState } from '../material/button'
import { buttonReset } from '../material/button-reset'
import { Ripple } from '../material/ripple'
import { shadow4dp } from '../material/shadows'
import { TabItem, Tabs } from '../material/tabs'
import { replace } from '../navigation/routing'
import { navigateToUserProfile } from '../profile/action-creators'
import { LoadingDotsArea } from '../progress/dots'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { useValueAsRef } from '../state-hooks'
import {
  background400,
  background500,
  background600,
  colorDividers,
  colorError,
  colorTextFaint,
  colorTextSecondary,
} from '../styles/colors'
import { body1, overline, subtitle1, subtitle2 } from '../styles/typography'
import { timeAgo } from '../time/time-ago'
import { getRankings, navigateToLadder } from './action-creators'

const LadderPage = styled.div`
  width: 100%;
  height: 100%;

  display: flex;
  flex-direction: column;
  overflow: hidden;
`

// NOTE(tec27): Using a container here instead of styling directly because styling it results in
// TS not being able to figure out the generic param, so it doesn't like our tab change handler
const TabsContainer = styled.div`
  position: relative;
  width: 100%;
  max-width: 832px;
  flex-shrink: 0;

  padding: 8px 16px;
`

const ScrollDivider = styled.div<{ $show: boolean; $showAt: 'top' | 'bottom' }>`
  position: absolute;
  height: 1px;
  left: 0;
  right: 0;

  ${props => (props.$showAt === 'top' ? 'top: 0;' : 'bottom: 0;')};

  background-color: ${props => (props.$show ? colorDividers : 'transparent')};
  transition: background-color 150ms linear;
`

const Content = styled.div`
  width: 100%;
  flex-grow: 1;
  flex-shrink: 1;
  overflow: hidden;
`

const savedLadderTab = new JsonLocalStorageValue<MatchmakingType>('ladderTab')

export function LadderRouteComponent(props: { params: any }) {
  const [matches, params] = useRoute<{ matchmakingType: string }>('/ladder/:matchmakingType?')

  if (!matches) {
    queueMicrotask(() => {
      replace('/')
    })
    return null
  }

  const matchmakingType = ALL_MATCHMAKING_TYPES.includes(params?.matchmakingType as MatchmakingType)
    ? (params!.matchmakingType as MatchmakingType)
    : undefined

  return <Ladder matchmakingType={matchmakingType} />
}

export interface LadderProps {
  matchmakingType?: MatchmakingType
}

/**
 * Displays a ranked table of players on the ladder(s).
 */
export function Ladder({ matchmakingType: routeType }: LadderProps) {
  const matchmakingType = routeType ?? savedLadderTab.getValue() ?? MatchmakingType.Match1v1

  const dispatch = useAppDispatch()
  const rankings = useAppSelector(s => s.ladder.typeToRankings.get(matchmakingType))
  const usersById = useAppSelector(s => s.users.byId)

  const onTabChange = useCallback((tab: MatchmakingType) => {
    navigateToLadder(tab)
  }, [])

  useEffect(() => {
    dispatch(getRankings(matchmakingType))
  }, [dispatch, matchmakingType])

  useEffect(() => {
    if (routeType) {
      savedLadderTab.setValue(routeType)
    }
  }, [routeType])

  return (
    <LadderPage>
      <TabsContainer>
        <Tabs activeTab={matchmakingType} onChange={onTabChange}>
          <TabItem
            text={matchmakingTypeToLabel(MatchmakingType.Match1v1)}
            value={MatchmakingType.Match1v1}
          />
          <TabItem
            text={matchmakingTypeToLabel(MatchmakingType.Match2v2)}
            value={MatchmakingType.Match2v2}
          />
        </Tabs>
        <ScrollDivider $show={true} $showAt='bottom' />
      </TabsContainer>
      <Content>
        {rankings ? (
          <LadderTable
            lastUpdated={rankings.lastUpdated}
            totalCount={rankings.totalCount}
            players={rankings.players}
            usersById={usersById}
            isLoading={rankings.isLoading}
            lastError={rankings.lastError}
            curTime={Number(rankings.fetchTime)}
          />
        ) : (
          <LoadingDotsArea />
        )}
      </Content>
    </LadderPage>
  )
}

const ROW_HEIGHT = 48

const TableContainer = styled.div`
  width: 100%;
  height: 100%;
  position: relative;

  overflow-x: hidden;
  overflow-y: auto;
`

const LastUpdatedText = styled.div`
  ${body1};
  width: 100%;
  max-width: 800px;
  margin: 8px 16px 0;
  padding: 0 16px;

  color: ${colorTextSecondary};
  text-align: right;
`

const Table = styled(FixedSizeList)`
  width: 100%;
  height: auto;
  max-width: 800px;
  margin: 8px 16px 16px;
`

const RowContainer = styled.button<{ $isEven: boolean }>`
  ${buttonReset};

  ${subtitle1};
  width: 100%;
  height: ${ROW_HEIGHT}px;
  padding: 0;

  display: flex;
  align-items: center;

  background-color: ${props => (props.$isEven ? background400 : background500)};
`

const HeaderRowContainer = styled.div`
  ${shadow4dp};
  ${overline};
  width: 100%;
  height: ${ROW_HEIGHT}px;
  max-width: 800px;
  position: sticky !important;
  top: 0;

  display: flex;
  align-items: center;

  background-color: ${background600};
  color: ${colorTextSecondary} !important;
  contain: content;
`

const BaseCell = styled.div`
  height: 100%;
  flex: 1 1 auto;
  padding: 0 8px;
  line-height: ${ROW_HEIGHT}px;
`

const RankCell = styled(BaseCell)`
  width: 64px;
  padding-left: 16px;
  text-align: right;
`

const PlayerCell = styled(BaseCell)`
  width: 176px;
  padding: 0 16px;
  display: flex;
  align-items: center;
`

const RaceCell = styled(BaseCell)`
  width: 48px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
`

const RatingCell = styled(BaseCell)`
  width: 56px;
  text-align: right;
`

const WinLossCell = styled(BaseCell)`
  width: 128px;
  text-align: right;
`

const LastPlayedCell = styled(BaseCell)`
  width: 156px;
  padding: 0 16px 0 32px;
  color: ${colorTextSecondary};
  text-align: right;
`

const StyledAvatar = styled(Avatar)`
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  margin-right: 16px;
`

const PlayerName = styled.div`
  ${subtitle2};
  line-height: ${ROW_HEIGHT}px;
`

const StyledRaceIcon = styled(RaceIcon)`
  width: 32px;
  height: 32px;
`

const ErrorText = styled.div`
  ${subtitle1};
  padding: 16px;

  color: ${colorError};
  text-align: center;
`

const EmptyText = styled.div`
  ${subtitle1};
  padding: 16px;

  color: ${colorTextFaint};
  text-align: center;
`

export interface LadderTableProps {
  curTime: number
  totalCount: number
  isLoading: boolean
  players?: List<Readonly<LadderPlayer>>
  usersById: Immutable<Map<SbUserId, SbUser>>
  lastUpdated: number
  lastError?: Error
}

export function LadderTable(props: LadderTableProps) {
  const [dimensionsRef, containerRect] = useObservedDimensions()
  const containerRef = useRef<HTMLElement | null>(null)
  // multiplex the ref to the container to our own ref + the dimensions one
  const containerCallback = useCallback(
    (node: HTMLElement | null) => {
      dimensionsRef(node)
      containerRef.current = node
    },
    [dimensionsRef],
  )

  const tableRef = useRef<FixedSizeList>(null)
  const tableOuterRef = useRef<HTMLElement>(null)

  const [scrollTop, setScrollTop] = useState(0)
  const containerScrollHandler = useRef<AnimationFrameHandler<HTMLDivElement>>()
  useLayoutEffect(() => {
    containerScrollHandler.current = animationFrameHandler(() => {
      setScrollTop(containerRef.current?.scrollTop ?? 0)
    })

    setScrollTop(containerRef.current?.scrollTop ?? 0)

    return () => {
      containerScrollHandler.current?.cancel()
      containerScrollHandler.current = undefined
    }
  }, [])

  useEffect(() => {
    if (!tableRef.current || !tableOuterRef.current) {
      return
    }

    const outer = tableOuterRef.current
    tableRef.current.scrollTo(scrollTop - outer.offsetTop)
  }, [scrollTop])

  const { players, usersById, isLoading, lastError, curTime } = props
  const noRowsRenderer = useCallback(() => {
    if (isLoading) {
      return <LoadingDotsArea />
    } else if (lastError) {
      return <ErrorText>There was an error retrieving the current rankings.</ErrorText>
    } else {
      return <EmptyText>Nothing to see here</EmptyText>
    }
  }, [isLoading, lastError])

  const onRowSelected = useCallback((userId: SbUserId, username: string) => {
    navigateToUserProfile(userId, username)
  }, [])

  const curTimeRef = useValueAsRef(curTime)
  const playersRef = useValueAsRef(players)
  const usersByIdRef = useValueAsRef(usersById)

  const renderRow = useCallback(
    ({ index, style }: { index: number; style: React.CSSProperties }) => {
      const player = playersRef.current?.get(index - 1)
      if (!player) {
        return <span style={style}></span>
      }

      const username = usersByIdRef.current.get(player.userId)?.name ?? ''

      return (
        <Row
          key={player.userId}
          style={style}
          isEven={index % 2 === 0}
          player={player}
          username={username}
          curTime={curTimeRef.current}
          onSelected={onRowSelected}
        />
      )
    },
    [onRowSelected, curTimeRef, playersRef, usersByIdRef],
  )

  return (
    <TableContainer ref={containerCallback} onScroll={containerScrollHandler.current?.handler}>
      <LastUpdatedText title={longTimestamp.format(props.lastUpdated)}>
        Last updated: {shortTimestamp.format(props.lastUpdated)}
      </LastUpdatedText>
      {props.totalCount > 0 ? (
        <Table
          ref={tableRef}
          outerRef={tableOuterRef}
          style={{ height: 'auto', display: 'inline-block', overflow: 'unset' }}
          width='100%'
          height={containerRect?.height ?? 0}
          itemCount={props.totalCount + 1}
          itemSize={ROW_HEIGHT}
          innerElementType={innerElementWithHeader}>
          {renderRow}
        </Table>
      ) : (
        noRowsRenderer()
      )}
    </TableContainer>
  )
}

const innerElementWithHeader = React.forwardRef<HTMLDivElement, { children: React.ReactNode }>(
  ({ children, ...rest }, ref) => (
    <div ref={ref} {...rest}>
      <HeaderRowContainer key='header' style={{ top: 0, left: 0 }}>
        <RankCell>Rank</RankCell>
        <PlayerCell>Player</PlayerCell>
        <RaceCell>Race</RaceCell>
        <RatingCell>Rating</RatingCell>
        <WinLossCell>Win/loss</WinLossCell>
        <LastPlayedCell>Last played</LastPlayedCell>
      </HeaderRowContainer>

      {children}
    </div>
  ),
)

interface RowProps {
  style?: React.CSSProperties
  isEven: boolean
  player: LadderPlayer
  username: string
  curTime: number
  onSelected?: (userId: SbUserId, username: string) => void
}

const Row = React.memo(({ style, isEven, player, username, curTime, onSelected }: RowProps) => {
  const onClick = useCallback(() => {
    if (onSelected) {
      onSelected(player.userId, username)
    }
  }, [onSelected, player, username])
  const [buttonProps, rippleRef] = useButtonState({ onClick })

  const raceStats = new Map<number, RaceChar>([
    [player.pWins + player.pLosses, 'p'],
    [player.tWins + player.tLosses, 't'],
    [player.zWins + player.zLosses, 'z'],
    [player.rWins + player.rLosses, 'r'],
  ])
  const mostPlayedGames = [...raceStats.keys()].sort((a, b) => b - a)[0]
  const mostPlayedRace = raceStats.get(mostPlayedGames)!

  return (
    <RowContainer style={style} $isEven={isEven} {...buttonProps}>
      <RankCell>{player.rank}</RankCell>
      <PlayerCell>
        <StyledAvatar user={username} />
        <PlayerName>{username}</PlayerName>
      </PlayerCell>
      <RaceCell>
        <StyledRaceIcon race={mostPlayedRace} />
      </RaceCell>
      <RatingCell>{Math.round(player.rating)}</RatingCell>
      <WinLossCell>
        {player.wins} &ndash; {player.losses}
      </WinLossCell>
      <LastPlayedCell>{timeAgo(curTime - player.lastPlayedDate)}</LastPlayedCell>
      <Ripple ref={rippleRef} />
    </RowContainer>
  )
}, areEqual)
