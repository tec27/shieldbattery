import React from 'react'

export function PlayRoot() {
  return IS_ELECTRON ? <div>Play content</div> : <div>FIXME: only available in app, download</div>
}
