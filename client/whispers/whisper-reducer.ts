import { Immutable } from 'immer'
import { SbUserId } from '../../common/users/sb-user'
import { TextMessageRecord } from '../messaging/message-records'
import { immerKeyedReducer } from '../reducers/keyed-reducer'

// How many messages should be kept for inactive channels
const INACTIVE_SESSION_MAX_HISTORY = 150

export interface WhisperSession {
  target: SbUserId
  messages: TextMessageRecord[]

  hasHistory: boolean

  activated: boolean
  hasUnread: boolean
}

function defaultWhisperSession(target: SbUserId): WhisperSession {
  return {
    target,
    messages: [],
    hasHistory: true,
    activated: false,
    hasUnread: false,
  }
}

export interface WhisperState {
  // TODO(tec27): Allow user reordering of these
  sessions: Set<SbUserId>
  byId: Map<SbUserId, WhisperSession>
}

const DEFAULT_STATE: Immutable<WhisperState> = {
  sessions: new Set(),
  byId: new Map(),
}

/**
 * Update the messages field for a whisper, keeping the `hasUnread` flag in proper sync.
 */
function updateMessages(
  state: WhisperState,
  target: SbUserId,
  makeUnread: boolean,
  updateFn: (messages: TextMessageRecord[]) => TextMessageRecord[],
) {
  const session = state.byId.get(target)
  if (!session) {
    return
  }

  session.messages = updateFn(session.messages)

  let sliced = false
  if (!session.activated && session.messages.length > INACTIVE_SESSION_MAX_HISTORY) {
    session.messages = session.messages.slice(-INACTIVE_SESSION_MAX_HISTORY)
    sliced = true
  }

  if (makeUnread && !session.hasUnread && !session.activated) {
    session.hasUnread = true
  }

  session.hasHistory = session.hasHistory || sliced
}

export default immerKeyedReducer(DEFAULT_STATE, {
  ['@whispers/getWhisperSessions'](state, action) {
    state.sessions = new Set(action.payload.map(user => user.id))

    for (const session of action.payload) {
      if (!state.byId.has(session.id)) {
        state.byId.set(session.id, defaultWhisperSession(session.id))
      }
    }
  },

  ['@whispers/initSession'](state, action) {
    const { target } = action.payload
    state.byId.set(target.id, defaultWhisperSession(target.id))
    state.sessions.add(target.id)
  },

  ['@whispers/closeSession'](state, action) {
    const { target } = action.payload

    state.sessions.delete(target)
    state.byId.delete(target)
  },

  ['@whispers/updateMessage'](state, action) {
    const {
      message: { id, time, from, to, text },
    } = action.payload
    const target = state.sessions.has(from.id) ? from.id : to.id
    const newMessage = new TextMessageRecord({
      id,
      time,
      from: from.id,
      text,
    })

    return updateMessages(state, target, true, m => {
      m.push(newMessage)
      return m
    })
  },

  ['@whispers/loadMessageHistory'](state, action) {
    const { target, limit } = action.meta

    const session = state.byId.get(target)
    if (!session) {
      return
    }

    const newMessages = action.payload.messages.map(
      msg =>
        new TextMessageRecord({
          id: msg.id,
          time: msg.time,
          from: msg.from.id,
          text: msg.text,
        }),
    )

    if (newMessages.length < limit) {
      session.hasHistory = false
    }

    updateMessages(state, target, false, messages => newMessages.concat(messages))
  },

  ['@whispers/activateWhisperSession'](state, action) {
    const { target } = action.payload
    if (!state.byId.has(target)) {
      return
    }

    const session = state.byId.get(target)!
    session.activated = true
    session.hasUnread = false
  },

  ['@whispers/deactivateWhisperSession'](state, action) {
    const { target } = action.payload
    if (!state.byId.has(target)) {
      return
    }

    const session = state.byId.get(target)!

    const hasHistory = session.messages.length > INACTIVE_SESSION_MAX_HISTORY

    session.messages = session.messages.slice(-INACTIVE_SESSION_MAX_HISTORY)
    session.hasHistory = session.hasHistory || hasHistory
    session.activated = false
  },

  ['@network/connect']() {
    return DEFAULT_STATE
  },
})
