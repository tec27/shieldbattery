import React, { useEffect, useLayoutEffect, useState } from 'react'
import { StyleSheetManager } from 'styled-components'
import { Provider as UrqlProvider } from 'urql'
import { Route, Switch } from 'wouter'
import { useIsAdmin } from './admin/admin-permissions'
import { revokeSession } from './auth/action-creators'
import { EmailVerificationUi } from './auth/email-verification'
import { ForgotPassword, ForgotUser, ResetPassword } from './auth/forgot'
import { Login } from './auth/login'
import { Signup } from './auth/signup'
import { ChannelRouteComponent } from './chat/route'
import { ConnectedDialogOverlay } from './dialogs/connected-dialog-overlay'
import { usePixelShover } from './dom/pixel-shover'
import { DownloadPage } from './download/download-page'
import { UpdateOverlay } from './download/update-overlay'
import { FileDropZoneProvider } from './file-browser/file-drop-zone'
import { GamesRouteComponent } from './games/route'
import { Home } from './home'
import { KeyListenerBoundary } from './keyboard/key-listener'
import { LadderRouteComponent } from './ladder/ladder'
import { Faq } from './landing/faq'
import { LeagueRoot } from './leagues/league-list'
import { logger } from './logging/logger'
import { LoginRoute } from './navigation/custom-routes'
import { UNAUTHORIZED_EMITTER } from './network/fetch'
import { createGraphqlClient } from './network/graphql-client'
import { MainLayout } from './new-main-layout'
import {
  AcceptableUsePage,
  PrivacyPolicyPage,
  TermsOfServicePage,
} from './policies/policy-displays'
import DotsIndicator, { LoadingDotsArea } from './progress/dots'
import { useAppDispatch, useAppSelector } from './redux-hooks'
import { RootErrorBoundary } from './root-error-boundary'
import { getServerConfig } from './server-config-storage'
import { ConnectedSettings } from './settings/settings'
import ConnectedSnackbar from './snackbars/connected-snackbar'
import GlobalStyle from './styles/global'
import ResetStyle from './styles/reset'
import { ProfileRouteComponent } from './users/route'
import { WhisperRouteComponent } from './whispers/route'

const IS_PRODUCTION = __WEBPACK_ENV.NODE_ENV === 'production'

const DevComponent = IS_PRODUCTION ? () => null : React.lazy(() => import('./dev'))

function LoadableDev() {
  return (
    <React.Suspense fallback={<LoadingDotsArea />}>
      <DevComponent />
    </React.Suspense>
  )
}

const LoadableWindowControls = IS_ELECTRON
  ? React.lazy(async () => ({
      default: (await import('./system-bar/window-controls')).WindowControls,
    }))
  : () => null

const LoadableSystemBar = IS_ELECTRON
  ? React.lazy(async () => ({ default: (await import('./system-bar/system-bar')).SystemBar }))
  : () => null

function RedirectOnUnauthorized() {
  const dispatch = useAppDispatch()

  useEffect(() => {
    const handler = (url: string) => {
      logger.debug(`Got 401 Unauthorized response for: ${url}, removing active user session`)
      dispatch(revokeSession())
    }

    UNAUTHORIZED_EMITTER.on('unauthorized', handler)

    return () => {
      UNAUTHORIZED_EMITTER.removeListener('unauthorized', handler)
    }
  }, [dispatch])

  return null
}

/**
 * Returns the current GraphQL client, recreating it if the current user changes. This ensures that
 * any user-specific data in the caches is cleared out.
 */
function useUserSpecificGraphqlClient() {
  const currentUserId = useAppSelector(s => s.auth.self?.user.id)
  const [urqlClient, setUrqlClient] = useState<ReturnType<typeof createGraphqlClient>>(() =>
    createGraphqlClient(getServerConfig()),
  )

  useEffect(() => {
    setUrqlClient(createGraphqlClient(getServerConfig()))
  }, [currentUserId])

  return urqlClient
}

const AdminPanelComponent = React.lazy(() => import('./admin/panel'))

function LoadableAdminPanel() {
  // TODO(tec27): do we need to position this indicator differently? (or pull that into a common
  // place?)
  return (
    <React.Suspense fallback={<DotsIndicator />}>
      <AdminPanelComponent />
    </React.Suspense>
  )
}

function AppRoutes() {
  const isAdmin = useIsAdmin()
  return (
    <Switch>
      <Route path='/faq' component={Faq} />
      <Route path='/download' component={DownloadPage} />
      <Route path='/acceptable-use' component={AcceptableUsePage} />
      <Route path='/privacy' component={PrivacyPolicyPage} />
      <Route path='/terms-of-service' component={TermsOfServicePage} />
      <LoginRoute path='/forgot-password' component={ForgotPassword} />
      <LoginRoute path='/forgot-user' component={ForgotUser} />
      <LoginRoute path='/login' component={Login} />
      <LoginRoute path='/reset-password' component={ResetPassword} />
      <LoginRoute path='/signup' component={Signup} />
      <LoginRoute path='/verify-email' component={EmailVerificationUi} />
      {isAdmin ? <Route path='/admin/*?' component={LoadableAdminPanel} /> : null}
      <Route path='/chat/*?' component={ChannelRouteComponent} />
      <Route path='/games/*?' component={GamesRouteComponent} />
      <Route path='/ladder/*?' component={LadderRouteComponent} />
      <Route path='/leagues/*?' component={LeagueRoot} />
      {/* FIXME lobbyRoute */}
      {/* FIXME matchmakingRoute */}
      <Route path='/users/*?' component={ProfileRouteComponent} />
      <Route path='/whispers/*?' component={WhisperRouteComponent} />
      <Route component={Home} />
    </Switch>
  )
}

export default function App() {
  const [shoveX, shoveY] = usePixelShover()
  useLayoutEffect(() => {
    document.body.style.setProperty('--pixel-shove-x', `${shoveX}px`)
    document.body.style.setProperty('--pixel-shove-y', `${shoveY}px`)
  }, [shoveX, shoveY])
  const graphqlClient = useUserSpecificGraphqlClient()

  return (
    <StyleSheetManager disableVendorPrefixes={IS_ELECTRON}>
      <>
        <ResetStyle />
        <GlobalStyle />
        <LoadableWindowControls />
        <LoadableSystemBar />
        <KeyListenerBoundary>
          <RootErrorBoundary>
            <UrqlProvider value={graphqlClient}>
              <FileDropZoneProvider>
                <React.Suspense fallback={<LoadingDotsArea />}>
                  <RedirectOnUnauthorized />
                  <Switch>
                    {!IS_PRODUCTION ? <Route path='/dev/*?' component={LoadableDev} /> : <></>}
                  </Switch>
                  <MainLayout>
                    <AppRoutes />
                  </MainLayout>
                  <ConnectedSettings />
                  <ConnectedSnackbar />
                  <ConnectedDialogOverlay />
                </React.Suspense>
              </FileDropZoneProvider>
            </UrqlProvider>
          </RootErrorBoundary>
          <UpdateOverlay />
        </KeyListenerBoundary>
      </>
    </StyleSheetManager>
  )
}
