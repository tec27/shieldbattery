import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import swallowNonBuiltins from '../../common/async/swallow-non-builtins'
import { TypedIpcRenderer } from '../../common/ipc'
import { FileBrowser } from '../file-browser/file-browser'
import {
  ExpansionPanelProps,
  FileBrowserEntry,
  FileBrowserFileEntry,
  FileBrowserFileEntryConfig,
  FileBrowserRootFolderId,
  FileBrowserType,
} from '../file-browser/file-browser-types'
import { MaterialIcon } from '../icons/material/material-icon'
import { useAppDispatch } from '../redux-hooks'
import { background400 } from '../styles/colors'
import { startReplay } from './action-creators'
import { ReplayInfoDisplay } from './replay-info-display'

const ipcRenderer = new TypedIpcRenderer()

async function getReplayFolderPath() {
  return [await ipcRenderer.invoke('pathsGetDocumentsPath'), 'Starcraft', 'maps', 'replays'].join(
    '\\',
  )
}

const sortByNameReverse = (a: FileBrowserEntry, b: FileBrowserEntry) => b.name.localeCompare(a.name)
const sortByDateReverse = (a: FileBrowserFileEntry, b: FileBrowserFileEntry) => +b.date - +a.date

const StyledReplayInfoDisplay = styled(ReplayInfoDisplay)`
  padding: 16px;
  background-color: ${background400};
`

export function ReplayExpansionPanel({ file }: ExpansionPanelProps) {
  return <StyledReplayInfoDisplay filePath={file.path} />
}

export function BrowseLocalReplays() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [replayFolderPath, setReplayFolderPath] = useState<string>('')

  useEffect(() => {
    getReplayFolderPath()
      .then(path => setReplayFolderPath(path))
      .catch(swallowNonBuiltins)
  }, [])

  const onStartReplay = useCallback(
    (replay: FileBrowserFileEntry) => {
      dispatch(startReplay(replay))
    },
    [dispatch],
  )

  const fileEntryConfig: FileBrowserFileEntryConfig = useMemo(
    () => ({
      icon: <MaterialIcon icon='movie' />,
      allowedExtensions: ['rep'],
      ExpansionPanelComponent: ReplayExpansionPanel,
      onSelect: onStartReplay,
      onSelectTitle: t('replays.local.watchReplay', 'Watch replay'),
    }),
    [onStartReplay, t],
  )
  const rootFolders = useMemo(
    () => ({
      default: {
        id: FileBrowserRootFolderId.Default,
        name: t('replays.local.rootFolderName', 'Replays'),
        path: replayFolderPath,
      },
    }),
    [replayFolderPath, t],
  )

  if (!replayFolderPath) {
    return null
  }

  return (
    <FileBrowser
      browserType={FileBrowserType.Replays}
      title={t('replays.local.title', 'Local Replays')}
      rootFolders={rootFolders}
      fileEntryConfig={fileEntryConfig}
      folderSortFunc={sortByNameReverse}
      fileSortFunc={sortByDateReverse}
    />
  )
}
