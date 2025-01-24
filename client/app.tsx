import React, { useEffect, useLayoutEffect, useState } from 'react'
import { StyleSheetManager } from 'styled-components'
import { Provider as UrqlProvider } from 'urql'
import { Route, Switch, useRoute } from 'wouter'
import { revokeSession } from './auth/action-creators'
import { useIsLoggedIn } from './auth/auth-utils'
import { EmailVerificationUi } from './auth/email-verification'
import { ForgotPassword, ForgotUser, ResetPassword } from './auth/forgot'
import { LoggedInFilter } from './auth/logged-in-filter'
import { Login } from './auth/login'
import { Signup } from './auth/signup'
import { ConnectedDialogOverlay } from './dialogs/connected-dialog-overlay'
import { usePixelShover } from './dom/pixel-shover'
import { DownloadPage } from './download/download-page'
import { UpdateOverlay } from './download/update-overlay'
import { FileDropZoneProvider } from './file-browser/file-drop-zone'
import { KeyListenerBoundary } from './keyboard/key-listener'
import { Faq } from './landing/faq'
import { Splash } from './landing/splash'
import { LoadingFilter } from './loading/loading-filter'
import { LoggedOutContent } from './logged-out-content'
import { logger } from './logging/logger'
import { LoginRoute } from './navigation/custom-routes'
import { UNAUTHORIZED_EMITTER } from './network/fetch'
import { createGraphqlClient } from './network/graphql-client'
import { SiteConnectedFilter } from './network/site-connected-filter'
import { MainLayout } from './new-main-layout'
import {
  AcceptableUsePage,
  PrivacyPolicyPage,
  TermsOfServicePage,
} from './policies/policy-displays'
import { LoadingDotsArea } from './progress/dots'
import { useAppDispatch, useAppSelector } from './redux-hooks'
import { RootErrorBoundary } from './root-error-boundary'
import { getServerConfig } from './server-config-storage'
import { ConnectedSettings } from './settings/settings'
import ConnectedSnackbar from './snackbars/connected-snackbar'
import GlobalStyle from './styles/global'
import ResetStyle from './styles/reset'

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

function MainContent() {
  const [matchesRoot] = useRoute('/')
  const loggedIn = useIsLoggedIn()

  if (matchesRoot) {
    if (!IS_ELECTRON && !loggedIn) {
      return <Splash />
    }
  }

  const loggedInContent = (
    <LoggedInFilter>
      <>
        <RedirectOnUnauthorized />
        <SiteConnectedFilter>
          <LoadingFilter>
            <MainLayout />
          </LoadingFilter>
        </SiteConnectedFilter>
      </>
    </LoggedInFilter>
  )

  return loggedIn ? loggedInContent : <LoggedOutContent loggedInContent={loggedInContent} />
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
                  <Switch>
                    <Route path='/splash' component={Splash} />
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
                    {!IS_PRODUCTION ? <Route path='/dev/*?' component={LoadableDev} /> : <></>}
                    <Route>
                      <MainContent />
                    </Route>
                  </Switch>
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
