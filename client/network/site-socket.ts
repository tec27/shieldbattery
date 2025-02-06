import createNydus, { NydusClientOptions } from 'nydus-client'
import { clientId } from './client-id'
import { CREDENTIAL_STORAGE } from './fetch'
import { makeServerUrl } from './server-url'

const location = !IS_ELECTRON ? window.location : new window.URL(makeServerUrl(''))
const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
const options = {
  query: { clientId },
  withCredentials: true,
  extraHeaders: {
    Authorization: `Bearer ${CREDENTIAL_STORAGE.get()}`,
  },
} satisfies Partial<NydusClientOptions>

const siteSocket = createNydus(`${protocol}://${location.hostname}:${location.port}`, options)
export default siteSocket
