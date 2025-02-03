import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { ReadonlyDeep } from 'type-fest'
import { Link, Route, Switch } from 'wouter'
import { assertUnreachable } from '../../common/assert-unreachable'
import { ClientLeagueUserJson, LeagueId, LeagueJson } from '../../common/leagues'
import { matchmakingTypeToLabel } from '../../common/matchmaking'
import { useHasAnyPermission } from '../admin/admin-permissions'
import { useTrackPageView } from '../analytics/analytics'
import { openDialog } from '../dialogs/action-creators'
import { DialogType } from '../dialogs/dialog-type'
import { longTimestamp, monthDay, narrowDuration } from '../i18n/date-formats'
import { MaterialIcon } from '../icons/material/material-icon'
import logger from '../logging/logger'
import { TextButton, useButtonState } from '../material/button'
import Card from '../material/card'
import { LinkButton } from '../material/link-button'
import { Ripple } from '../material/ripple'
import { shadow2dp } from '../material/shadows'
import { Tooltip } from '../material/tooltip'
import { LoadingDotsArea } from '../progress/dots'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { colorError, colorTextFaint, colorTextSecondary } from '../styles/colors'
import { FlexSpacer } from '../styles/flex-spacer'
import { body1, caption, headline4, headline6, subtitle1 } from '../styles/typography'
import { getLeaguesList, urlForLeague } from './action-creators'
import { LeagueBadge } from './league-badge'
import { LeagueDetailsPage } from './league-details'
import { LeagueImage, LeaguePlaceholderImage } from './league-image'

const LoadableLeagueAdmin = React.lazy(async () => ({
  default: (await import('./league-admin')).LeagueAdmin,
}))

export function LeagueRoot(props: { params: any }) {
  const isAdmin = useHasAnyPermission('manageLeagues')

  return (
    <Suspense fallback={<LoadingDotsArea />}>
      <Switch>
        {isAdmin ? <Route path='/leagues/admin/*?' component={LoadableLeagueAdmin} /> : <></>}
        <Route path='/leagues/:id/*?' component={LeagueDetailsPage} />
        <Route component={LeagueList} />
      </Switch>
    </Suspense>
  )
}

const ListRoot = styled.div`
  width: 100%;
  max-width: 1120px;
  padding: 0 24px 12px;

  display: flex;
  flex-direction: column;
  gap: 16px;
`

const TitleRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 16px;
`

const Title = styled.div`
  ${headline4};
`

const ErrorText = styled.div`
  ${subtitle1};
  color: ${colorError};
`

export enum LeagueSectionType {
  Past,
  Current,
  Future,
}

function LeagueList() {
  useTrackPageView('/leagues/')
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const isAdmin = useHasAnyPermission('manageLeagues')
  const { past, current, future, byId, selfLeagues } = useAppSelector(s => s.leagues)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error>()

  const { pastLeagues, currentLeagues, futureLeagues } = useMemo(() => {
    const pastLeagues = past.map(id => byId.get(id)!)
    const currentLeagues = current.map(id => byId.get(id)!)
    const futureLeagues = future.map(id => byId.get(id)!)

    return { pastLeagues, currentLeagues, futureLeagues }
  }, [past, current, future, byId])

  const onHowItWorksClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      dispatch(
        openDialog({
          type: DialogType.LeagueExplainer,
        }),
      )
    },
    [dispatch],
  )

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    setIsLoading(true)

    dispatch(
      getLeaguesList({
        signal,
        onSuccess(res) {
          setIsLoading(false)
          setError(undefined)
        },
        onError(err) {
          setIsLoading(false)
          setError(err)
          logger.error(`Error loading leagues list: ${String(err.stack ?? err)}`)
        },
      }),
    )

    return () => controller.abort()
  }, [dispatch])

  return (
    <ListRoot>
      <TitleRow>
        <Title>{t('leagues.list.pageHeadline', 'Leagues')}</Title>
        {isAdmin ? (
          <Link href='/leagues/admin'>{t('leagues.list.manageLeagues', 'Manage leagues')}</Link>
        ) : null}
        <FlexSpacer />
        <Link href='#' onClick={onHowItWorksClick}>
          {t('leagues.list.howDoLeaguesWork', 'How do leagues work?')}
        </Link>
      </TitleRow>

      {!isLoading && error ? (
        <ErrorText>{t('leagues.list.loadingError', 'Error loading leagues')}</ErrorText>
      ) : null}

      {!isLoading || currentLeagues.length ? (
        <LeagueSection
          label={t('leagues.list.currentlyRunning', 'Currently running')}
          leagues={currentLeagues}
          joinedLeagues={selfLeagues}
          type={LeagueSectionType.Current}
        />
      ) : undefined}
      {futureLeagues.length ? (
        <LeagueSection
          label={t('leagues.list.acceptingSignups', 'Accepting signups')}
          leagues={futureLeagues}
          joinedLeagues={selfLeagues}
          type={LeagueSectionType.Future}
        />
      ) : null}
      {pastLeagues.length ? (
        <LeagueSection
          label={t('leagues.list.finished', 'Finished')}
          leagues={pastLeagues}
          joinedLeagues={selfLeagues}
          type={LeagueSectionType.Past}
        />
      ) : null}

      {isLoading ? <LoadingDotsArea /> : null}
    </ListRoot>
  )
}

const SectionRoot = styled.div`
  & + & {
    margin-top: 32px;
  }
