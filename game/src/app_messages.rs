use hashbrown::HashMap;
use serde::{Deserialize, Serialize};

use crate::bw;
use crate::bw::players::{AssignedRace, VictoryState};
use crate::bw::{GameType, LobbyOptions};

// Structures of messages that are used to communicate with the electron app.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub local: serde_json::Map<String, serde_json::Value>,
    pub scr: serde_json::Map<String, serde_json::Value>,
    pub settings_file_path: String,
}

// app/common/game_status.js
pub const GAME_STATUS_ERROR: u32 = 666;
#[derive(Serialize)]
pub struct SetupProgress {
    pub status: SetupProgressInfo,
}

#[derive(Serialize)]
pub struct SetupProgressInfo {
    pub state: u32,
    pub extra: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct LocalUser {
    /// The local user's ShieldBattery user ID.
    pub id: u32,
    /// The local user's ShieldBattery username.
    pub name: String,
}

#[derive(Serialize)]
pub struct WindowMove {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Deserialize, Copy, Clone, Eq, PartialEq)]
pub enum UmsLobbyRace {
    #[serde(rename = "z")]
    Zerg,
    #[serde(rename = "t")]
    Terran,
    #[serde(rename = "p")]
    Protoss,
    #[serde(rename = "r")]
    Random,
    #[serde(rename = "any")]
    Any,
}

#[derive(Serialize, Debug, Copy, Clone, Eq, PartialEq)]
pub struct GamePlayerResult {
    pub result: VictoryState,
    pub race: AssignedRace,
    pub apm: u32,
}

#[derive(Debug, Copy, Clone, Serialize)]
pub struct NetworkStallInfo {
    pub count: u32,
    pub min: u32,
    pub max: u32,
    pub median: u32,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameResults {
    #[serde(rename = "time")]
    pub time_ms: u64,
    pub results: HashMap<u32, GamePlayerResult>,
    pub network_stalls: NetworkStallInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameResultsReport {
    pub user_id: u32,
    pub result_code: String,
    pub time: u64,
    pub player_results: Vec<(u32, GamePlayerResult)>,
}

#[derive(Serialize)]
pub struct ReplaySaved {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSetupInfo {
    pub name: String,
    pub map: MapInfo,
    pub map_path: String,
    pub game_type: String,
    pub game_sub_type: Option<u8>,
    pub slots: Vec<PlayerInfo>,
    pub host: PlayerInfo,
    pub disable_alliance_changes: Option<bool>,
    pub use_legacy_limits: Option<bool>,
    pub turn_rate: Option<u32>,
    pub user_latency: Option<u32>,
    pub seed: u32,
    pub game_id: String,
    pub result_code: Option<String>,
    pub server_url: String,
}

impl GameSetupInfo {
    pub fn is_replay(&self) -> bool {
        self.map.is_replay == Some(true)
    }

    pub fn game_type(&self) -> Option<GameType> {
        match &*self.game_type {
            "melee" => Some(GameType::melee()),
            "ffa" => Some(GameType::ffa()),
            "oneVOne" => Some(GameType::one_v_one()),
            "ums" => Some(GameType::ums()),
            "teamMelee" => Some(GameType::team_melee(self.game_sub_type?)),
            "teamFfa" => Some(GameType::team_ffa(self.game_sub_type?)),
            "topVBottom" => Some(GameType::top_v_bottom(self.game_sub_type?)),
            _ => None,
        }
    }
}

impl From<&GameSetupInfo> for LobbyOptions {
    fn from(value: &GameSetupInfo) -> Self {
        LobbyOptions {
            game_type: value.game_type().unwrap_or(GameType {
                primary: 0x2,
                subtype: 0x1,
            }),
            turn_rate: value.turn_rate.unwrap_or(0),
            use_legacy_limits: value.use_legacy_limits.unwrap_or(false),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MapInfo {
    // This object is literally completely different between playing a game and watching a replay
    pub is_replay: Option<bool>,
    pub hash: Option<String>,
    pub map_data: Option<MapData>,
    pub name: Option<String>,
    pub path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MapData {
    pub height: u16,
    pub width: u16,
    pub ums_slots: u8,
    pub slots: u8,
    pub tileset: u16,
    pub ums_forces: Vec<MapForce>,
    pub is_eud: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapForce {
    pub players: Vec<MapForcePlayer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapForcePlayer {
    pub id: u8,
    pub race: UmsLobbyRace,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Hash)]
#[serde(transparent)]
pub struct LobbyPlayerId(String);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub id: LobbyPlayerId,
    pub name: String,
    pub race: Option<String>,
    pub user_id: Option<u32>,
    /// BW player slot index. Only set in UMS; for other game types the index is equal to
    /// GameSetupInfo.slots index.
    /// And either way this value becomes useless after BW randomizes the slots during
    /// game initialization.
    pub player_id: Option<u8>,
    pub team_id: u8,
    /// Player type can have shieldbattery-specific players (e.g. "observer"),
    /// player type id is the id in BW structures.
    #[serde(rename = "type")]
    pub player_type: String,
    #[serde(rename = "typeId")]
    pub player_type_id: u8,
}

impl PlayerInfo {
    /// Returns true for non-observing human players
    pub fn is_human(&self) -> bool {
        self.player_type == "human"
    }

    pub fn is_observer(&self) -> bool {
        self.player_type == "observer"
    }

    pub fn bw_player_type(&self) -> u8 {
        match &*self.player_type {
            "human" => bw::PLAYER_TYPE_HUMAN,
            "observer" => bw::PLAYER_TYPE_HUMAN,
            "computer" => bw::PLAYER_TYPE_LOBBY_COMPUTER,
            "controlledOpen" | "controlledClosed" | "open" | "closed" => bw::PLAYER_TYPE_OPEN,
            _ => bw::PLAYER_TYPE_NONE,
        }
    }

    pub fn bw_race(&self) -> u8 {
        match self.race.as_deref() {
            Some("z") => bw::RACE_ZERG,
            Some("t") => bw::RACE_TERRAN,
            Some("p") => bw::RACE_PROTOSS,
            _ => bw::RACE_RANDOM,
        }
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    #[serde(rename = "for")]
    pub for_player: LobbyPlayerId,
    pub server: RallyPointServer,
    pub route_id: String,
    pub player_id: u32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RallyPointServer {
    pub address4: Option<String>,
    pub address6: Option<String>,
    pub port: u16,
    pub description: String,
    pub id: u32,
}
