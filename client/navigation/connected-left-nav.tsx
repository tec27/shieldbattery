import keycode from 'keycode'
import React, { useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { UseTransitionProps } from 'react-spring'
import styled from 'styled-components'
import { useLocation } from 'wouter'
import { SbChannelId } from '../../common/chat'
import { NEWS_PAGE } from '../../common/flags'
import { matchmakingTypeToLabel } from '../../common/matchmaking'
import { urlPath } from '../../common/urls'
import { SbUserId } from '../../common/users/sb-user'
import GameActivityNavEntry from '../active-game/game-activity-nav-entry'
import { logOut } from '../auth/action-creators'
import { redirectToLogin, useSelfUser } from '../auth/auth-utils'
import { openChangelog } from '../changelog/action-creators'
import { leaveChannel } from '../chat/action-creators'
import { ChatNavEntry } from '../chat/nav-entry'
import { openDialog } from '../dialogs/action-creators'
import { DialogType } from '../dialogs/dialog-type'
import DiscordIcon from '../icons/brands/discord.svg'
import GitHubIcon from '../icons/brands/github.svg'
import KofiColorIcon from '../icons/brands/kofi-color.svg'
import PatreonIcon from '../icons/brands/patreon.svg'
import TwitterIcon from '../icons/brands/twitter.svg'
import { MaterialIcon } from '../icons/material/material-icon'
import { leaveLobby } from '../lobbies/action-creators'
import LobbyNavEntry from '../lobbies/nav-entry'
import { cancelFindMatch } from '../matchmaking/action-creators'
import { isMatchmakingLoading } from '../matchmaking/matchmaking-reducer'
import { SearchingMatchNavEntry } from '../matchmaking/searching-match-nav-entry'
import { RaisedButton, useButtonHotkey } from '../material/button'
import { ClickableSubheader } from '../material/left-nav/clickable-subheader'
import { Entry } from '../material/left-nav/entry'
import LeftNav from '../material/left-nav/left-nav'
import Section from '../material/left-nav/section'
import Subheader from '../material/left-nav/subheader'
import { SubheaderButton } from '../material/left-nav/subheader-button'
import { Divider as MenuDivider } from '../material/menu/divider'
import { MenuItem } from '../material/menu/item'
import { MenuList } from '../material/menu/menu'
import { Popover, useAnchorPosition, usePopoverController } from '../material/popover'
import { defaultSpring } from '../material/springs'
import { Tooltip } from '../material/tooltip'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { TIMING_LONG, openSnackbar } from '../snackbars/action-creators'
import { useStableCallback } from '../state-hooks'
import { colorTextSecondary } from '../styles/colors'
import { overline, singleLine } from '../styles/typography'
import { navigateToUserProfile } from '../users/action-creators'
import ProfileNavEntry from '../users/nav-entry'
import { SelfProfileOverlay } from '../users/self-profile-overlay'
import { closeWhisperSession } from '../whispers/action-creators'
import { ConnectedWhisperNavEntry } from '../whispers/nav-entry'
import Lockup from './lockup'
import { push } from './routing'

const ALT_H = { keyCode: keycode('h'), altKey: true }
const ALT_W = { keyCode: keycode('w'), altKey: true }

const SectionSpacer = styled.hr`
  border: none;
  margin-top: 16px;
`

const LockupContainer = styled.div`
  position: relative;
  width: 100%;
`

const AppMenu = styled(MenuList)`
  width: 256px;
  max-height: 420px;
`

const AppMenuOverline = styled.div`
  ${overline};
  ${singleLine};
  color: ${colorTextSecondary};
  padding: 8px 12px 0;
`

const StyledTwitterIcon = styled(TwitterIcon)`
  color: #1d9bf0;
`

const StyledPatreonIcon = styled(PatreonIcon)`
  color: #ff424e;
`

const APP_MENU_LINKS: Array<[text?: string, icon?: React.ReactNode, url?: string]> = [
  ['Discord', <DiscordIcon key='discord' />, 'https://discord.gg/S8dfMx94a4'],
  ['Twitter', <StyledTwitterIcon key='twitter' />, 'https://twitter.com/ShieldBatteryBW'],
  ['GitHub', <GitHubIcon key='github' />, 'https://github.com/ShieldBattery/ShieldBattery'],
  [],
  ['Support the project'],
  ['Patreon', <StyledPatreonIcon key='patreon' />, 'https://patreon.com/tec27'],
  [
    'GitHub Sponsors',
    <GitHubIcon key='githubsponsors' />,
    'https://github.com/sponsors/ShieldBattery',
  ],
  ['Ko-fi', <KofiColorIcon key='kofi' />, 'https://ko-fi.com/tec27'],
]

const MENU_TRANSITION: UseTransitionProps<boolean> = {
  from: { opacity: 0, scaleY: 0.5 },
  enter: { opacity: 1, scaleY: 1 },
  leave: { opacity: 0, scaleY: 0 },
  config: (item, index, phase) => key =>
    phase === 'leave' || key === 'opacity' ? { ...defaultSpring, clamp: true } : defaultSpring,
}

function LockupAndMenu() {
  const [appMenuOpen, openAppMenu, closeAppMenu] = usePopoverController()
  const [appMenuAnchor, anchorX, anchorY] = useAnchorPosition('center', 'bottom')

  const appMenuItems = useMemo(
    () =>
      APP_MENU_LINKS.map(([text, icon, url], i) => {
        if (text && url) {
          return (
            <MenuItem
              key={i}
              text={text}
              icon={icon}
              onClick={() => {
                window.open(url as string, '_blank')
                closeAppMenu()
              }}
            />
          )
        } else if (text) {
          return <AppMenuOverline key={i}>{text}</AppMenuOverline>
        } else {
          return <MenuDivider key={i} />
        }
      }),
    [closeAppMenu],
  )

  return (
    <LockupContainer>
      <Lockup ref={appMenuAnchor} onClick={openAppMenu} menuOpened={appMenuOpen} />
      <Popover
        open={appMenuOpen}
        onDismiss={closeAppMenu}
        anchorX={(anchorX ?? 0) - 8}
        anchorY={(anchorY ?? 0) + 8}
        originX='center'
        originY='top'
        transitionProps={MENU_TRANSITION}>
        <AppMenu>{appMenuItems}</AppMenu>
      </Popover>
    </LockupContainer>
  )
}

function SearchingMatchSection() {
  const dispatch = useAppDispatch()
  const searchInfo = useAppSelector(s => s.matchmaking.searchInfo)
  const isGameInProgress = useAppSelector(
    s => s.matchmaking.isLaunching || s.matchmaking.isCountingDown || s.matchmaking.isStarting,
  )
  const match = useAppSelector(s => s.matchmaking.match)

  const onCancel = useCallback(() => {
    dispatch(cancelFindMatch())
  }, [dispatch])

  if (!searchInfo || isGameInProgress) {
    return null
  }

  return (
    <>
      <Section key='searching-match-section'>
        <SearchingMatchNavEntry
          isMatched={!!match}
          startTime={searchInfo.startTime}
          matchmakingType={searchInfo.matchmakingType}
          onCancelSearch={onCancel}
        />
      </Section>
      <SectionSpacer key='searching-match-divider' />
    </>
  )
}

function LoadingGameSection() {
  const { t } = useTranslation()
  const isLobbyLoading = useAppSelector(s => s.lobby.info.isLoading)
  const lobbyName = useAppSelector(s => s.lobby.info.name)
  const isMatchLoading = useAppSelector(s => isMatchmakingLoading(s.matchmaking))
  const matchmakingType = useAppSelector(s => s.matchmaking.match?.type)
  const matchmakingLaunching = useAppSelector(s => s.matchmaking.isLaunching)
  const matchmakingCountingDown = useAppSelector(s => s.matchmaking.isCountingDown)
  const matchmakingStarting = useAppSelector(s => s.matchmaking.isStarting)
  const [currentPath] = useLocation()

  if (!isLobbyLoading && !isMatchLoading) return null

  let link: string
  let title: string
  if (isLobbyLoading) {
    link = urlPath`/lobbies/${lobbyName}/loading-game`
    title = t('navigation.leftNav.customGame', 'Custom game')
  } else if (isMatchLoading) {
    title = t('navigation.leftNav.rankedGame', {
      defaultValue: 'Ranked {{matchmakingType}}',
      matchmakingType: matchmakingType ? matchmakingTypeToLabel(matchmakingType, t) : '',
    })

    if (matchmakingLaunching) {
      link = '/matchmaking/countdown'
    } else if (matchmakingCountingDown) {
      link = '/matchmaking/countdown'
    } else if (matchmakingStarting) {
      link = '/matchmaking/game-starting'
    } else {
      // This should never really happen but it makes TS happy
      link = '/matchmaking/countdown'
    }
  } else {
    return null
  }

  return (
    <>
      <Section key='loading-game-section'>
        <GameActivityNavEntry
          key='loading-game'
          link={link}
          currentPath={currentPath}
          title={title}
          subtitle={t('navigation.leftNav.loadingGame', 'Loading…')}
        />
      </Section>
      <SectionSpacer key='loading-game-divider' />
    </>
  )
}

function ActiveGameSection() {
  const { t } = useTranslation()
  const isActive = useAppSelector(s => s.activeGame.isActive)
  const gameInfo = useAppSelector(s => s.activeGame.info)
  const [currentPath] = useLocation()

  if (!isActive || !gameInfo) {
    return null
  }

  let link: string
  let title: string
  if (gameInfo.type === 'lobby') {
    link = urlPath`/lobbies/${gameInfo.extra.lobby.info.name}/active-game`
    title = t('navigation.leftNav.customGame', 'Custom game')
  } else if (gameInfo.type === 'matchmaking') {
    link = '/matchmaking/active-game'
    title = t('navigation.leftNav.rankedGame', {
      defaultValue: 'Ranked {{matchmakingType}}',
      matchmakingType: matchmakingTypeToLabel(gameInfo.extra.match.type, t),
    })
  } else {
    return null
  }

  return (
    <>
      <Section key='active-game-section'>
        <GameActivityNavEntry
          key='active-game'
          link={link}
          currentPath={currentPath}
          title={title}
          subtitle={t('navigation.leftNav.gameInProgress', 'Game in progress…')}
        />
      </Section>
      <SectionSpacer key='active-game-divider' />
    </>
  )
}

function LobbySection() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const lobbyName = useAppSelector(s => s.lobby.info.name)
  const hasUnread = useAppSelector(s => s.lobby.hasUnread)
  const inLobby = useAppSelector(s => s.lobby.inLobby)
  const [currentPath] = useLocation()

  const onLeaveLobbyClick = useCallback(() => {
    dispatch(leaveLobby())
  }, [dispatch])

  if (!inLobby) {
    return null
  }

  return (
    <>
      <Subheader key='lobby-header'>{t('navigation.leftNav.lobby', 'Lobby')}</Subheader>
      <Section key='lobby-section'>
        <LobbyNavEntry
          key='lobby'
          lobby={lobbyName}
          currentPath={currentPath}
          hasUnread={hasUnread}
          onLeaveClick={onLeaveLobbyClick}
        />
      </Section>
      <SectionSpacer key='lobby-divider' />
    </>
  )
}

