//! Hooks and other code that is running on the game/main thread (As opposed to async threads).

use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use byteorder::{ByteOrder, LittleEndian};
use fxhash::FxHashSet;
use lazy_static::lazy_static;
use libc::c_void;
use once_cell::sync::OnceCell;

use bw_dat::dialog::Dialog;
use bw_dat::{Unit, UnitId};

use crate::app_messages::{GameSetupInfo, SbUserId};
use crate::bw::{self, get_bw, Bw, StormPlayerId};
use crate::forge;
use crate::replay;
use crate::snp;

lazy_static! {
    pub static ref SEND_FROM_GAME_THREAD: Mutex<Option<tokio::sync::mpsc::UnboundedSender<GameThreadMessage>>> =
        Mutex::new(None);
    pub static ref GAME_RECEIVE_REQUESTS: Mutex<Option<Receiver<GameThreadRequest>>> =
        Mutex::new(None);
}

/// Global for accessing game type/slots/etc from hooks.
static SETUP_INFO: OnceCell<Arc<GameSetupInfo>> = OnceCell::new();
/// Global for shieldbattery-specific replay data.
/// Will not be initialized outside replays. (Or if the replay doesn't have that data)
static SBAT_REPLAY_DATA: OnceCell<replay::SbatReplayData> = OnceCell::new();
/// Contains game id, shieldbattery user id pairs after the slots have been randomized,
/// human player slots / obeservers only.
/// Once this is set it is expected to be valid for the entire game.
/// Could also be easily extended to have storm ids if mapping between them is needed.
static PLAYER_ID_MAPPING: OnceCell<Vec<PlayerIdMapping>> = OnceCell::new();

pub struct PlayerIdMapping {
    /// None at least for observers
    pub game_id: Option<u8>,
    pub sb_user_id: SbUserId,
}

pub fn set_sbat_replay_data(data: replay::SbatReplayData) {
    if SBAT_REPLAY_DATA.set(data).is_err() {
        warn!("Tried to set shieldbattery replay data twice");
    }
}

pub fn sbat_replay_data() -> Option<&'static replay::SbatReplayData> {
    SBAT_REPLAY_DATA.get()
}

// Async tasks request game thread to do some work
pub struct GameThreadRequest {
    request_type: GameThreadRequestType,
    // These requests probably won't have any reason to return values on success.
    // If a single one does, it can send a GameThreadMessage.
    done: tokio::sync::oneshot::Sender<()>,
}

impl GameThreadRequest {
    pub fn new(
        request_type: GameThreadRequestType,
    ) -> (GameThreadRequest, tokio::sync::oneshot::Receiver<()>) {
        let (done, wait_done) = tokio::sync::oneshot::channel();
        (GameThreadRequest { request_type, done }, wait_done)
    }
}

pub enum GameThreadRequestType {
    Initialize,
    RunWndProc,
    StartGame,
    ExitCleanup,
    SetupInfo(Arc<GameSetupInfo>),
}

// Game thread sends something to async tasks
pub enum GameThreadMessage {
    WindowMove(i32, i32, i32, i32),
    Snp(snp::SnpMessage),
    /// Storm player id (which stays stable) -> game player id mapping.
    /// Once this message is sent, any game player ids used so far should be
    /// considered invalid and updated to match this mapping.
    PlayersRandomized([Option<u8>; bw::MAX_STORM_PLAYERS]),
    Results(GameThreadResults),
    NetworkStall(std::time::Duration),
    ReplaySaved(PathBuf),
}

/// Sends a message from game thread to the async system.
pub fn send_game_msg_to_async(message: GameThreadMessage) {
    let send_global = SEND_FROM_GAME_THREAD.lock().unwrap();
    if let Some(ref send) = *send_global {
        let _ = send.send(message);
    } else {
        debug!("Game thread messaging not active");
    }
}

