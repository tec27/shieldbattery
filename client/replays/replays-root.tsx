import React from 'react'

const LoadableLocalReplays = React.lazy(async () => ({
  default: (await import('./browse-local-replays')).BrowseLocalReplays,
}))

export function ReplaysRoot() {
  // FIXME: Implement the web experience
  return IS_ELECTRON ? <LoadableLocalReplays /> : <div>Only in app, download</div>
}