function ConnectedChatNavEntry({
  channelId,
  onLeave,
}: {
  channelId: SbChannelId
  onLeave: (channelId: SbChannelId) => void
}) {
  const { t } = useTranslation()
  const channelInfo = useAppSelector(s => s.chat.idToBasicInfo.get(channelId))
  const hasUnread = useAppSelector(s => s.chat.unreadChannels.has(channelId))
  const [pathname] = useLocation()

  return (
    <ChatNavEntry
      channelId={channelId}
      channelName={channelInfo?.name ?? t('navigation.leftNav.loadingChannel', 'Loading…')}
      currentPath={pathname}
      hasUnread={hasUnread}
      onLeave={onLeave}
    />
  )
}

function HomeNavEntry() {
  const { t } = useTranslation()
  const [pathname] = useLocation()

  return (
    <Entry link='/' currentPath={pathname}>
      {t('navigation.leftNav.home', 'Home')}
    </Entry>
  )
}

export function ConnectedLeftNav() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const selfUser = useSelfUser()!
  const chatChannels = useAppSelector(s => s.chat.joinedChannels)
  const whisperSessions = useAppSelector(s => s.whispers.sessions)

  const [profileOverlayOpen, openProfileOverlay, closeProfileOverlay] = usePopoverController()
  const profileEntryRef = useRef<HTMLButtonElement>(null)
  const joinChannelButtonRef = useRef<HTMLButtonElement>(null)
  const startWhisperButtonRef = useRef<HTMLButtonElement>(null)

  useButtonHotkey({ ref: joinChannelButtonRef, hotkey: ALT_H })
  useButtonHotkey({ ref: startWhisperButtonRef, hotkey: ALT_W })

  const onLogOutClick = useStableCallback(() => {
    closeProfileOverlay()
    dispatch(logOut().action)
  })
  const onChangelogClick = useStableCallback(() => {
    closeProfileOverlay()
    dispatch(openChangelog())
  })
  const onViewProfileClick = useStableCallback(() => {
    closeProfileOverlay()
    navigateToUserProfile(selfUser.id, selfUser.name)
  })
  const onReportBugClick = useStableCallback(() => {
    closeProfileOverlay()
    dispatch(openDialog({ type: DialogType.BugReport }))
  })

  const footer = (
    <>
      <ProfileNavEntry
        key='profileEntry'
        ref={profileEntryRef}
        user={selfUser.name}
        onProfileEntryClick={openProfileOverlay}
        profileMenuOpen={profileOverlayOpen}
      />
    </>
  )

  const onChannelLeave = useCallback(
    (channelId: SbChannelId) => {
      dispatch(leaveChannel(channelId))
    },
    [dispatch],
  )
  const onAddWhisperClick = useCallback(() => {
    dispatch(openDialog({ type: DialogType.Whispers }))
  }, [dispatch])
  const onWhisperClose = useCallback(
    (userId: SbUserId) => {
      dispatch(
        closeWhisperSession(userId, {
          onSuccess: () => {},
          onError: err => {
            dispatch(
              openSnackbar({
                message: t('navigation.leftNav.whisperCloseError', {
                  defaultValue: 'Error closing whisper session: {{errorMessage}}',
                  errorMessage: err.message,
                }),
                time: TIMING_LONG,
              }),
            )
          },
        }),
      )
    },
    [dispatch, t],
  )

  const addWhisperButton = (
    <Tooltip
      text={t('navigation.leftNav.startWhisper', 'Start a whisper (Alt + W)')}
      position='right'>
      <SubheaderButton
        ref={startWhisperButtonRef}
        icon={<MaterialIcon icon='add' />}
        onClick={onAddWhisperClick}
      />
    </Tooltip>
  )

  return (
    <LeftNav header={<LockupAndMenu />} footer={footer}>
      {IS_ELECTRON ? <SearchingMatchSection /> : null}
      {IS_ELECTRON ? <LoadingGameSection /> : null}
      {IS_ELECTRON ? <ActiveGameSection /> : null}
      {IS_ELECTRON ? <LobbySection /> : null}
      {NEWS_PAGE ? (
        <>
          <HomeNavEntry />
          <SectionSpacer />
        </>
      ) : null}
      <Tooltip
        text={t('navigation.leftNav.joinChannel', 'Join a channel (Alt + H)')}
        position='right'>
        <ClickableSubheader
          ref={joinChannelButtonRef}
          href={urlPath`/chat/list`}
          icon={<MaterialIcon icon='add' />}>
          {t('navigation.leftNav.chatChannels', 'Chat channels')}
        </ClickableSubheader>
      </Tooltip>
      <Section>
        {Array.from(chatChannels.values(), c => (
          <ConnectedChatNavEntry key={c} channelId={c} onLeave={onChannelLeave} />
        ))}
      </Section>
      <SectionSpacer />
      <Subheader button={addWhisperButton}>
        {t('navigation.leftNav.whispers', 'Whispers')}
      </Subheader>
      <Section>
        {Array.from(whisperSessions.values(), w => (
          <ConnectedWhisperNavEntry key={w} userId={w} onClose={onWhisperClose} />
        ))}
      </Section>

      <SelfProfileOverlay
        popoverProps={{
          open: profileOverlayOpen,
          onDismiss: closeProfileOverlay,
        }}
        anchor={profileEntryRef.current}
        username={selfUser.name}>
        <MenuItem
          icon={<MaterialIcon icon='account_box' />}
          text={t('navigation.leftNav.viewProfile', 'View profile')}
          onClick={onViewProfileClick}
        />
        <MenuItem
          icon={<MaterialIcon icon='new_releases' />}
          text={t('navigation.leftNav.viewChangelog', 'View changelog')}
          onClick={onChangelogClick}
        />
        {IS_ELECTRON ? (
          <MenuItem
            icon={<MaterialIcon icon='bug_report' />}
            text={t('navigation.leftNav.reportBug', 'Report a bug')}
            onClick={onReportBugClick}
          />
        ) : undefined}
        <MenuDivider />
        <MenuItem
          icon={<MaterialIcon icon='logout' />}
          text={t('navigation.leftNav.logOut', 'Log out')}
          onClick={onLogOutClick}
        />
      </SelfProfileOverlay>
    </LeftNav>
  )
}

const LoggedOutFooter = styled.div`
  padding: 16px;

  display: flex;
  flex-direction: column;
`

export function LoggedOutLeftNav() {
  const { t } = useTranslation()
  const footer = (
    <LoggedOutFooter>
      <RaisedButton
        label={t('navigation.leftNav.logIn', 'Log in')}
        onClick={() => redirectToLogin(push)}
      />
    </LoggedOutFooter>
  )

  // TODO(tec27): Add some encouragement to log in
  return (
    <LeftNav header={<LockupAndMenu />} footer={footer}>
      {NEWS_PAGE ? <HomeNavEntry /> : null}
    </LeftNav>
  )
}