pub fn run_event_loop() -> ! {
    debug!("Main thread reached event loop");
    let mut receive_requests = GAME_RECEIVE_REQUESTS.lock().unwrap();
    let receive_requests = receive_requests
        .take()
        .expect("Channel to receive requests not set?");
    while let Ok(msg) = receive_requests.recv() {
        unsafe {
            handle_game_request(msg.request_type);
        }
        let _ = msg.done.send(());
    }
    // We can't return from here, as it would put us back in middle of BW's initialization code
    crate::wait_async_exit();
}

unsafe fn handle_game_request(request: GameThreadRequestType) {
    use self::GameThreadRequestType::*;
    match request {
        Initialize => init_bw(),
        RunWndProc => forge::run_wnd_proc(),
        StartGame => {
            forge::game_started();
            get_bw().run_game_loop();
            debug!("Game loop ended");
            let results = game_results();
            send_game_msg_to_async(GameThreadMessage::Results(results));
            forge::hide_window();
        }
        // Saves registry settings etc.
        ExitCleanup => {
            get_bw().clean_up_for_exit();
        }
        SetupInfo(info) => {
            if SETUP_INFO.set(info).is_err() {
                warn!("Received second SetupInfo");
            }
        }
    }
}

pub fn set_player_id_mapping(mapping: Vec<PlayerIdMapping>) {
    if PLAYER_ID_MAPPING.set(mapping).is_err() {
        warn!("Player id mapping set twice");
    }
}

pub fn player_id_mapping() -> &'static [PlayerIdMapping] {
    PLAYER_ID_MAPPING.get().map(|x| &**x).unwrap_or_else(|| {
        warn!("Tried to access player id mapping before it was set");
        &[]
    })
}

#[derive(Eq, PartialEq, Copy, Clone)]
pub enum PlayerLoseType {
    UnknownChecksumMismatch,
    UnknownDisconnect,
}

pub struct GameThreadResults {
    // Index by ingame player id
    pub victory_state: [u8; 8],
    pub race: [u8; 8],
    /// player id -> alliance state for other player id
    /// 0 = unallied, 1 = allied, 2 = allied with allied victory
    pub alliances: [[u8; 8]; 8],
    /// Index by storm id, says whether a player was dropped (booted for checksum mismatch, lag)
    pub player_was_dropped: [bool; 8],
    /// Index by storm id, says whether a player left voluntarily
    pub player_has_quit: [bool; 8],
    pub player_lose_type: Option<PlayerLoseType>,
    pub time_ms: u32,
}

unsafe fn game_results() -> GameThreadResults {
    let bw = get_bw();
    let game = bw.game();
    let players = bw.players();

    GameThreadResults {
        victory_state: (*game).victory_state,
        race: {
            let mut arr = [bw::RACE_ZERG; 8];
            for i in 0..8 {
                arr[i] = (*players.add(i as usize)).race;
            }
            arr
        },
        player_was_dropped: {
            let mut arr = [false; 8];
            for i in 0..8 {
                arr[i] = (*game).player_was_dropped[i] != 0;
            }
            arr
        },
        player_has_quit: {
            let mut arr = [false; 8];
            for (i, flag) in bw.storm_player_flags().iter().enumerate().take(8) {
                arr[i] = *flag == 0
            }
            arr
        },
        player_lose_type: match (*game).player_lose_type {
            1 => Some(PlayerLoseType::UnknownChecksumMismatch),
            2 => Some(PlayerLoseType::UnknownDisconnect),
            _ => None,
        },
        alliances: {
            let mut arr = [[0; 8]; 8];
            for i in 0..8 {
                arr[i].clone_from_slice(&(*game).alliances[i][0..8]);
            }
            arr
        },
        // Assuming fastest speed
        time_ms: (*game).frame_count.saturating_mul(42),
    }
}

// Does the rest of initialization that is being done in main thread before running forge's
// window proc.
unsafe fn init_bw() {
    let bw = get_bw();
    bw.init_sprites();
    (*bw.game()).is_bw = 1;
    debug!("Process initialized");
}

