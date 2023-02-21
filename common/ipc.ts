import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  IpcRenderer,
  IpcRendererEvent,
  WebContents,
} from 'electron'
import type { ReplayHeader } from 'jssuh'
import { Promisable } from 'type-fest'
import { GameLaunchConfig } from './game-launch-config'
import { ReportedGameStatus } from './game-status'
import { GameRoute } from './games/games'
import { GameClientPlayerResult, SubmitGameResultsRequest } from './games/results'
import { LocalSettingsData, ScrSettingsData } from './local-settings'
import { MapExtension } from './maps'
import { ResolvedRallyPointServer } from './rally-point'
import { ReplayShieldBatteryData } from './replays'
import { ShieldBatteryFileResult } from './shieldbattery-file'

const IS_RENDERER = typeof process === 'undefined' || !process || process.type === 'renderer'
const ipcRenderer =
  IS_ELECTRON && IS_RENDERER
    ? ((window as any).SHIELDBATTERY_ELECTRON_API.ipcRenderer as IpcRenderer)
    : null
const ipcMain = IS_ELECTRON && !IS_RENDERER ? require('electron').ipcMain : null

/**
 * Equivalent to a node.js fs.Dirent object, but with relevant functions converted to be raw values,
 * so that it can be passed across IPC.
 */
export interface FsDirent {
  isFile: boolean
  isDirectory: boolean
  name: string
}

/**
 * Equivalent to a node.js fs.Stats object, but with relevant functions converted to be raw values,
 * so that it can be passed across IPC.
 */
export interface FsStats {
  isFile: boolean
  isDirectory: boolean
  size: number
  blksize: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
}

/** RPCs that can be invoked by the renderer process to run code in the main process. */
interface IpcInvokeables {
  activeGameStartWhenReady: (gameId: string) => void
  activeGameSetConfig: (config: GameLaunchConfig | Record<string, never>) => string | null
  activeGameSetRoutes: (gameId: string, routes: GameRoute[]) => void

  // TODO(tec27): Support the non-filetypes version if we need it, overloads don't seem to work
  // well with the current approach for typing these invokes =/
  fsReadDir: (dirPath: string, options: { withFileTypes: true }) => Promise<FsDirent[]>
  // TODO(tec27): Add types for options + returning a string if encoding is specified?
  fsReadFile: (filePath: string) => Promise<ArrayBuffer>
  fsStat: (filePath: string) => Promise<FsStats>

  logMessage: (level: string, message: string) => void

  mapStoreDownloadMap: (hash: string, format: MapExtension, mapUrl: string) => Promise<boolean>

  pathsGetDocumentsPath: () => Promise<string>

  replayParseMetadata: (
    replayPath: string,
  ) => Promise<{ headerData?: ReplayHeader; shieldBatteryData?: ReplayShieldBatteryData }>

  securityGetClientIds: () => Promise<[number, string][]>

  settingsCheckStarcraftPath: (path: string) => Promise<{ path: boolean; version: boolean }>
  settingsBrowseForStarcraft: (
    defaultPath: string,
  ) => Promise<{ canceled: boolean; filePaths: string[] }>
  settingsGetPrimaryResolution: () => Promise<{ width: number; height: number }>
  settingsOverwriteBlizzardFile: () => void

  shieldbatteryCheckFiles: () => Promise<ShieldBatteryFileResult[]>
}

/** Events that can be sent from the renderer process to the main process. */
interface IpcRendererSendables {
  chatNewMessage: (data: { urgent: boolean }) => void

  networkSiteConnected: () => void

  rallyPointSetServers: (servers: [id: number, server: ResolvedRallyPointServer][]) => void
  rallyPointUpsertServer: (server: ResolvedRallyPointServer) => void
  rallyPointDeleteServer: (id: number) => void
  rallyPointRefreshPings: () => void

  settingsLocalGet: () => void
  // TODO(tec27): Convert to invoke (and remove settingsLocalMergeError)
  settingsLocalMerge: (settings: Readonly<Partial<LocalSettingsData>>) => void
  settingsScrGet: () => void
  // TODO(tec27): Convert to invoke (and remove settingsScrMergeError)
  settingsScrMerge: (settings: Readonly<Partial<ScrSettingsData>>) => void

  updaterGetState: () => void
  updaterQuitAndInstall: () => void

  userAttentionRequired: () => void

  windowClose: (shouldDisplayCloseHint: boolean) => void
  windowMaximize: () => void
  windowMinimize: () => void
}

/** Events that can be sent from the main process to a renderer process. */
interface IpcMainSendables {
  activeGameReplaySaved: (gameId: string, replayPath: string) => void
  activeGameResult: (data: {
    gameId: string
    result: Record<string, GameClientPlayerResult>
    time: number
  }) => void
  /**
   * Used if sending results from the game fails for some reason. We pass this off to the
   * renderer process to do because this usually indicates some issue with e.g. the TLS stack of
   * this system, so using the network stack outside the renderer also tends to fail.
   */
  activeGameResendResults: (gameId: string, requestBody: SubmitGameResultsRequest) => void
  activeGameStatus: (status: ReportedGameStatus) => void

