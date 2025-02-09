import { SubscribedClientEvent, SubscribedUserEvent } from '../../common/websockets'

export type LoadingActions = SubscriptionsClientLoadingComplete | SubscriptionsUserLoadingComplete

/**
 * The server has finished subscribing this particular client to the things it needs.
 */
export interface SubscriptionsClientLoadingComplete {
  type: '@loading/subscribedClient'
  payload: SubscribedClientEvent
}

/**
 * The server has finished subscribing this user (across clients) to the things it needs.
 */
export interface SubscriptionsUserLoadingComplete {
  type: '@loading/subscribedUser'
  payload: SubscribedUserEvent
}
