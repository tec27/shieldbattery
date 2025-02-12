import React, { useEffect, useLayoutEffect, useState } from 'react'
import { StyleSheetManager } from 'styled-components'
import { Provider as UrqlProvider } from 'urql'
import { Route, Switch } from 'wouter'
import { AppRoutes } from './app-routes'
import { revokeSession } from './auth/action-creators'
import { ConnectedDialogOverlay } from './dialogs/connected-dialog-overlay'
import { usePixelShover } from './dom/pixel-shover'
import { UpdateOverlay } from './download/update-overlay'
import { FileDropZoneProvider } from './file-browser/file-drop-zone'
import { KeyListenerBoundary } from './keyboard/key-listener'
import { logger } from './logging/logger'
import { MainLayout } from './main-layout'
import { UNAUTHORIZED_EMITTER } from './network/fetch'
import { createGraphqlClient } from './network/graphql-client'
import { SiteSocketManager } from './network/site-socket-manager'
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
                  <RedirectOnUnauthorized />
                  <SiteSocketManager />
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
