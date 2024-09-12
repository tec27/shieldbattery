// This file should import every `HttpApi` that needs to be included in the app. It doesn't have to
// do anything with them, they just need to be imported so they will be registered with tsyringe
import './lib/bugs/bugs-api.js'
import './lib/chat/chat-api.js'
import './lib/games/game-api.js'
import './lib/ladder/ladder-api.js'
import './lib/leagues/league-api.js'
import './lib/maps/map-api.js'
import './lib/matchmaking/map-pools-api.js'
import './lib/matchmaking/matchmaking-api.js'
import './lib/matchmaking/matchmaking-preferences-api.js'
import './lib/notifications/notification-api.js'
import './lib/parties/party-api.js'
import './lib/rally-point/rally-point-api.js'
import './lib/session/session-api.js'
import './lib/users/user-api.js'
import './lib/whispers/whisper-api.js'
