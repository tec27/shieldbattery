import React, { useCallback, useLayoutEffect } from 'react'
import styled from 'styled-components'
import { DEV_INDICATOR } from '../../common/flags'
import { useIsAdmin } from '../admin/admin-permissions'
import { MaterialIcon } from '../icons/material/material-icon'
import Logo from '../logos/logo-no-bg.svg'
import LogoText from '../logos/logotext-white-154x56.svg'
import { IconButton } from '../material/button'
import { zIndexAppBar } from '../material/zindex'
import { push } from '../navigation/routing'
import { colorError } from '../styles/colors'
import { caption } from '../styles/typography'
import { SizeLeft, SizeRight, SizeTop } from './window-controls'

const Container = styled.header`
  flex-grow: 0;
  flex-shrink: 0;

  width: 100%;
  height: 24px;
  margin: 0;
  padding: 0;
  position: relative;

  display: flex;
  flex-direction: row;
  background-color: var(--color-grey-blue30);
  overflow: hidden;
  z-index: ${zIndexAppBar};

  -webkit-app-region: drag;
`

const LeftSide = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const StyledIconButton = styled(IconButton)`
  width: 48px;
  min-height: 24px;
  padding: 0;
  -webkit-app-region: no-drag;
`

const DevIndicator = styled.div`
  ${caption};

  width: 80px;
  height: 16px;
  margin-left: 4px;

  background-color: ${colorError};
  border-radius: 2px;
  cursor: pointer;
  font-weight: 600;
  letter-spacing: 2px;
  line-height: 16px;
  opacity: 0.84;
  text-align: center;
  text-transform: uppercase;
  -webkit-app-region: no-drag;
`

const SystemBarLogo = styled.div`
  display: flex;
  align-items: center;
`

// FIXME: Make this 20px tall once we have a proper version of this asset for this
const StyledLogo = styled(Logo)`
  width: auto;
  height: 30px;

  flex: 0 0 auto;
`

// FIXME: Make this 24px tall once we have a proper version of this asset for this
const StyledLogoText = styled(LogoText)`
  width: auto;
  height: 36px;

  flex: 0 0 auto;
`

export function SystemBar() {
  useLayoutEffect(() => {
    document.body.style.setProperty('--sb-system-bar-height', '24px')
    return () => {
      document.body.style.removeProperty('--sb-system-bar-height')
    }
  }, [])
  const isAdmin = useIsAdmin()
  const onAdminClick = useCallback(() => {
    push('/admin')
  }, [])

  return (
    <Container>
      <SizeTop />
      <SizeLeft />
      <SizeRight />
      <LeftSide>
        <SystemBarLogo>
          <StyledLogo />
          <StyledLogoText />
        </SystemBarLogo>
        {DEV_INDICATOR ? (
          // TODO(tec27): Find a place for this + admin that will show up on the web version too
          <DevIndicator title='Go to dev pages' onClick={() => push('/dev')}>
            Dev
          </DevIndicator>
        ) : null}
        {isAdmin ? (
          <StyledIconButton
            title='Admin'
            icon={<MaterialIcon icon='admin_panel_settings' size={20} filled={false} />}
            onClick={onAdminClick}
          />
        ) : null}
      </LeftSide>
    </Container>
  )
}
