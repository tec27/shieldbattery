import { ActiveGameActions } from './active-game/actions'
import { AuthActions } from './auth/actions'
import { ChatActions } from './chat/actions'
import { DialogActions } from './dialogs/actions'
import { GamesActions } from './games/actions'
import { LadderActions } from './ladder/actions'
import { LeaguesActions } from './leagues/actions'
import { LoadingActions } from './loading/actions'
import { MapsActions } from './maps/actions'
import { MatchmakingActions } from './matchmaking/actions'
import { NetworkActions } from './network/actions'
import { NotificationActions } from './notifications/actions'
import { SettingsActions } from './settings/actions'
import { UserActions } from './users/actions'
import { WhisperActions } from './whispers/actions'

type AllActions =
  | ActiveGameActions
  | AuthActions
  | ChatActions
  | DialogActions
  | GamesActions
  | LadderActions
  | LeaguesActions
  | LoadingActions
  | MapsActions
  | MatchmakingActions
  | NetworkActions
  | NotificationActions
  | SettingsActions
  | UserActions
  | WhisperActions

export type ReduxAction = Extract<AllActions, { type: string }>

export type PromisifiedAction<T extends ReduxAction> = {
  [key in keyof T]: key extends 'payload' ? Promise<T[key]> : T[key]
}

type NonStringTypes = Exclude<AllActions, { type: string }>

// NOTE(tec27): If you encounter TypeScript errors here, it means you've added a Redux action that
// has a non-string `type` value. Change it to a string and the error should go away.
type TestNoNonStringTypes<T extends never> = Record<string, T>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const testObj: TestNoNonStringTypes<NonStringTypes> = {}