/// Bw impl is expected to hook the point after init_game_data and call this.
pub unsafe fn after_init_game_data() {
    // Let async thread know about player randomization.
    // The function that bw_1161/bw_scr refer to as init_game_data mainly initializes global
    // data structures used in a game. Player randomization seems to have been done before that,
    // so if it ever in future ends up being the case that the async thread has a point where it
    // uses wrong game player ids, a more exact point for this hook should be decided.
    //
    // But for now it should be fine, and this should also be late enough in initialization that
    // any possible alternate branches for save/replay/ums randomization should have been executed
    // as well.
    let bw = get_bw();
    let mut mapping = [None; bw::MAX_STORM_PLAYERS];
    let players = bw.players();
    debug!("After randomization:");
    for i in 0..16 {
        let player = *players.add(i);
        debug!(
            "Slot {} has id {}, player_type {}, storm_id {}",
            i, player.id, player.player_type, player.storm_id
        );
        let storm_id = player.storm_id;
        if let Some(out) = mapping.get_mut(storm_id as usize) {
            *out = Some(i as u8);
        }
    }

    let game_data = bw.game_data();
    let had_allies_enabled = (*game_data).game_template.allies_enabled != 0;
    bw::set_had_allies_enabled(had_allies_enabled);
    if setup_info().disable_alliance_changes.unwrap_or(false) {
        (*game_data).game_template.allies_enabled = 0;
    }

    send_game_msg_to_async(GameThreadMessage::PlayersRandomized(mapping));
    // Create fog-of-war sprites for any neutral buildings
    if !is_ums() {
        for unit in bw.active_units() {
            if unit.player() == 11 && unit.is_landed_building() {
                bw.create_fow_sprite(unit);
            }
        }
    }
}

pub fn is_ums() -> bool {
    // TODO This returns false on replays. Also same thing about looking at BW's
    // structures as for is_team_game
    SETUP_INFO
        .get()
        .and_then(|x| x.game_type())
        .filter(|x| x.is_ums())
        .is_some()
}

pub fn is_team_game() -> bool {
    // Technically it would be better to look at BW's structures instead, but we don't
    // have them available for SC:R right now.
    if is_replay() {
        sbat_replay_data()
            .filter(|x| x.team_game_main_players != [0, 0, 0, 0])
            .is_some()
    } else {
        SETUP_INFO
            .get()
            .and_then(|x| x.game_type())
            .filter(|x| x.is_team_game())
            .is_some()
    }
}

pub fn is_replay() -> bool {
    SETUP_INFO
        .get()
        .and_then(|x| x.map.is_replay)
        .unwrap_or(false)
}

pub fn setup_info() -> &'static GameSetupInfo {
    &*SETUP_INFO.get().unwrap()
}

/// Returns map name (Title, or something else the uploader has renamed it to in SB),
/// without any color chars (Even if the app also filters them out),
/// or characters illegal in filenames on Windows.
pub fn map_name_for_filename() -> String {
    let mut name: String = SETUP_INFO
        .get()
        .and_then(|x| x.map.name.as_deref())
        .unwrap_or("(Unknown map name)")
        .into();
    name.retain(|c| match c {
        '/' | '\\' | '"' | '*' | '?' | '<' | '>' | ':' | '|' => false,
        x if x < (0x20 as char) => false,
        _ => true,
    });
    name
}

