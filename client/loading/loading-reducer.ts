import { ReadonlyDeep } from 'type-fest'
import { AUDIO_MANAGER_INITIALIZED } from '../actions'
import { immerKeyedReducer } from '../reducers/keyed-reducer'

export interface LoadingState {
  audio: boolean
  clientSubscriptions: boolean
  userSubscriptions: boolean
}

const DEFAULT_LOADING_STATE: ReadonlyDeep<LoadingState> = {
  audio: true,
  clientSubscriptions: true,
  userSubscriptions: true,
}

export default immerKeyedReducer(DEFAULT_LOADING_STATE, {
  [AUDIO_MANAGER_INITIALIZED as any](state: LoadingState) {
    state.audio = false
  },

  ['@loading/subscribedClient'](state) {
    state.clientSubscriptions = false
  },

  ['@loading/subscribedUser'](state) {
    state.userSubscriptions = false
  },

  ['@network/disconnect'](state: LoadingState) {
    // Reset the loading state of the stuff that gets initialized through sockets
    state.clientSubscriptions = true
    state.userSubscriptions = true
  },
})