  rallyPointPingResult: (server: ResolvedRallyPointServer, ping: number) => void

  settingsLocalChanged: (settings: Readonly<Partial<LocalSettingsData>>) => void
  settingsLocalGetError: (err: Error) => void
  settingsLocalMergeError: (err: Error) => void
  settingsScrChanged: (settings: Readonly<Partial<ScrSettingsData>>) => void
  settingsScrGetError: (err: Error) => void
  settingsScrMergeError: (err: Error) => void

  updaterDownloadError: () => void
  updaterDownloadProgress: (progressInfo: {
    bytesTransferred: number
    totalBytes: number
    bytesPerSecond: number
  }) => void
  updaterNewVersionDownloaded: () => void
  updaterNewVersionFound: () => void
  updaterUpToDate: () => void

  /** Sent when the window is focused or unfocused. */
  windowFocusChanged: (focused: boolean) => void
  windowMaximizedState: (isMaximized: boolean) => void
}

/**
 * A wrapper around Electron's `ipcMain` that provides strongly typed events and invokes.
 */
export class TypedIpcMain {
  /**
   * Adds a handler for an `invoke`able IPC. This handler will be called whenever a
   * renderer calls `ipcRenderer.invoke(channel, ...args)`.
   *
   * If `listener` returns a Promise, the eventual result of the promise will be
   * returned as a reply to the remote caller. Otherwise, the return value of the
   * listener will be used as the value of the reply.
   *
   * The `event` that is passed as the first argument to the handler is the same as
   * that passed to a regular event listener. It includes information about which
   * WebContents is the source of the invoke request.
   */
  handle<K extends keyof IpcInvokeables>(
    channel: K,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: Parameters<IpcInvokeables[K]>
    ) => Promisable<ReturnType<IpcInvokeables[K]>>,
  ): void {
    ipcMain?.handle(channel, listener as any)
  }

  /**
   * Handles a single `invoke`able IPC message, then removes the listener. See
   * `ipcMain.handle(channel, listener)`.
   */
  handleOnce<K extends keyof IpcInvokeables>(
    channel: K,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: Parameters<IpcInvokeables[K]>
    ) => Promisable<ReturnType<IpcInvokeables[K]>>,
  ): void {
    ipcMain?.handleOnce(channel, listener as any)
  }

  /**
   * Removes any handler for `channel`, if present.
   */
  removeHandler(channel: keyof IpcInvokeables): void {
    ipcMain?.removeHandler(channel)
  }

  /**
   * Listens to `channel`, when a new message arrives `listener` would be called with
   * `listener(event, args...)`.
   */
  on<K extends keyof IpcRendererSendables>(
    channel: K,
    listener: (
      event: IpcMainEvent,
      ...args: Parameters<IpcRendererSendables[K]>
    ) => ReturnType<IpcRendererSendables[K]>,
  ): this {
    ipcMain?.on(channel, listener as any)
    return this
  }

  /**
   * Adds a one time `listener` function for the event. This `listener` is invoked
   * only the next time a message is sent to `channel`, after which it is removed.
   */
  once<K extends keyof IpcRendererSendables>(
    channel: K,
    listener: (
      event: IpcMainEvent,
      ...args: Parameters<IpcRendererSendables[K]>
    ) => ReturnType<IpcRendererSendables[K]>,
  ): this {
    ipcMain?.once(channel, listener as any)
    return this
  }

  /**
   * Removes listeners of the specified `channel`.
   */
  removeAllListeners(channel: keyof IpcRendererSendables): this {
    ipcMain?.removeAllListeners(channel)
    return this
  }

  /**
   * Removes the specified `listener` from the listener array for the specified
   * `channel`.
   */
  removeListener<K extends keyof IpcRendererSendables>(
    channel: K,
    listener: IpcRendererSendables[K],
  ): this {
    ipcMain?.removeListener(channel, listener)
    return this
  }
}

/**
 * A wrapper around an Electron `WebContents` for sending strongly-typed events to the renderer
 * process. This should be initialized with a particular window's `WebContents`, or `event.sender`
 * if it's for responding to a particular event (in which case `invoke` may be a better approach).
 */
export class TypedIpcSender {
  constructor(private sender?: WebContents) {}

  // NOTE(tec27): This just makes the general usage bit less awkward by avoiding the `new` keyword
  static from(sender?: WebContents) {
    return new TypedIpcSender(sender)
  }

