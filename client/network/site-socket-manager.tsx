import React, { useEffect } from 'react'
import { useSelfUser } from '../auth/auth-utils'
import logger from '../logging/logger'
import siteSocket from './site-socket'

/**
 * React component that connects the site websocket if logged in, and disconnects it when no longer
 * logged in.
 */
export const SiteSocketManager = React.memo(() => {
  const user = useSelfUser()
  const userId = user?.id

  useEffect(() => {
    if (userId) {
      siteSocket.connect()

      return () => {
        logger.verbose('SiteSocketManager effect cleanup, disconnecting siteSocket')
        siteSocket.disconnect()
      }
    } else {
      return () => {}
    }
  }, [userId])

  return <></>
})
