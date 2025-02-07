import { Immutable } from 'immer'
import { GameRecordJson } from '../../common/games/games'
import { SbUser, SbUserId, UserProfileJson } from '../../common/users/sb-user'
import { LOBBY_INIT_DATA, LOBBY_UPDATE_CHAT_MESSAGE, LOBBY_UPDATE_SLOT_CREATE } from '../actions'
import { immerKeyedReducer } from '../reducers/keyed-reducer'

export interface UserRequestInfo {
  /** Should be set to the current value of `window.performance.now()` when the request is made. */
  time: number
}

export interface UserState {
  /** A map of user ID -> user information. */
  byId: Map<SbUserId, SbUser>
  // TODO(tec27): Make a reducer specifically to handle match history
  /** A map of user ID -> recent match history. */
  idToMatchHistory: Map<SbUserId, GameRecordJson[]>
  /** A map of user ID -> user profile information. */
  idToProfile: Map<SbUserId, UserProfileJson>
}

const DEFAULT_STATE: Immutable<UserState> = {
  byId: new Map(),
  idToMatchHistory: new Map(),
  idToProfile: new Map(),
}

function updateUsers(state: UserState, users: SbUser[]) {
  for (const user of users) {
    const userState = state.byId.get(user.id)
    if (userState) {
      if (userState.name !== user.name) {
        userState.name = user.name
      }
    } else {
      state.byId.set(user.id, { id: user.id, name: user.name })
    }
  }
}

export default immerKeyedReducer(DEFAULT_STATE, {
  ['@auth/loadCurrentSession'](state, action) {
    const {
      payload: { user },
    } = action

    state.byId.set(user.id, { id: user.id, name: user.name })
  },

  ['@chat/loadMessageHistory'](state, action) {
    if (action.error) {
      return
    }

    updateUsers(state, action.payload.users)
    updateUsers(state, action.payload.mentions)
  },

  ['@chat/updateMessage'](state, action) {
    updateUsers(state, [action.payload.user])
    updateUsers(state, action.payload.mentions)
  },

  ['@chat/retrieveUserList'](state, action) {
    if (action.error) {
      return
    }

    updateUsers(state, action.payload)
  },

  ['@chat/updateJoin'](state, action) {
    updateUsers(state, [action.payload.user])
  },

  ['@games/getGameRecord'](state, { payload: { users } }) {
    updateUsers(state, users)
  },

  ['@ladder/getInstantaneousSelfRank'](state, { payload: { user } }) {
    updateUsers(state, [user])
  },

  ['@ladder/getRankings'](state, action) {
    if (action.error) {
      return
    }

    updateUsers(state, action.payload.users)
  },

  ['@ladder/searchRankings'](state, action) {
    if (action.error) {
      return
    }

    updateUsers(state, action.payload.users)
  },

  ['@leagues/getLeaderboard'](state, { payload: { users } }) {
    updateUsers(state, users)
  },

  ['@users/adminBanUser'](state, action) {
    updateUsers(state, action.payload.users)
  },

  ['@users/adminGetUserBanHistory'](state, action) {
    updateUsers(state, action.payload.users)
  },

  ['@users/adminGetUserIps'](state, action) {
    updateUsers(state, action.payload.users)
  },

  ['@users/getBatchUserInfo'](state, action) {
    if (action.error) {
      return
    }

    updateUsers(state, action.payload.userInfos)
  },

  ['@users/getRelationships'](state, action) {
    updateUsers(state, action.payload.users)
  },

  ['@users/getUserProfile'](state, { payload: { user, profile, matchHistory } }) {
    updateUsers(state, [user])
    updateUsers(state, matchHistory.users)
    state.idToProfile.set(profile.userId, profile)
    state.idToMatchHistory.set(user.id, matchHistory.games)
  },

  ['@users/searchMatchHistory'](state, { payload: { users } }) {
    updateUsers(state, users)
  },

  ['@users/loadUsers'](state, action) {
    updateUsers(state, action.payload)
  },

  ['@whispers/getWhisperSessions'](state, action) {
    updateUsers(state, action.payload)
  },

  ['@whispers/loadMessageHistory'](state, action) {
    updateUsers(state, action.payload.users)
    updateUsers(state, action.payload.mentions)
  },

  ['@whispers/updateMessage'](state, action) {
    updateUsers(state, action.payload.users)
    updateUsers(state, action.payload.mentions)
  },

  [LOBBY_INIT_DATA as any](state: any, action: any) {
    updateUsers(state, action.payload.userInfos)
  },

  [LOBBY_UPDATE_SLOT_CREATE as any](state: any, action: any) {
    if (action.payload.userInfo) {
      updateUsers(state, [action.payload.userInfo])
    }
  },

  [LOBBY_UPDATE_CHAT_MESSAGE as any](state: any, action: any) {
    updateUsers(state, action.payload.mentions)
  },
})
