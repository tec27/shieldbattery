import React from 'react'
import { Route, Switch } from 'wouter'
import { useIsAdmin } from './admin/admin-permissions'
import { EmailVerificationUi } from './auth/email-verification'
import { ForgotPassword, ForgotUser, ResetPassword } from './auth/forgot'
import { Login } from './auth/login'
import { Signup } from './auth/signup'
import { ChannelRouteComponent } from './chat/route'
import { DownloadPage } from './download/download-page'
import { PlayRoot } from './gameplay-activity/play-root'
import { GamesRouteComponent } from './games/route'
import { Home } from './home'
import { LadderRouteComponent } from './ladder/ladder'
import { Faq } from './landing/faq'
import { LeagueRoot } from './leagues/league-list'
import { MapsRoot } from './maps/maps-root'
import { LoginRoute } from './navigation/custom-routes'
import {
  AcceptableUsePage,
  PrivacyPolicyPage,
  TermsOfServicePage,
} from './policies/policy-displays'
import DotsIndicator from './progress/dots'
import { ReplaysRoot } from './replays/replays-root'
import { ProfileRouteComponent } from './users/route'
import { WhisperRouteComponent } from './whispers/route'

const AdminPanelComponent = React.lazy(() => import('./admin/panel'))
const LobbyView = React.lazy(async () => ({
  default: (await import('./lobbies/view')).LobbyView,
}))
const MatchmakingView = React.lazy(() => import('./matchmaking/view'))

function LoadableAdminPanel() {
  // TODO(tec27): do we need to position this indicator differently? (or pull that into a common
  // place?)
  return (
    <React.Suspense fallback={<DotsIndicator />}>
      <AdminPanelComponent />
    </React.Suspense>
  )
}

export function AppRoutes() {
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
      {IS_ELECTRON ? <Route path='/lobbies/:lobby/*?' component={LobbyView} /> : <></>}
      <Route path='/maps/*?' component={MapsRoot} />
      {IS_ELECTRON ? <Route path='/matchmaking/*?' component={MatchmakingView} /> : <></>}
      <Route path='/play/*?' component={PlayRoot} />
      <Route path='/replays/*?' component={ReplaysRoot} />
      <Route path='/users/*?' component={ProfileRouteComponent} />
      <Route path='/whispers/*?' component={WhisperRouteComponent} />
      <Route component={Home} />
    </Switch>
  )
}
