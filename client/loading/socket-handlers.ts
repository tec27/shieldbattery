import { NydusClient, RouteInfo } from 'nydus-client'
import { SubscribedClientEvent, SubscribedUserEvent } from '../../common/websockets'
import { Dispatchable, dispatch } from '../dispatch-registry'

type LoadingEvent = SubscribedClientEvent | SubscribedUserEvent

type LoadingEventToActionMap = {
  [E in LoadingEvent['type']]: (
    event: Extract<LoadingEvent, { type: E }>,
  ) => Dispatchable | undefined
}

const eventToAction: LoadingEventToActionMap = {
  subscribedClient(event) {
    return {
      type: '@loading/subscribedClient',
      payload: event,
    }
  },

  subscribedUser(event) {
    return {
      type: '@loading/subscribedUser',
      payload: event,
    }
  },
}

export default function registerModule({ siteSocket }: { siteSocket: NydusClient }) {
  const loadingHandler = (route: RouteInfo, event: LoadingEvent) => {
    if (!Object.hasOwn(eventToAction, event.type)) return

    const action = eventToAction[event.type](event as any)
    if (action) dispatch(action)
  }
  siteSocket.registerRoute('/users/:userId/:area?', loadingHandler)
  siteSocket.registerRoute('/clients/:userId/:clientId/:area?', loadingHandler)
}
