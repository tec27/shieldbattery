import { ChatReadyEvent } from '../../common/chat'
import { WhispersReadyEvent } from '../../common/whispers'

export type LoadingActions = ChatLoadingComplete | WhispersLoadingComplete

/**
 * The server has finished giving us our initial chat data (e.g what channels we are in) on connect.
 */
export interface ChatLoadingComplete {
  type: '@loading/chatReady'
  payload: ChatReadyEvent
}

/**
 * The server has finished giving us our initial whispers data (eg. the list of users we had the
 * whisper window opened with when we last used the site) upon connecting.
 */
export interface WhispersLoadingComplete {
  type: '@loading/whispersReady'
  payload: WhispersReadyEvent
}