/// Bw impl is expected to call this after step_game,
/// the function that progresses game objects by a tick/frame/step.
/// In other words, if the game isn't paused/lagging, this gets ran 24 times in second
/// on fastest game speed.
/// This function can be used for hooks that change gameplay state after BW has done (most of)
/// its once-per-gameplay-frame processing but before anything gets rendered. It probably
/// isn't too useful to us unless we end up having a need to change game rules.
pub unsafe fn after_step_game() {
    let bw = get_bw();
    if is_replay() && !is_ums() {
        // One thing BW's step_game does is that it removes any fog sprites that were
        // no longer in fog. Unfortunately now that we show fog sprites for unexplored
        // resources as well, removing those fog sprites ends up being problematic if
        // the user switches vision off from a player who had those resources explored.
        // In such case the unexplored fog sprites would not appear and some of the
        // expansions would show up as empty while other unexplored bases keep their
        // fog sprites as usual.
        // To get around this issue, check which neutral buildings don't have fog
        // sprites and add them back.

        let mut fow_sprites = FxHashSet::with_capacity_and_hasher(256, Default::default());
        for fow in bw.fow_sprites() {
            let sprite = (*fow).sprite;
            let pos = bw.sprite_position(sprite);
            fow_sprites.insert((pos.x, pos.y, UnitId((*fow).unit_id)));
        }
        let replay_visions = bw.replay_visions();
        for unit in bw.active_units() {
            if unit.player() == 11 && unit.is_landed_building() {
                // This currently adds fow sprites even for buildings that became
                // neutral after player left. It's probably fine, but if it wasn't
                // desired, checking that `sprite.player == 11` should only include
                // buildings that existed from map start
                if let Some(sprite) = unit.sprite() {
                    let is_visible = replay_visions.show_entire_map
                        || sprite.visibility_mask() & replay_visions.players != 0;
                    if !is_visible {
                        let pos = bw.sprite_position(*sprite as *mut c_void);
                        if fow_sprites.insert((pos.x, pos.y, unit.id())) {
                            bw.create_fow_sprite(unit);
                        }
                    }
                }
            }
        }
    }
}

/// Reimplementation of replay command reading & processing since the default implementation
/// has buffer overflows for replays where there are too many commands in a frame.
///
/// A function pointer for the original function is still needed to handle replay ending
/// case which we don't need to touch.
pub unsafe fn step_replay_commands(orig: unsafe extern "C" fn()) {
    let bw = get_bw();
    let game = bw.game();
    let replay = bw.replay_data();
    let command_lengths = bw.game_command_lengths();
    let frame = (*game).frame_count;
    let data_end = (*replay).data_start.add((*replay).data_length as usize);
    let remaining_length = (data_end as usize).saturating_sub((*replay).data_pos as usize);
    // Data is in format
    // u32 frame, u8 length, { u8 storm_player, u8 cmd[] }[length]
    // Repeated for each frame in replay, if the commands don't fit in a single frame
    // then there can be repeated blocks with equal frame number.
    let mut data = std::slice::from_raw_parts((*replay).data_pos, remaining_length);
    if data.is_empty() {
        // Let the original function handle replay ending
        orig();
        return;
    }

    loop {
        let (mut frame_data, rest) = match replay_next_frame(data) {
            Some(s) => s,
            None => {
                warn!("Broken replay? Unable to read next frame");
                (*replay).data_pos = data_end;
                return;
            }
        };
        if frame_data.frame > frame {
            break;
        }
        data = rest;
        while let Some((storm_player, command)) = frame_data.next_command(command_lengths) {
            bw.process_replay_commands(command, storm_player);
        }
    }
    let new_pos = (data_end as usize - data.len()) as *mut u8;
    (*replay).data_pos = new_pos;
}

struct ReplayFrame<'a> {
    frame: u32,
    // (u8 storm_player, u8 command[...]) pairs repeated.
    // (Command length must be known from the data)
    commands: &'a [u8],
}

fn replay_next_frame<'a>(input: &'a [u8]) -> Option<(ReplayFrame<'a>, &'a [u8])> {
    let &commands_len = input.get(4)?;
    let frame = LittleEndian::read_u32(input.get(..4)?);
    let rest = input.get(5..)?;
    let commands = rest.get(..commands_len as usize)?;
    let rest = rest.get(commands_len as usize..)?;
    Some((ReplayFrame { frame, commands }, rest))
}

impl<'a> ReplayFrame<'a> {
    pub fn next_command(&mut self, command_lengths: &[u32]) -> Option<(StormPlayerId, &'a [u8])> {
        let player = StormPlayerId(*self.commands.get(0)?);
        let data = self.commands.get(1..)?;
        let length = bw::commands::command_length(data, command_lengths)?;
        let command = data.get(..length)?;
        let rest = data.get(length..)?;
        self.commands = rest;
        Some((player, command))
    }
}

