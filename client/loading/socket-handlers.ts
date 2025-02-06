import { NydusClient, RouteInfo } from 'nydus-client'
import { ChatReadyEvent } from '../../common/chat'
import { WhispersReadyEvent } from '../../common/whispers'
import { Dispatchable, dispatch } from '../dispatch-registry'

type LoadingEvent = ChatReadyEvent | WhispersReadyEvent

type LoadingEventToActionMap = {
  [E in LoadingEvent['type']]: (
    event: Extract<LoadingEvent, { type: E }>,
  ) => Dispatchable | undefined
}

const eventToAction: LoadingEventToActionMap = {
  chatReady(event) {
    return {
      type: '@loading/chatReady',
      payload: event,
    }
  },

  whispersReady(event) {
    return {
      type: '@loading/whispersReady',
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
