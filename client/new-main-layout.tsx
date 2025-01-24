import React from 'react'
import styled from 'styled-components'
import { Avatar } from './avatars/avatar'
import { useAppSelector } from './redux-hooks'
import { singleLine, sofiaSans } from './styles/typography'

const Root = styled.div`
  /* Note: width/height come from global styles */
  display: grid;
  grid-template-rows: auto 1fr;
`

const AppBarRoot = styled.div`
  height: 72px;
  position: relative;
  padding: 0 8px 0 24px;
  color: var(--theme-on-surface-variant);

  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;

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
    contain: paint;
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

  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: start;
`

const MenuItemRoot = styled.div`
  ${singleLine};

  height: 64px;
  width: 140px;
  padding: 0 12px;

  font-size: 22px;
  font-weight: 700;
  line-height: 64px;
  text-align: center;
  text-shadow: 1px 1px rgba(0, 0, 0, 0.24);
  text-transform: uppercase;

  background-color: rgba(255, 255, 255, 0.2);
`

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

const PlayButtonRoot = styled.div`
  ${singleLine};

  width: 240px;
  height: 72px;
  margin: 0 -20px;

  color: var(--theme-on-surface);
  font-size: 36px;
  font-weight: 700;
  line-height: 72px;
  text-align: center;
  text-shadow: 1px 1px rgba(0, 0, 0, 0.24);
  text-transform: uppercase;

  background-color: rgba(0, 0, 255, 0.2);
`

function AppBar() {
  const user = useAppSelector(s => s.auth.self?.user)

  return (
    <AppBarRoot>
      <AvatarSpace>{user ? <Avatar user={user.name} /> : null}</AvatarSpace>
      <MenuItems>
        <MenuItemsStart>
          <MenuItemRoot>Home</MenuItemRoot>
          <MenuItemRoot>Games</MenuItemRoot>
          <MenuItemRoot>Replays</MenuItemRoot>
        </MenuItemsStart>
        <PlayButtonRoot>Play</PlayButtonRoot>
        <MenuItemsEnd>
          <MenuItemRoot>Maps</MenuItemRoot>
          <MenuItemRoot>Ladder</MenuItemRoot>
          <MenuItemRoot>Leagues</MenuItemRoot>
        </MenuItemsEnd>
      </MenuItems>
      <IconButtons>Icon Buttons</IconButtons>
    </AppBarRoot>
  )
}

const Content = styled.div``

export function MainLayout() {
  return (
    <Root>
      <AppBar />
      <Content>
        <h1>Main Layout</h1>
      </Content>
    </Root>
  )
}