/// Bw impl is expected to hook the point before init_unit_data and call this.
/// (It happens to be easy function for SC:R analysis to find and in a nice
/// spot to inject game init hooks for things that require initialization to
/// have progressed a bit but not too much)
pub unsafe fn before_init_unit_data(bw: &dyn Bw) {
    let game = bw.game();
    if let Some(ext) = sbat_replay_data() {
        // This makes team game replays work.
        // This hook is unfortunately after the game has calculated
        // max supply for team games (It can be over 200), so we'll have to fix
        // those as well.
        //
        // (I don't think we have a better way to check for team game replay right now
        // other than just assuming that non-team games have main players as [0, 0, 0, 0])
        if ext.team_game_main_players != [0, 0, 0, 0] {
            (*game).team_game_main_player = ext.team_game_main_players;
            (*game).starting_races = ext.starting_races;
            let team_count = ext
                .team_game_main_players
                .iter()
                .take_while(|&&x| x != 0xff)
                .count();
            let players_per_team = match team_count {
                2 => 4,
                3 => 3,
                4 => 2,
                _ => 0,
            };

            // Non-main players get 0 max supply.
            // Clear what bw had already initialized.
            // (Other players having unused max supply likely won't matter but you never know)
            for race_supplies in (*game).supplies.iter_mut() {
                for max in race_supplies.max.iter_mut() {
                    *max = 0;
                }
            }

            let mut pos = 0;
            for i in 0..team_count {
                let main_player = ext.team_game_main_players[i] as usize;
                let first_pos = pos;
                let mut race_counts = [0; 3];
                for _ in 0..players_per_team {
                    // The third team of 3-team game has only two slots, they
                    // get their first slot counted twice
                    let index = match pos < 8 {
                        true => pos,
                        false => first_pos,
                    };
                    let race = ext.starting_races[index];
                    race_counts[race as usize] += 1;
                    pos += 1;
                }
                for race in 0..3 {
                    let count = race_counts[race].max(1);
                    // This value is twice the displayed, so 200 max supply for each
                    // player in team. (Or 200 if none)
                    (*game).supplies[race].max[main_player] = count * 400;
                }
            }
        }
    }
}

pub unsafe fn after_status_screen_update(bw: &dyn Bw, status_screen: Dialog, unit: Unit) {
    // Show "Stacked (n)" text for stacked buildings
    if unit.is_landed_building() {
        fn normalize_id(id: UnitId) -> UnitId {
            use bw_dat::unit;
            // For mineral fields, consider any mineral field unit as equivalent.
            // May be useful in some fastest maps.
            match id {
                unit::MINERAL_FIELD_2 | unit::MINERAL_FIELD_3 => unit::MINERAL_FIELD_1,
                x => x,
            }
        }

        // Find units that have same unit id and collide with this unit's center
        // (So they don't necessarily have to be perfectly stacked)
        let mut count = 0;
        let pos = unit.position();
        let id = normalize_id(unit.id());
        // Doing a loop like this through every active unit is definitely worse
        // than using some position searching structure, but building that structure
        // would still require looping through the units once.
        // If we have such structure in future for some other code it should be used
        // here too though.
        for other in bw.active_units() {
            if normalize_id(other.id()) == id {
                if other.collision_rect().contains_point(&pos) {
                    count += 1;
                }
            }
        }
        if count > 1 {
            // Show the text at where unit rank/status is usually, as long as it hasn't
            // been used.
            if let Some(rank_status) = status_screen.child_by_id(-20) {
                let existing_text = rank_status.string();
                if rank_status.is_hidden()
                    || existing_text.starts_with("Stacked")
                    || existing_text.is_empty()
                {
                    use std::io::Write;

                    let mut buffer = [0; 32];
                    let buf_len = buffer.len();
                    let mut out = &mut buffer[..];
                    // TODO: Could use translations in other SC:R languages :)
                    let _ = write!(&mut out, "Stacked ({})", count);
                    let len = buf_len - out.len();
                    rank_status.set_string(&buffer[..len]);
                    rank_status.show();
                }
            }
        }
    }
}