`

const SectionLabel = styled.div`
  ${subtitle1};
  color: ${colorTextSecondary};
`

const SectionCards = styled.div`
  padding-top: 8px;

  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const EmptyText = styled.div`
  ${body1};
  color: ${colorTextFaint};
`

function LeagueSection({
  label,
  leagues,
  joinedLeagues,
  type,
}: {
  label: string
  leagues: Array<ReadonlyDeep<LeagueJson>>
  joinedLeagues: ReadonlyDeep<Map<LeagueId, ClientLeagueUserJson>>
  type: LeagueSectionType
}) {
  const { t } = useTranslation()
  const curDate = Date.now()

  return (
    <SectionRoot>
      <SectionLabel>{label}</SectionLabel>
      <SectionCards>
        {leagues.length ? (
          leagues.map(l => (
            <LeagueCard
              key={l.id}
              league={l}
              type={type}
              curDate={curDate}
              joined={joinedLeagues.has(l.id)}
              actionText={t('leagues.list.viewInfo', 'View info')}
              href={urlForLeague(l.id, l)}
            />
          ))
        ) : (
          <EmptyText>{t('leagues.list.noLeagues', 'No matching leagues')}</EmptyText>
        )}
      </SectionCards>
    </SectionRoot>
  )
}

const LeagueCardRoot = styled(Card)`
  position: relative;
  width: 352px;
  padding: 0;

  display: flex;
  flex-direction: column;

  contain: content;
  cursor: pointer;
`

const LeagueImageAndBadge = styled.div`
  box-sizing: content-box;
  position: relative;
  padding-bottom: 20px;
`

const LeagueCardBadge = styled.div`
  ${shadow2dp};
  position: absolute;
  left: 12px;
  bottom: 0;
  width: 52px;
  height: 52px;
  padding: 6px;

  background: var(--sb-color-background);
  border-radius: 9999px;
`

const LeagueName = styled.div`
  ${headline6};
  margin-top: 4px;
  padding: 0 16px;
`

const LeagueFormatAndDate = styled.div`
  ${caption};
  padding: 0 16px;
`

const LeagueDescription = styled.div`
  ${body1};
  margin-top: 16px;
  padding: 0 16px;

  display: -webkit-box;
  -webkit-box-orient: vertical;
  line-clamp: 3;
  -webkit-line-clamp: 3;
  overflow: hidden;
  text-overflow: ellipsis;
`

const LeagueActions = styled.div`
  padding: 16px 0 10px 16px;

  display: flex;
  justify-content: space-between;
`

const DateTooltip = styled(Tooltip)`
  display: inline-flex;
`

const JoinedIndicator = styled.div`
  ${body1};

  display: flex;
  align-items: center;
  gap: 4px;

  color: ${colorTextFaint};
`

export function LeagueCard({
  league,
  type,
  curDate,
  joined,
  actionText,
  href,
}: {
  league: ReadonlyDeep<LeagueJson>
  type: LeagueSectionType
  curDate: number
  joined: boolean
  actionText: string
  href: string
}) {
  const { t } = useTranslation()
  const [buttonProps, rippleRef] = useButtonState({})

  let dateText: string
  let dateTooltip: string
  switch (type) {
    case LeagueSectionType.Current:
      dateText = t('leagues.list.ends', {
        defaultValue: 'Ends {{endDate}}',
        endDate: narrowDuration.format(league.endAt, curDate),
      })
      dateTooltip = longTimestamp.format(league.endAt)
      break
    case LeagueSectionType.Future:
      dateText = t('leagues.list.starts', {
        defaultValue: 'Starts {{startDate}}',
        startDate: narrowDuration.format(league.startAt, curDate),
      })
      dateTooltip = longTimestamp.format(league.startAt)
      break
    case LeagueSectionType.Past:
      dateText = `${monthDay.format(league.startAt)}\u2013${monthDay.format(league.endAt)}`
      dateTooltip = `${longTimestamp.format(league.startAt)}\u2013${longTimestamp.format(
        league.endAt,
      )}`
      break
    default:
      assertUnreachable(type)
  }

  return (
    <LinkButton href={href} tabIndex={0}>
      <LeagueCardRoot {...buttonProps}>
        <LeagueImageAndBadge>
          {league.imagePath ? <LeagueImage src={league.imagePath} /> : <LeaguePlaceholderImage />}
          <LeagueCardBadge>
            <LeagueBadge league={league} />
          </LeagueCardBadge>
        </LeagueImageAndBadge>
        <LeagueName>{league.name}</LeagueName>
        <LeagueFormatAndDate>
          {matchmakingTypeToLabel(league.matchmakingType, t)} ·{' '}
          <DateTooltip text={dateTooltip} position={'right'}>
            {dateText}
          </DateTooltip>
        </LeagueFormatAndDate>
        <LeagueDescription>{league.description}</LeagueDescription>
        <FlexSpacer />
        <LeagueActions>
          {joined ? (
            <JoinedIndicator>
              <MaterialIcon icon='check' />
              <span>{t('leagues.list.joined', 'Joined')}</span>
            </JoinedIndicator>
          ) : (
            <div />
          )}
          {/*
          NOTE(tec27): This intentionally doesn't have an onClick handler as it is handled by the
          card and having both would cause 2 navigations to occur.
        */}
          <TextButton label={actionText} color='accent' />
        </LeagueActions>
        <Ripple ref={rippleRef} />
      </LeagueCardRoot>
    </LinkButton>
  )
}
