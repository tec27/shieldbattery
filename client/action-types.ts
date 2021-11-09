import { AuthActions } from './auth/actions'
import { ChatActions } from './chat/actions'
import { DialogActions } from './dialogs/actions'
import { LadderActions } from './ladder/actions'
import { MapsActions } from './maps/actions'
import { MatchmakingActions } from './matchmaking/actions'
import { MessagingActions } from './messaging/actions'
import { NotificationActions } from './notifications/actions'
import { PartyActions } from './parties/actions'
import { ProfileActions } from './profile/actions'
import { WhisperActions } from './whispers/actions'

type AllActions =
  | AuthActions
  | ChatActions
  | DialogActions
  | LadderActions
  | MapsActions
  | MatchmakingActions
  | MessagingActions
  | NotificationActions
  | PartyActions
  | ProfileActions
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
