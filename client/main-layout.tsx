import keycode from 'keycode'
import React, { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { css } from 'styled-components'
import { Link, useRoute } from 'wouter'
import { Avatar } from './avatars/avatar'
import { MaterialIcon } from './icons/material/material-icon'
import { HotkeyProp, IconButton, useButtonHotkey } from './material/button'
import { emphasizedAccelerateEasing, emphasizedDecelerateEasing } from './material/curve-constants'
import { Tooltip } from './material/tooltip'
import { NotificationsButton } from './notifications/activity-bar-entry'
import { useAppDispatch, useAppSelector } from './redux-hooks'
import { openSettings } from './settings/action-creators'
import { useMultiRef, useStableCallback } from './state-hooks'
import { singleLine, sofiaSans } from './styles/typography'

const ALT_A = { keyCode: keycode('a'), altKey: true }
// FIXME: lobbies
const ALT_B = { keyCode: keycode('b'), altKey: true }
// FIXME: create lobby
const ALT_C = { keyCode: keycode('c'), altKey: true }
const ALT_D = { keyCode: keycode('d'), altKey: true }
// FIXME: matchmaking (find match)
const ALT_F = { keyCode: keycode('f'), altKey: true }
const ALT_G = { keyCode: keycode('g'), altKey: true }
const ALT_H = { keyCode: keycode('h'), altKey: true }
// FIXME: join lobby
const ALT_J = { keyCode: keycode('j'), altKey: true }
const ALT_M = { keyCode: keycode('m'), altKey: true }
const ALT_O = { keyCode: keycode('o'), altKey: true }
const ALT_R = { keyCode: keycode('r'), altKey: true }
const ALT_S = { keyCode: keycode('s'), altKey: true }

const Root = styled.div<{ $sidebarOpen?: boolean }>`
  /* Note: width/height come from global styles */

  --sb-sidebar-width: 320px;

  display: grid;
  grid-template-columns: minmax(max-content, 1fr) ${props =>
      props.$sidebarOpen ? 'var(--sb-sidebar-width)' : '0'};
  grid-template-areas:
    'appbar appbar'
    'content sidebar';
  grid-template-rows: auto 1fr;

  transition: grid-template-columns ${props => (props.$sidebarOpen ? '400ms' : '200ms')}
    ${props => (props.$sidebarOpen ? emphasizedDecelerateEasing : emphasizedAccelerateEasing)};
`

const AppBarRoot = styled.div`
  grid-area: appbar;
  height: 72px;
  position: relative;
  padding: 0 8px 0 24px;

  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;

  color: var(--theme-on-surface-variant);

  &:before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 64px;
    background: var(--color-grey-blue40);
  }

  & > * {
    margin-bottom: 8px;
    /** Give these elements a new stacking context so they display over top of the ::before */
    position: relative;
  }
`

const AvatarSpace = styled.div`
  width: 40px;
  height: 40px;
`

const IconButtons = styled.div`
  padding-right: 8px;

  display: flex;
  align-items: center;
  justify-content: flex-end;
`

const MenuItems = styled.div`
  ${sofiaSans};
  height: 100%;
  margin-bottom: 0px; /* Allow play button to stretch the whole parent */
  /* Need space for the diagonal edges of the outer menu items to draw */
  padding: 0 20px 0 calc(20px + var(--pixel-shove-x));

  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: start;
`
const MenuItemRoot = styled.a<{ $isActive?: boolean }>`
  ${singleLine};

  position: relative;
  min-width: 140px;
  height: 64px;
  padding: 0 20px;

  display: block;

  font-size: 22px;
  font-weight: 700;
  line-height: 64px;
  text-align: center;
  text-decoration: none;
  text-shadow: 1px 1px rgba(0, 0, 0, 0.24);
  text-transform: uppercase;

  --menu-item-fill: none;

  &:link,
  &:visited {
    color: ${({ $isActive }) => ($isActive ? 'var(--theme-amber)' : 'inherit')};
  }

  @media (hover: hover) {
    &:hover {
      color: ${({ $isActive }) => ($isActive ? 'var(--theme-amber)' : 'var(--theme-on-surface)')};
      text-decoration: none;
      --menu-item-fill: var(--color-grey-blue50);

      &:before {
        content: '';
        position: absolute;
        top: 0;
        left: 20px;
        right: 20px;
        bottom: 0;
        background: var(--menu-item-fill);
      }
    }

    &:focus-visible {
      outline: none;

      &:after {
        content: '';
        position: absolute;
        top: 16px;
        left: 20px;
        right: 20px;
        bottom: 16px;
        outline: 2px solid var(--theme-amber);
        border-radius: 4px;
      }
    }
  }

  &:active {
    color: ${({ $isActive }) => ($isActive ? 'var(--theme-amber)' : 'var(--theme-on-surface)')};
    text-decoration: none;
    --menu-item-fill: var(--color-grey-blue60);

    &:before {
      content: '';
      position: absolute;
      top: 0;
      left: 20px;
      right: 20px;
      bottom: 0;
      background: var(--menu-item-fill);
    }
  }
`

const MenuItemContent = styled.span`
  position: relative;
  display: inline-block;
`

const MenuItemLeftEdge = styled.svg`
  position: absolute;
  left: 0px;
  width: 20px;
  height: 100%;
`

const MenuItemRightEdge = styled.svg`
  position: absolute;
  right: 0px;
  width: 20px;
  height: 100%;
`

const MenuItemLeftActiveStroke = styled(MenuItemLeftEdge)`
  width: 24px;
`
const MenuItemRightActiveStroke = styled(MenuItemRightEdge)`
  width: 24px;
`

const MenuItemBottomActiveStroke = styled.div`
  position: absolute;
  left: 22px;
  right: 22px;
  bottom: 0;
  height: 2px;
  background: var(--theme-amber);
`

function MenuItemStrokeGradient({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1='0' x2='0' y1='0' y2='1'>
        <stop offset='20%' stopColor='var(--theme-amber)' stopOpacity={0} />
        <stop offset='100%' stopColor='var(--theme-amber)' stopOpacity={1} />
      </linearGradient>
    </defs>
  )
}

interface MenuItemProps {
  href: string
  routePattern: string
  flipped?: boolean
  hotkey: HotkeyProp
  children: React.ReactNode
}

const MenuItem = React.forwardRef<HTMLAnchorElement, MenuItemProps>(
  ({ href, routePattern, flipped, hotkey, children }, ref) => {
    const [isActive] = useRoute(routePattern)
    const strokeLeftId = useId()
    const strokeRightId = useId()

    const [linkRef, setLinkRef] = useMultiRef(ref)
    useButtonHotkey({ ref: linkRef, hotkey })

    return (
      <Link href={href} asChild={true}>
        <MenuItemRoot ref={setLinkRef} $isActive={isActive}>
          <MenuItemLeftEdge viewBox='0 0 20 64'>
            <polygon
              points={!flipped ? '0,0 20,0 20,64' : '0, 64, 20,64, 20,0'}
              fill='var(--menu-item-fill)'
            />
          </MenuItemLeftEdge>
          <MenuItemContent>{children}</MenuItemContent>
          <MenuItemRightEdge viewBox='0 0 20 64'>
            <polygon
              points={!flipped ? '0,0 20,64 0,64' : '0,64, 20,0, 0,0'}
              fill='var(--menu-item-fill)'
            />
          </MenuItemRightEdge>

          {isActive ? (
            <>
              {/*
                Draw outline in 3 pieces (with some overlap to prevent gaps) to allow it to
                stretch if needed
              */}
              <MenuItemLeftActiveStroke viewBox='0 0 24 64'>
                <MenuItemStrokeGradient id={strokeLeftId} />
                <path
                  d={
                    !flipped
                      ? 'M1.36,1 L20.735,63 L24,63 L20.735,63 Z'
                      : 'M20.735,1 L1.36,63 L24,63 L1.36,63 Z'
                  }
                  fill='none'
                  stroke={`url(#${strokeLeftId})`}
                  strokeWidth='2'
                />
              </MenuItemLeftActiveStroke>
              <MenuItemBottomActiveStroke />
              <MenuItemRightActiveStroke viewBox='0 0 24 64'>
                <MenuItemStrokeGradient id={strokeRightId} />
                <path
                  d={
                    !flipped
                      ? 'M3.265,1 L22.64,63 L0,63 L22.64,63 Z'
                      : 'M22.64,1 L3.265,63 L0,63 L3.265,63 Z'
                  }
                  fill='none'
                  stroke={`url(#${strokeRightId})`}
                  strokeWidth='2'
                />
              </MenuItemRightActiveStroke>
            </>
          ) : null}
        </MenuItemRoot>
      </Link>
    )
  },
)

const MenuItemsStart = styled.div`
  display: flex;
  justify-content: flex-end;

  & > ${MenuItemRoot} {
    margin-inline-start: -20px;
  }
`

const MenuItemsEnd = styled.div`
  display: flex;
  justify-content: flex-start;

  & > ${MenuItemRoot} {
    margin-inline-end: -20px;
  }
`

const PlayButtonRoot = styled.a`
  ${singleLine};

  position: relative;
  width: 240px;
  height: 72px;
  margin: 0 -16px;

  display: block;
  overflow: visible; /* Allow the shadow to exceed bounds */

  color: var(--theme-on-surface);
  font-size: 36px;
  font-weight: 700;
  line-height: 72px;
  text-align: center;
  text-shadow: 1px 1px rgba(0, 0, 0, 0.24);
  text-transform: uppercase;

  &:link,
  &:visited {
    color: var(--theme-on-surface);
  }

  @media (hover: hover) {
    &:hover {
      color: var(--theme-on-surface);
      text-decoration: none;
    }

    &:focus-visible {
      outline: none;

      &:after {
        content: '';
        position: absolute;
        top: 16px;
        left: 20px;
        right: 20px;
        bottom: 16px;
        outline: 2px solid var(--theme-amber);
        border-radius: 4px;
      }
    }
  }

  &:active {
    color: var(--theme-on-surface);
    text-decoration: none;
    --menu-item-fill: var(--color-grey-blue60);

    &:before {
      content: '';
      position: absolute;
      top: 0;
      left: 20px;
      right: 20px;
      bottom: 0;
      background: var(--menu-item-fill);
    }
  }
`

const PlayButtonBackground = styled.svg`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;

  && {
    overflow: visible; /* Allow the shadow to exceed bounds */
  }
`

const PlayButtonContent = styled.div`
  contain: paint;
`

function PlayButton({ children }: { children?: React.ReactNode }) {
  const gradientId = useId()
  const shadowId = useId()

  return (
    <Link href='/play/' asChild={true}>
      <PlayButtonRoot>
        <PlayButtonBackground viewBox='0 0 240 72'>
          <defs>
            <linearGradient
              id={gradientId}
              x1='52'
              y1='-20'
              x2='188'
              y2='88'
              gradientUnits='userSpaceOnUse'>
              <stop stopColor='var(--color-blue70)' />
              <stop offset='0.418214' stopColor='var(--color-blue50)' />
              <stop offset='0.68' stopColor='var(--color-blue50)' />
              <stop offset='1' stopColor='var(--color-blue60)' />
            </linearGradient>
            {/*
            NOTE(tec27): This is a level 2 elevation shadow copied out of figma, we could probably
            simplify this a bunch
          */}
            <filter
              id={shadowId}
              x='-10'
              y='0'
              width='260'
              height='80'
              filterUnits='userSpaceOnUse'
              colorInterpolationFilters='sRGB'>
              <feFlood floodOpacity='0' result='BackgroundImageFix' />
              <feColorMatrix
                in='SourceAlpha'
                type='matrix'
                values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0'
                result='hardAlpha'
              />
              <feMorphology
                radius='2'
                operator='dilate'
                in='SourceAlpha'
                result='effect1_dropShadow_634_1625'
              />
              <feOffset dy='2' />
              <feGaussianBlur stdDeviation='3' />
              <feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.15 0' />
              <feBlend
                mode='normal'
                in2='BackgroundImageFix'
                result='effect1_dropShadow_634_1625'
              />
              <feColorMatrix
                in='SourceAlpha'
                type='matrix'
                values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0'
                result='hardAlpha'
              />
              <feOffset dy='1' />
              <feGaussianBlur stdDeviation='1' />
              <feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.3 0' />
              <feBlend
                mode='normal'
                in2='effect1_dropShadow_634_1625'
                result='effect2_dropShadow_634_1625'
              />
              <feBlend
                mode='normal'
                in='SourceGraphic'
                in2='effect2_dropShadow_634_1625'
                result='shape'
              />
            </filter>
          </defs>
          <polygon
            points={`0,0 240,0 218,72 22,72`}
            fill={`url(#${gradientId})`}
            filter={`url(#${shadowId})`}
          />
          <path
            d={`
            M 239,0
            L 217,71
            L 23,71
            L 1,0
            L 23,71
            L 217,71
            Z
          `}
            fill='none'
            stroke='var(--color-blue90)'
            strokeWidth='2'
            strokeOpacity='0.4'
            strokeLinecap='square'
          />
        </PlayButtonBackground>
        <PlayButtonContent>{children}</PlayButtonContent>
      </PlayButtonRoot>
    </Link>
  )
}

const ShadowedIcon = styled(MaterialIcon)`
  text-shadow: 1px 1px rgba(0, 0, 0, 0.24);
`

const ShadowedToggleIcon = styled(ShadowedIcon)<{ $active?: boolean }>`
  ${props =>
    props.$active
      ? css`
          color: var(--theme-amber);
        `
      : css``};
  transition: color 250ms linear;
`

function AppBar({
  onToggleSocial,
  sidebarOpen,
}: {
  onToggleSocial: () => void
  sidebarOpen: boolean
}) {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const user = useAppSelector(s => s.auth.self?.user)

  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  useButtonHotkey({ ref: settingsButtonRef, hotkey: ALT_S })
  const chatButtonRef = useRef<HTMLButtonElement>(null)
  useButtonHotkey({ ref: chatButtonRef, hotkey: ALT_H })

  return (
    <AppBarRoot>
      <AvatarSpace>{user ? <Avatar user={user.name} /> : null}</AvatarSpace>
      <MenuItems>
        <MenuItemsStart>
          <MenuItem href='/' routePattern='/' hotkey={ALT_O}>
            {t('navigation.bar.home', 'Home')}
          </MenuItem>
          <MenuItem href='/games/' routePattern='/games/*?' hotkey={ALT_G}>
            {t('games.activity.title', 'Games')}
          </MenuItem>
          <MenuItem href='/replays/' routePattern='/replays/*?' hotkey={ALT_R}>
            {t('replays.activity.title', 'Replays')}
          </MenuItem>
        </MenuItemsStart>
        <PlayButton>{t('navigation.bar.play', 'Play')}</PlayButton>
        <MenuItemsEnd>
          <MenuItem href='/maps/' routePattern='/maps/*?' flipped={true} hotkey={ALT_M}>
            {t('maps.activity.title', 'Maps')}
          </MenuItem>
          <MenuItem href='/ladder/' routePattern='/ladder/*?' flipped={true} hotkey={ALT_D}>
            {t('ladder.activity.title', 'Ladder')}
          </MenuItem>
          <MenuItem href='/leagues/' routePattern='/leagues/*?' flipped={true} hotkey={ALT_A}>
            {t('leagues.activity.title', 'Leagues')}
          </MenuItem>
        </MenuItemsEnd>
      </MenuItems>
      <IconButtons>
        <Tooltip
          text={t('settings.activity.title', 'Settings (Alt + S)')}
          position='bottom'
          tabIndex={-1}>
          <IconButton
            ref={settingsButtonRef}
            icon={<ShadowedIcon icon='settings' />}
            onClick={() => dispatch(openSettings())}
            testName='settings-button'
          />
        </Tooltip>
        <NotificationsButton icon={<ShadowedIcon icon='notifications' />} />
        <Tooltip
          text={t('navigation.bar.social', 'Toggle social (ALT + H)')}
          position='bottom'
          tabIndex={-1}>
          <IconButton
            ref={chatButtonRef}
            icon={<ShadowedToggleIcon icon='chat' $active={sidebarOpen} />}
            onClick={onToggleSocial}
            testName='social-sidebar-button'
          />
        </Tooltip>
      </IconButtons>
    </AppBarRoot>
  )
}

const Content = styled.div`
  grid-area: content;
  padding-left: var(--pixel-shove-x);
  padding-top: 12px;

  display: flex;
  flex-direction: column;
  align-items: center;

  overflow: auto;
`

const Sidebar = styled.div`
  grid-area: sidebar;

  position: relative;
  width: 100%;
  height: calc(100% + 8px);
  margin-top: -8px;

  background-color: var(--theme-surface);
  overflow-x: hidden;

  &:before {
    position: absolute;
    width: 1px;
    height: 100%;
    left: 0;

    content: '';
    background-color: var(--theme-outline);
  }
`

export function MainLayout({ children }: { children?: React.ReactNode }) {
  // TODO(tec27): Store in localStorage per user
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // TODO(tec27): Place focus inside the social sidebar when it opens (maybe pick the spot to focus
  // [e.g. channels or whispers] based on how it got opened?)
  const onToggleSocial = useStableCallback(() => setSidebarOpen(!sidebarOpen))

  return (
    <Root $sidebarOpen={sidebarOpen}>
      <AppBar onToggleSocial={onToggleSocial} sidebarOpen={sidebarOpen} />
      <Content>{children}</Content>
      <Sidebar />
    </Root>
  )
}
