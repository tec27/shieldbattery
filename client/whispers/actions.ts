import { SbUser, SbUserId } from '../../common/users/sb-user'
import { GetSessionHistoryResponse, WhisperMessageEvent } from '../../common/whispers'

export type WhisperActions =
  | LoadMessageHistory
  | ActivateWhisperSession
  | DeactivateWhisperSession
  | WhisperSessionInit
  | WhisperSessionClose
  | WhisperMessageUpdate
  | GetWhisperSessions

/**
 * Get the list of whisper sessions for the current user.
 */
export interface GetWhisperSessions {
  type: '@whispers/getWhisperSessions'
  payload: SbUser[]
}

/**
 * Load the `limit` amount of messages in a whisper session before a particular time.
 */
export interface LoadMessageHistory {
  type: '@whispers/loadMessageHistory'
  payload: GetSessionHistoryResponse
  meta: {
    target: SbUserId
    limit: number
    beforeTime: number
  }
}

/**
 * Activate a particular whisper session. This is a purely client-side action which marks the
 * session as "active", and removes the unread indicator if there is one.
 */
export interface ActivateWhisperSession {
  type: '@whispers/activateWhisperSession'
  payload: {
    target: SbUserId
  }
}

/**
 * Deactivate a particular whisper session. This is a purely client-side action which unloads the
 * message history of a session and thus frees up some memory.
 */
export interface DeactivateWhisperSession {
  type: '@whispers/deactivateWhisperSession'
  payload: {
    target: SbUserId
  }
}

/**
 * We have started a new whisper session with a particular user and the server has sent us some
 * initial data.
 */
export interface WhisperSessionInit {
  type: '@whispers/initSession'
  payload: {
    target: SbUser
  }
}

/**
 * We have closed a whisper session with a particular user.
 */
export interface WhisperSessionClose {
  type: '@whispers/closeSession'
  payload: {
    target: SbUserId
  }
}

/**
 * We have received a message from a user in one of our whisper sessions.
 */
export interface WhisperMessageUpdate {
  type: '@whispers/updateMessage'
  payload: WhisperMessageEvent
  meta: { fromId: SbUserId }
}