  /**
   * Send an asynchronous message to the renderer process via `channel`, along with
   * arguments. Arguments will be serialized with the Structured Clone Algorithm,
   * just like `postMessage`, so prototype chains will not be included. Sending
   * Functions, Promises, Symbols, WeakMaps, or WeakSets will throw an exception.
   *
   * > **NOTE**: Sending non-standard JavaScript types such as DOM objects or special
   * Electron objects will throw an exception.
   *
   * The renderer process can handle the message by listening to `channel` with the
   * `ipcRenderer` module.
   */
  send<K extends keyof IpcMainSendables>(
    channel: K,
    ...args: Parameters<IpcMainSendables[K]>
  ): void {
    this.sender?.send(channel, ...args)
  }
}

/**
 * A wrapper around Electron's `ipcRenderer` that provides strongly typed events and invokes. This
 * is safe to import and use in code that is potentially run on the web too (it will just no-op in
 * that case).
 */
export class TypedIpcRenderer {
  /**
   * Resolves with the response from the main process.
   *
   * Send a message to the main process via `channel` and expect a result
   * asynchronously. Arguments will be serialized with the Structured Clone
   * Algorithm, just like `window.postMessage`, so prototype chains will not be
   * included. Sending Functions, Promises, Symbols, WeakMaps, or WeakSets will throw
   * an exception.
   *
   * > **NOTE:** Sending non-standard JavaScript types such as DOM objects or special
   * Electron objects will throw an exception.
   *
   * Since the main process does not have support for DOM objects such as
   * `ImageBitmap`, `File`, `DOMMatrix` and so on, such objects cannot be sent over
   * Electron's IPC to the main process, as the main process would have no way to
   * decode them. Attempting to send such objects over IPC will result in an error.
   *
   * The main process should listen for `channel` with `ipcMain.handle()`.
   *
   * If you need to transfer a `MessagePort` to the main process, use
   * `ipcRenderer.postMessage`.
   *
   * If you do not need a response to the message, consider using `send`.
   */
  invoke<K extends keyof IpcInvokeables>(
    channel: K,
    ...args: Parameters<IpcInvokeables[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeables[K]>>> | undefined {
    return ipcRenderer?.invoke(channel, ...args)
  }

  /**
   * Send an asynchronous message to the main process via `channel`, along with
   * arguments. Arguments will be serialized with the Structured Clone Algorithm,
   * just like `window.postMessage`, so prototype chains will not be included.
   * Sending Functions, Promises, Symbols, WeakMaps, or WeakSets will throw an
   * exception.
   *
   * > **NOTE:** Sending non-standard JavaScript types such as DOM objects or special
   * Electron objects will throw an exception.
   *
   * Since the main process does not have support for DOM objects such as
   * `ImageBitmap`, `File`, `DOMMatrix` and so on, such objects cannot be sent over
   * Electron's IPC to the main process, as the main process would have no way to
   * decode them. Attempting to send such objects over IPC will result in an error.
   *
   * The main process handles it by listening for `channel` with the `ipcMain`
   * module.
   *
   * If you need to transfer a `MessagePort` to the main process, use
   * `ipcRenderer.postMessage`.
   *
   * If you want to receive a single response from the main process, like the result
   * of a method call, consider using `ipcRenderer.invoke`.
   */
  send<K extends keyof IpcRendererSendables>(
    channel: K,
    ...args: Parameters<IpcRendererSendables[K]>
  ): void {
    ipcRenderer?.send(channel, ...args)
  }

  /**
   * Listens to `channel`, when a new message arrives `listener` would be called with
   * `listener(event, args...)`.
   */
  on<K extends keyof IpcMainSendables>(
    channel: K,
    listener: (
      event: IpcRendererEvent,
      ...args: Parameters<IpcMainSendables[K]>
    ) => ReturnType<IpcMainSendables[K]>,
  ): this {
    ipcRenderer?.on(channel, listener as any)
    return this
  }

  /**
   * Adds a one time `listener` function for the event. This `listener` is invoked
   * only the next time a message is sent to `channel`, after which it is removed.
   */
  once<K extends keyof IpcMainSendables>(
    channel: K,
    listener: (
      event: IpcRendererEvent,
      ...args: Parameters<IpcMainSendables[K]>
    ) => ReturnType<IpcMainSendables[K]>,
  ): this {
    ipcRenderer?.once(channel, listener as any)
    return this
  }

  /**
   * Removes listeners of the specified `channel`.
   */
  removeAllListeners(channel: keyof IpcMainSendables): this {
    ipcRenderer?.removeAllListeners(channel)
    return this
  }

  /**
   * Removes the specified `listener` from the listener array for the specified
   * `channel`.
   */
  removeListener<K extends keyof IpcMainSendables>(
    channel: K,
    listener: IpcMainSendables[K],
  ): this {
    ipcRenderer?.removeListener(channel, listener)
    return this
  }
}
