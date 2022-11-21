use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::io;
use std::mem;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::pin_mut;
use futures::prelude::*;
use http::header::{HeaderMap, ORIGIN};
use quick_error::quick_error;
use tokio::select;
use tokio::sync::{mpsc, oneshot};

use crate::app_messages::{
    GamePlayerResult, GameResults, GameResultsReport, GameSetupInfo, LocalUser, MapForce,
    NetworkStallInfo, PlayerInfo, Race, Route, SbUserId, Settings, SetupProgress, UmsLobbyRace,
    GAME_STATUS_ERROR,
};
use crate::app_socket;
use crate::bw::{self, get_bw, GameType, StormPlayerId, UserLatency};
use crate::cancel_token::{CancelToken, Canceler, SharedCanceler};
use crate::forge;
use crate::game_thread::{
    self, GameThreadMessage, GameThreadRequest, GameThreadRequestType, GameThreadResults,
};
use crate::network_manager::{
    GameStateToNetworkMessage, NetworkError, NetworkManager, NetworkToGameStateMessage,
};
use crate::proto::messages::game_message_payload::Payload;
use crate::proto::messages::{ClientAckResponseMessage, ClientReadyMessage};
use crate::replay;
use crate::snp;

pub struct GameState {
    init_state: InitState,
    network: NetworkManager,
    network_send: mpsc::Sender<GameStateToNetworkMessage>,
    ws_send: app_socket::SendMessages,
    internal_send: SendMessages,
    init_main_thread: std::sync::mpsc::Sender<()>,
    send_main_thread_requests: std::sync::mpsc::Sender<GameThreadRequest>,
    #[allow(dead_code)]
    running_game: Option<Canceler>,
    async_stop: SharedCanceler,
    can_start_game: AwaitableTaskState,
    game_started: bool,
}

pub type SendMessages = mpsc::Sender<GameStateMessage>;

enum AwaitableTaskState<T = ()> {
    Complete,
    /// Things waiting for the task to complete push wakeup sender here
    Incomplete(Vec<oneshot::Sender<T>>),
}

enum InitState {
    WaitingForInput(IncompleteInit),
    Started(InitInProgress),
}

struct IncompleteInit {
    local_user: Option<LocalUser>,
    settings_set: bool,
    routes_set: bool,
}

impl IncompleteInit {
    fn init_if_ready(
        &mut self,
        info: &Arc<GameSetupInfo>,
    ) -> Result<InitInProgress, GameInitError> {
        if !self.settings_set {
            return Err(GameInitError::SettingsNotSet);
        }
        if !self.routes_set {
            return Err(GameInitError::RoutesNotSet);
        }
        if self.local_user.is_none() {
            return Err(GameInitError::LocalUserNotSet);
        }
        Ok(InitInProgress::new(
            info.clone(),
            Arc::new(self.local_user.take().unwrap()),
        ))
    }
}

/// Messages sent from other async tasks to communicate with GameState
pub enum GameStateMessage {
    SetSettings(Settings),
    SetRoutes(Vec<Route>),
    SetLocalUser(LocalUser),
    SetupGame(GameSetupInfo),
    StartWhenReady,
    InLobby,
    PlayersChanged,
    GameSetupDone,
    GameThread(GameThreadMessage),
    Network(NetworkToGameStateMessage),
    CleanupQuit,
    QuitIfNotStarted,
}

impl GameSetupInfo {
    pub fn game_type(&self) -> Option<GameType> {
        let (primary, subtype) = match &*self.game_type {
            "melee" => (0x2, 0x1),
            "ffa" => (0x3, 0x1),
            "oneVOne" => (0x4, 0x1),
            "ums" => (0xa, 0x1),
            // For team games the shieldbattery subtype is team count
            "teamMelee" => (0xb, self.game_sub_type? - 1),
            "teamFfa" => (0xc, self.game_sub_type? - 1),
            // For TvB the shieldbattery subtype is num players on top team
            "topVBottom" => (0xf, self.game_sub_type?),
            _ => return None,
        };
        Some(GameType { primary, subtype })
    }
}

quick_error! {
    #[derive(Debug, Clone)]
    pub enum GameInitError {
        InitInProgress {
            display("Game init is already in progress")
        }
        SettingsNotSet {
            display("Settings not set")
        }
        LocalUserNotSet {
            display("Local user not set")
        }
        RoutesNotSet {
            display("Routes not set")
        }
        Closed {
            display("Game is being closed")
        }
        GameInitAlreadyInProgress {
            display("Cannot have two game inits active at once")
        }
        GameInitNotInProgress {
            display("Game isn't being inited")
        }
        UnexpectedPlayer(name: String) {
            display("Unexpected player name: {}", name)
        }
        NoShieldbatteryId(name: String) {
            display("Player {} doesn't have shieldbattery user id", name)
        }
        StormIdChanged(name: String) {
            display("Unexpected storm id change for player {}", name)
        }
        NetworkInit(e: NetworkError) {
            display("Network initialization error: {}", e)
        }
        UnknownGameType(ty: String, sub: Option<u8>) {
            display("Unknown game type '{}', {:?}", ty, sub)
        }
        Bw(e: bw::LobbyCreateError) {
            display("BW error: {}", e)
        }
        NonAnsiPath(path: PathBuf) {
            display("Path '{}' cannot be passed to BW", path.display())
        }
        MissingMapInfo(desc: &'static str) {
            display("Missing map info '{}'", desc)
        }
        NullInPath(path: String) {
            display("Path '{}' contains null character", path)
        }
    }
}

impl GameState {
    fn set_settings(&mut self, settings: &Settings) {
        if let InitState::WaitingForInput(ref mut state) = self.init_state {
            forge::init(&settings.local);
            get_bw().set_settings(settings);
            state.settings_set = true;
        } else {
            error!("Received settings after game was started");
        }
    }

    fn set_local_user(&mut self, user: LocalUser) {
        if let InitState::WaitingForInput(ref mut state) = self.init_state {
            state.local_user = Some(user);
        } else {
            error!("Received local user after game was started");
        }
    }

    fn set_routes(&mut self, routes: Vec<Route>) -> impl Future<Output = ()> {
        if let InitState::WaitingForInput(ref mut state) = self.init_state {
            state.routes_set = true;
            // TODO log error
            self.network.set_routes(routes).map(|_| ()).boxed()
        } else {
            error!("Received routes after game was started");
            future::ready(()).boxed()
        }
    }

    fn send_game_request(
        &mut self,
        request_type: GameThreadRequestType,
    ) -> impl Future<Output = ()> {
        send_game_request(&self.send_main_thread_requests, request_type)
    }

    fn wait_can_start_game(&mut self) -> impl Future<Output = ()> {
        let recv = match self.can_start_game {
            AwaitableTaskState::Incomplete(ref mut waiters) => {
                let (send, recv) = oneshot::channel();
                waiters.push(send);
                Some(recv)
            }
            AwaitableTaskState::Complete => None,
        };
        async move {
            if let Some(recv) = recv {
                let _ = recv.await;
            }
        }
    }

    /// On success, returns once game is ready to be started & shown.
    fn init_game(
        &mut self,
        info: GameSetupInfo,
    ) -> impl Future<Output = Result<(), GameInitError>> {
        let game_type = match info.game_type() {
            Some(s) => s,
            None => {
                let err = GameInitError::UnknownGameType(info.game_type, info.game_sub_type);
                return future::err(err).boxed();
            }
        };

        let info = Arc::new(info);
        // The complete initialization logic is split between futures in this function
        // and self.init_state updating itself in response to network events,
        // both places poking bw's state as well..
        // It may probably be better to move everything to InitInProgress and have this
        // function just initialize it?
        // For now it's worth noting that until the `init_state.wait_for_players` future
        // completes, InitInProgress will update bw's player state.
        let mut init_state = match self.init_state {
            InitState::WaitingForInput(ref mut state) => match state.init_if_ready(&info) {
                Ok(o) => o,
                Err(e) => return future::err(e).boxed(),
            },
            InitState::Started(_) => {
                return future::err(GameInitError::InitInProgress).boxed();
            }
        };
        let local_user = init_state.local_user.clone();
        let mut players_joined = init_state.wait_for_players().boxed();
        let all_players_ready = init_state.wait_all_players_ready().boxed();
        self.init_state = InitState::Started(init_state);

        let send_messages_to_state = self.internal_send.clone();
        let game_request_send = self.send_main_thread_requests.clone();

        let network_send = self.network_send.clone();
        let init_routes_when_ready_future = self.network.init_routes_when_ready();
        let network_ready_future = self.network.wait_network_ready();
        let net_game_info_set_future = self.network.set_game_info(info.clone());
        let allow_start = self.wait_can_start_game().boxed();

        self.init_main_thread
            .send(())
            .expect("Main thread should be waiting for a wakeup");
        async move {
            let sbat_replay_data = match info.is_replay() {
                true => Some(read_sbat_replay_data(Path::new(&info.map_path))),
                false => None,
            };
            // We tell BW thread to init, and then it'll stay in forge's WndProc until we're
            // ready to start the game - remaining initialization is done from other threads.
            // Could possibly aim to keep all of BW initialization in the main thread, but this
            // system has worked fine so far.
            let is_host = local_user.name == info.host.name;
            let req = send_game_request(
                &game_request_send,
                GameThreadRequestType::SetupInfo(info.clone()),
            );
            req.await;
            let req = send_game_request(&game_request_send, GameThreadRequestType::Initialize);
            req.await;
            unsafe {
                get_bw().remaining_game_init(&local_user.name);
                if is_host {
                    create_lobby(&info, game_type)?;
                }
            }
            init_routes_when_ready_future
                .await
                .map_err(GameInitError::NetworkInit)?;
            start_game_request(&game_request_send, GameThreadRequestType::RunWndProc)
                .map_err(|()| GameInitError::Closed)?;
            net_game_info_set_future
                .await
                .map_err(GameInitError::NetworkInit)?;
            network_ready_future
                .await
                .map_err(GameInitError::NetworkInit)?;
            debug!("Network ready");
            if !is_host {
                unsafe {
                    join_lobby(&info, game_type).await?;
                }
            }

            if let Some(latency) = info.user_latency {
                let latency = match latency {
                    0 => UserLatency::Low,
                    1 => UserLatency::High,
                    2 => UserLatency::ExtraHigh,
                    val => {
                        warn!("Invalid user latency value: {}", val);
                        UserLatency::Low
                    }
                };
                debug!("Setting initial user latency: {:?}", latency);
                let bw = get_bw();
                unsafe {
                    bw.set_user_latency(latency);
                }
            }

            debug!("In lobby, setting up slots");
            unsafe {
                let ums_forces = info
                    .map
                    .map_data
                    .as_ref()
                    .map(|x| &x.ums_forces[..])
                    .unwrap_or(&[]);
                setup_slots(&info.slots, game_type, ums_forces);
            }
            send_messages_to_state
                .send(GameStateMessage::InLobby)
                .await
                .map_err(|_| GameInitError::Closed)?;
            let bw = get_bw();
            loop {
                unsafe {
                    let mut someone_left = false;
                    let mut new_players = false;
                    let flags_before = bw.storm_player_flags();
                    bw.maybe_receive_turns();
                    let flags_after = bw.storm_player_flags();
                    let flags = flags_before.iter().zip(flags_after.iter());
                    for (i, (&old, &new)) in flags.enumerate() {
                        if old == 0 && new != 0 {
                            bw.init_network_player_info(i as u32);
                            new_players = true;
                        }
                        if old != 0 && new == 0 {
                            someone_left = true;
                        }
                    }
                    if someone_left {
                        // Somebody seemed to have joined but ended up deciding on their end
                        // that they failed to join. We may be able to recover from
                        // this by just letting them try joining again.
                        warn!(
                            "A player that was joined has left. Before: {:x?} After: {:x?}",
                            flags_before, flags_after,
                        );
                    }

                    if new_players || someone_left {
                        send_messages_to_state
                            .send(GameStateMessage::PlayersChanged)
                            .await
                            .map_err(|_| GameInitError::Closed)?;
                    }
                }
                select! {
                    _ = tokio::time::sleep(Duration::from_millis(42)) => continue,
                    res = &mut players_joined => {
                        res?;
                        break;
                    }
                }
            }
            debug!("All players have joined");
            if let Some(sbat_replay_data_promise) = sbat_replay_data {
                // Assuming that the extra replay data isn't needed in the above lobby
                // initialization.
                match sbat_replay_data_promise.await {
                    Ok(Some(o)) => {
                        debug!("Loaded shieldbattery replay extension");
                        game_thread::set_sbat_replay_data(o);
                    }
                    Ok(None) => (),
                    Err(e) => {
                        // Going to assume that most of the time if we fail to read the
                        // extra replay data, it won't be fatal, so just log the error
                        // and continue.
                        error!("Failed to read shieldbattery replay data: {}", e);
                    }
                }
            }

            if !is_host {
                debug!("Notifying host that client is ready");
                network_send
                    .send(GameStateToNetworkMessage::SendPayload(
                        info.host.user_id.unwrap(),
                        Some(Payload::ClientReady(ClientReadyMessage::default())),
                    ))
                    .await
                    .map_err(|_| GameInitError::Closed)?;
                // Note that we don't need to wait for anything further as a non-host, the game's
                // normal seed event will signal it's time to start (handled in do_lobby_game_init)
            } else {
                // Wait for all the players to be ready to start, and the server to let us go
                let mut ready_future =
                    future::try_join(allow_start.map(|_| Ok(())), all_players_ready);
                loop {
                    unsafe {
                        bw.maybe_receive_turns();
                    }

                    select! {
                        _ = tokio::time::sleep(Duration::from_millis(42)) => continue,
                        res = &mut ready_future => {
                            res?;
                            break
                        },
                    }
                }

                debug!("All players are ready to start");
            }

            unsafe {
                do_lobby_game_init(&info).await;
            }
            send_messages_to_state
                .send(GameStateMessage::GameSetupDone)
                .await
                .map_err(|_| GameInitError::Closed)?;
            Ok(())
        }
        .boxed()
    }

    /// Future finishes after results have been sent to server
    fn run_game(&mut self) -> impl Future<Output = Result<(), GameInitError>> {
        let init_state = match self.init_state {
            InitState::Started(ref mut s) => s,
            _ => return future::err(GameInitError::GameInitNotInProgress).boxed(),
        };
        let local_user = init_state.local_user.clone();
        let info = init_state.setup_info.clone();
        self.game_started = true;

        let ws_send = self.ws_send.clone();
        let game_request_send = self.send_main_thread_requests.clone();
        let setup_info = init_state.setup_info.clone();
        let network_send = self.network_send.clone();
        let results = init_state.wait_for_results();
        async move {
            forge::end_wnd_proc();
            let start_game_request = GameThreadRequestType::StartGame;
            let game_done = send_game_request(&game_request_send, start_game_request);

            app_socket::send_message(&ws_send, "/game/start", ())
                .await
                .map_err(|_| GameInitError::Closed)?;

            game_done.await;
            let results = results.await?;

            // Make sure (or at least try to) that quit messages get delivered to everyone and don't
            // get lost, so that quitting players don't trigger a drop screen.
            let mut deliver_final_network = Vec::new();
            for (&uid, _) in results
                .results
                .iter()
                .filter(|(_, r)| r.result == 0 /* playing */)
            {
                if let Some(slot) = setup_info
                    .slots
                    .iter()
                    .find(|&s| uid == s.user_id.unwrap_or(SbUserId(0)))
                {
                    debug!("Triggering final network sends for {}", slot.name);
                    let (send, recv) = oneshot::channel();
                    let _ = network_send
                        .send(GameStateToNetworkMessage::DeliverPayloadsInFlight(
                            slot.user_id.unwrap(),
                            send,
                        ))
                        .await
                        .map_err(|e| debug!("Send error {}", e));

                    deliver_final_network.push(recv);
                }
            }

            if !info.is_replay() {
                send_game_result(&results, &info, &local_user, &ws_send).await;
            }

            debug!("Network stall statistics: {:?}", results.network_stalls);

            if !deliver_final_network.is_empty() {
                select! {
                    _ = future::join_all(deliver_final_network) => {},
                    _ = tokio::time::sleep(Duration::from_millis(5000)) => {},
                }
            }
            debug!("Final network sends completed");

            app_socket::send_message(&ws_send, "/game/finished", ())
                .await
                .map_err(|_| GameInitError::Closed)?;

            Ok(())
        }
        .boxed()
    }

    // Message handler, so ideally only return futures that are about sending
    // messages to other tasks.
    fn handle_message(&mut self, message: GameStateMessage) -> impl Future<Output = ()> {
        use self::GameStateMessage::*;

        match message {
            SetSettings(settings) => {
                self.set_settings(&settings);
            }
            SetLocalUser(user) => {
                self.set_local_user(user);
            }
            SetRoutes(routes) => {
                return self.set_routes(routes).boxed();
            }
            StartWhenReady => {
                match mem::replace(&mut self.can_start_game, AwaitableTaskState::Complete) {
                    AwaitableTaskState::Complete => (),
                    AwaitableTaskState::Incomplete(waiting) => {
                        for sender in waiting {
                            let _ = sender.send(());
                        }
                    }
                }
            }
            SetupGame(info) => {
                let ws_send = self.ws_send.clone();
                let async_stop = self.async_stop.clone();
                let game_ready = self.init_game(info);
                let task = async move {
                    if let Err(e) = game_ready.await {
                        let msg = format!("Failed to init game: {}", e);
                        error!("{}", msg);

                        let message = SetupProgress {
                            status: crate::app_messages::SetupProgressInfo {
                                state: GAME_STATUS_ERROR,
                                extra: Some(msg),
                            },
                        };
                        let _ = app_socket::send_message(&ws_send, "/game/setupProgress", message)
                            .await;
                        expect_quit(&async_stop).await;
                    }
                };
                let (cancel_token, canceler) = CancelToken::new();
                self.running_game = Some(canceler);
                tokio::spawn(async move {
                    pin_mut!(task);
                    cancel_token.bind(task).await
                });
            }
            InLobby | PlayersChanged => {
                if let InitState::Started(ref mut state) = self.init_state {
                    state.players_changed();
                } else {
                    warn!("Player joined before init was started");
                }
            }
            GameSetupDone => {
                let game_done = self.run_game();
                let async_stop = self.async_stop.clone();
                let task = async move {
                    if let Err(e) = game_done.await {
                        error!("Error on running game: {}", e);
                    }
                    debug!("Game play task ended");
                    expect_quit(&async_stop).await;
                };
                let (cancel_token, canceler) = CancelToken::new();
                self.running_game = Some(canceler);
                tokio::spawn(async move {
                    pin_mut!(task);
                    cancel_token.bind(task).await
                });
            }
            GameThread(msg) => {
                return self.handle_game_thread_message(msg);
            }
            Network(msg) => {
                return self.handle_network_message(msg);
            }
            CleanupQuit => {
                let cleanup_request = GameThreadRequestType::ExitCleanup;
                let async_stop = self.async_stop.clone();
                let cleanup_done = self.send_game_request(cleanup_request);
                let task = async move {
                    cleanup_done.await;
                    debug!("BW cleanup done, exiting..");
                    async_stop.cancel();
                };
                tokio::spawn(task);
            }
            QuitIfNotStarted => {
                if !self.game_started {
                    debug!("Exiting since game has not started");
                    // Not cleaning up (that is, saving user settings or anything)
                    // since we didn't start in the first place
                    self.async_stop.cancel();
                }
            }
        }
        future::ready(()).boxed()
    }

    fn handle_game_thread_message(
        &mut self,
        message: GameThreadMessage,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        use crate::game_thread::GameThreadMessage::*;
        match message {
            WindowMove(..) => (),
            ReplaySaved(..) => (),
            Snp(snp) => {
                return self.network.send_snp_message(snp).map(|_| ()).boxed();
            }
            PlayersRandomized(new_mapping) => {
                if let InitState::Started(ref mut state) = self.init_state {
                    for player in &mut state.joined_players {
                        let old_id = player.player_id;
                        player.player_id =
                            new_mapping.get(player.storm_id.0 as usize).and_then(|x| *x);
                        if old_id.is_some() != player.player_id.is_some() {
                            warn!(
                                "Player {} lost/gained player id after randomization: {:?} -> {:?}",
                                player.name, old_id, player.player_id,
                            );
                        }
                    }
                    let mapping = state
                        .joined_players
                        .iter()
                        .map(|player| game_thread::PlayerIdMapping {
                            game_id: player.player_id,
                            sb_user_id: player.sb_user_id,
                        })
                        .collect();
                    game_thread::set_player_id_mapping(mapping);
                } else {
                    warn!("Player randomization received too early");
                }
            }
            Results(results) => {
                if let InitState::Started(ref mut state) = self.init_state {
                    state.received_results(results);
                } else {
                    warn!("Received results before init was started");
                }
            }
            NetworkStall(duration) => {
                if let InitState::Started(ref mut state) = self.init_state {
                    state.stall_count += 1;
                    // We stop storing more durations if there have been a ton of stalls, don't want
                    // to use up tons of memory just to get a median
                    if state.stall_count <= 1024 {
                        state.stall_durations.push(duration)
                    }
                    if duration > state.stall_max {
                        state.stall_max = duration;
                    }
                    if duration < state.stall_min {
                        state.stall_min = duration;
                    }
                } else {
                    warn!("Notified of network stall before init was started");
                }
            }
        }
        future::ready(()).boxed()
    }

    fn handle_network_message(
        &mut self,
        msg: NetworkToGameStateMessage,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        use crate::network_manager::NetworkToGameStateMessage::*;
        match msg {
            ReceivePayload(sb_user_id, payload) => match payload {
                Payload::ClientReady(_) => {
                    if let InitState::Started(ref mut state) = self.init_state {
                        if state.unready_players.remove(&sb_user_id) {
                            debug!("{:?} is now ready", sb_user_id)
                        }

                        state.check_unready_players();
                    } else {
                        error!(
                            "Got ClientReady for {:?} before init had started",
                            sb_user_id
                        );
                    }
                }
                Payload::ClientAckRequest(_) => {
                    // Trigger a response to this packet immediately to deliver any acks.
                    let network_send = self.network_send.clone();
                    tokio::spawn(async move {
                        let _ = network_send
                            .send(GameStateToNetworkMessage::SendPayload(
                                sb_user_id,
                                Some(Payload::ClientAckResponse(
                                    ClientAckResponseMessage::default(),
                                )),
                            ))
                            .await
                            .map_err(|e| error!("Send error {}", e));
                    });
                }
                _ => {}
            },
        }
        future::ready(()).boxed()
    }
}

async fn expect_quit(async_stop: &SharedCanceler) {
    tokio::time::sleep(Duration::from_millis(10000)).await;
    // The app is supposed to send a CleanupQuit command to acknowledge
    // that it received /game/end, or simple quit on error, but maybe it died?
    //
    // TODO(neive): Would be nice to do CleanupQuit if we finished game
    // succesfully even if the app didn't end up replying to us?
    warn!("Didn't receive close command, exiting automatically");
    async_stop.cancel();
}

async fn send_game_result(
    results: &GameResults,
    info: &GameSetupInfo,
    local_user: &LocalUser,
    ws_send: &app_socket::SendMessages,
) {
    // Send results to the app.
    // If the app is closed, ignore the error and try to still send results to server.
    let _ = app_socket::send_message(ws_send, "/game/result", &results).await;

    if info.result_code.is_none() {
        debug!("Had no result code, skipping sending results");
        return;
    }

    // Attempt to send results to the server, if this fails, we expect
    // the app to retry in the future
    let client = reqwest::Client::new();
    let result_url = format!("{}/api/1/games/{}/results2", info.server_url, info.game_id);

    let mut result_headers = HeaderMap::new();
    result_headers.insert(ORIGIN, "shieldbattery://game".parse().unwrap());

    let result_body = GameResultsReport {
        user_id: local_user.id,
        result_code: info.result_code.clone().unwrap(),
        time: results.time_ms,
        player_results: results
            .results
            .iter()
            .map(|(&uid, result)| (uid, result.clone()))
            .collect(),
    };

    for _ in 0u8..3 {
        let result = client
            .post(&result_url)
            .timeout(Duration::from_secs(30))
            .headers(result_headers.clone())
            .json(&result_body)
            .send()
            .await;

        match result.and_then(|r| r.error_for_status()) {
            Ok(_) => {
                debug!("Game results sent successfully");
                let _ = app_socket::send_message(ws_send, "/game/resultSent", ()).await;
                break;
            }
            Err(err) => {
                error!("Error sending game results: {}", err);
            }
        };
    }
}

struct InitInProgress {
    all_players_joined: AwaitableTaskState<Result<(), GameInitError>>,
    all_players_ready: AwaitableTaskState<()>,
    setup_info: Arc<GameSetupInfo>,
    local_user: Arc<LocalUser>,
    joined_players: Vec<JoinedPlayer>,
    unready_players: HashSet<SbUserId>,
    waiting_for_result: Vec<oneshot::Sender<Arc<GameResults>>>,
    stall_durations: Vec<Duration>,
    stall_count: usize,
    stall_min: Duration,
    stall_max: Duration,
}

#[derive(Debug)]
struct JoinedPlayer {
    name: String,
    storm_id: StormPlayerId,
    player_id: Option<u8>,
    sb_user_id: SbUserId,
}

impl InitInProgress {
    fn new(setup_info: Arc<GameSetupInfo>, local_user: Arc<LocalUser>) -> InitInProgress {
        let is_host = setup_info.host.name == local_user.name;
        // Only the host tracks client readiness
        let unready_players = if is_host {
            setup_info
                .slots
                .iter()
                .filter_map(|slot| {
                    if !slot.is_human() || slot.name == local_user.name {
                        None
                    } else {
                        Some(slot.user_id.unwrap())
                    }
                })
                .collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };

        let mut result = InitInProgress {
            all_players_joined: AwaitableTaskState::Incomplete(Vec::new()),
            all_players_ready: AwaitableTaskState::Incomplete(Vec::new()),
            setup_info,
            local_user,
            joined_players: Vec::new(),
            unready_players,
            waiting_for_result: Vec::new(),
            stall_durations: Vec::new(),
            stall_count: 0,
            stall_max: Duration::from_millis(0),
            stall_min: Duration::MAX,
        };
        result.check_unready_players();

        result
    }

    fn players_changed(&mut self) {
        let result = match unsafe { self.update_joined_state() } {
            Ok(true) => Ok(()),
            Err(e) => Err(e),
            Ok(false) => return,
        };

        match mem::replace(&mut self.all_players_joined, AwaitableTaskState::Complete) {
            AwaitableTaskState::Complete => {}
            AwaitableTaskState::Incomplete(waiting) => {
                for sender in waiting {
                    let _ = sender.send(result.clone());
                }
            }
        }
    }

    // Waits until players have joined.
    // self.players_changed gets called whenever game thread sends a join notification,
    // and once when the init task tells that a player is in lobby.
    fn wait_for_players(&mut self) -> impl Future<Output = Result<(), GameInitError>> {
        let f = match self.all_players_joined {
            AwaitableTaskState::Incomplete(ref mut waiters) => {
                let (send, recv) = oneshot::channel();
                waiters.push(send);
                Some(recv)
            }
            AwaitableTaskState::Complete => None,
        };

        async move {
            if let Some(f) = f {
                f.map_err(|_| GameInitError::Closed).await?
            } else {
                Ok(())
            }
        }
    }

    /// Waits until all players have notified the host that they are ready.
    fn wait_all_players_ready(&mut self) -> impl Future<Output = Result<(), GameInitError>> {
        let f = match self.all_players_ready {
            AwaitableTaskState::Incomplete(ref mut waiters) => {
                let (send, recv) = oneshot::channel();
                waiters.push(send);
                Some(recv)
            }
            AwaitableTaskState::Complete => None,
        };

        async move {
            if let Some(f) = f {
                f.map_err(|_| GameInitError::Closed)
                    .and_then(future::ok)
                    .await
            } else {
                Ok(())
            }
        }
    }

    fn wait_for_results(
        &mut self,
    ) -> impl Future<Output = Result<Arc<GameResults>, GameInitError>> {
        let (send_done, recv_done) = oneshot::channel();
        self.waiting_for_result.push(send_done);
        recv_done.map_err(|_| GameInitError::Closed)
    }

    // Return Ok(true) on done, Ok(false) on keep waiting
    unsafe fn update_joined_state(&mut self) -> Result<bool, GameInitError> {
        let storm_names = storm_player_names(get_bw());
        self.update_bw_slots(&storm_names)?;
        if self.has_all_players() {
            debug!("All players have joined: {:?}", self.joined_players);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    unsafe fn update_bw_slots(
        &mut self,
        storm_names: &[Option<String>],
    ) -> Result<(), GameInitError> {
        let players = get_bw().players();
        // Remove any players that may have left.
        // Should be rare but something may end up making joining player not see themselves
        // join, making them leave a bit later.
        // This is still going to have issues if the last player to join ends up leaving,
        // we probably should add some extra step (E.g. sending some network packet)
        // to make sure the person is totally joined before we add them here at all.
        self.joined_players.retain(|joined_player| {
            let retain = storm_names
                .iter()
                .any(|name| name.as_deref() == Some(&*joined_player.name));
            if !retain {
                warn!("Player {} has left", joined_player.name);
                if let Some(bw_slot) = joined_player.player_id {
                    (*players.add(bw_slot as usize)).storm_id = u32::MAX;
                }
            }
            retain
        });
        for (storm_id, name) in storm_names.iter().enumerate() {
            let storm_id = StormPlayerId(storm_id as u8);
            let name = match name {
                Some(ref s) => &**s,
                None => continue,
            };
            let joined_pos = self.joined_players.iter().position(|x| x.name == name);
            if let Some(joined_pos) = joined_pos {
                if self.joined_players[joined_pos].storm_id != storm_id {
                    return Err(GameInitError::StormIdChanged(name.into()));
                }
            } else if let Some(slot) = self.setup_info.slots.iter().find(|x| x.name == name) {
                // TODO(tec27): This isn't really a player id, more of a slot offset?
                let player_id;
                let bw_slot = (0..16).find(|&i| {
                    let player = players.add(i);
                    let bw_name = CStr::from_ptr((*player).name.as_ptr() as *const i8);
                    bw_name.to_str() == Ok(name)
                });
                if let Some(bw_slot) = bw_slot {
                    (*players.add(bw_slot)).storm_id = storm_id.0 as u32;
                    player_id = Some(bw_slot as u8);
                } else {
                    return Err(GameInitError::UnexpectedPlayer(name.into()));
                }
                if self.joined_players.iter().any(|x| x.player_id == player_id) {
                    return Err(GameInitError::UnexpectedPlayer(name.into()));
                }
                // I believe there isn't any reason why a slot associated with
                // human wouldn't have shieldbattery user ids, so just fail here
                // instead of keeping sb_user_id as Option<u32>.
                let sb_user_id = slot
                    .user_id
                    .ok_or_else(|| GameInitError::NoShieldbatteryId(name.into()))?;
                debug!("Player {} received storm id {}", name, storm_id.0);
                self.joined_players.push(JoinedPlayer {
                    name: name.into(),
                    storm_id,
                    player_id,
                    sb_user_id,
                });
            } else {
                return Err(GameInitError::UnexpectedPlayer(name.into()));
            }
        }
        Ok(())
    }

    fn has_all_players(&self) -> bool {
        let waiting_for = self
            .setup_info
            .slots
            .iter()
            .filter(|s| s.is_human() || s.is_observer())
            .filter(|s| {
                !self
                    .joined_players
                    .iter()
                    .any(|player| s.name == player.name)
            })
            .map(|s| &s.name)
            .collect::<Vec<_>>();
        if waiting_for.is_empty() {
            true
        } else {
            debug!("Waiting for players {:?}", waiting_for);
            false
        }
    }

    /// Checks if there are still any unready players, updating the task state if not.
    fn check_unready_players(&mut self) {
        if self.unready_players.is_empty() {
            match mem::replace(&mut self.all_players_ready, AwaitableTaskState::Complete) {
                AwaitableTaskState::Complete => {}
                AwaitableTaskState::Incomplete(waiting) => {
                    for sender in waiting {
                        let _ = sender.send(());
                    }
                }
            }
        } else {
            debug!("Still waiting for ready from: {:?}", self.unready_players);
        }
    }

    fn received_results(&mut self, game_results: GameThreadResults) {
        use crate::game_thread::PlayerLoseType;

        #[derive(Copy, Clone, Eq, PartialEq)]
        #[repr(u8)]
        enum GameResult {
            Playing = 0,
            Disconnected = 1,
            Defeat = 2,
            Victory = 3,
        }

        let mut results = [GameResult::Playing; bw::MAX_STORM_PLAYERS];
        let local_storm_id = self
            .joined_players
            .iter()
            .find(|x| x.name == self.local_user.name)
            .map(|x| x.storm_id.0 as usize)
            .unwrap_or_else(|| {
                panic!(
                    "Local user ({}) was not in joined players? ({:?})",
                    self.local_user.name, self.joined_players,
                );
            });

        let mut storm_to_player_id = [255; 8];
        let mut player_to_storm_id = [255; 8];
        for player in &self.joined_players {
            if let Some(player_id) = player.player_id {
                if player_id >= 8 {
                    // This is an observer, skip
                    continue;
                }

                let storm_id = player.storm_id.0 as usize;
                let player_id = player_id as usize;
                // This should generally always be true (or other stuff is broken) but just in case
                if storm_id < 8 {
                    storm_to_player_id[storm_id] = player_id;
                    player_to_storm_id[player_id] = storm_id;
                }

                debug!(
                    "{} has victory_state {}",
                    storm_id, game_results.victory_state[player_id]
                );
                results[storm_id] = match game_results.victory_state[player_id] {
                    1 => GameResult::Disconnected,
                    2 => GameResult::Defeat,
                    3 => GameResult::Victory,
                    _ => {
                        if storm_id == local_storm_id {
                            // NOTE(tec27): This will possibly get mapped to a disconnect later, if
                            // allied victory is still possible
                            GameResult::Defeat
                        } else {
                            GameResult::Playing
                        }
                    }
                };
            }
        }
        let storm_to_player_id = storm_to_player_id;
        let player_to_storm_id = player_to_storm_id;

        let lose_type = game_results.player_lose_type;
        let is_ums = self.setup_info.game_type == "ums";
        let has_victory = results.contains(&GameResult::Victory);
        for storm_id in 0..8 {
            let dropped = game_results.player_was_dropped[storm_id];
            let quit =
                game_results.player_has_quit[storm_id] || (!dropped && storm_id == local_storm_id);

            debug!(
                "{} has player_was_dropped {}, player_has_quit {}",
                storm_id, dropped, quit
            );

            if dropped {
                results[storm_id] = if lose_type == Some(PlayerLoseType::UnknownDisconnect) {
                    // Player was dropped because our client was in the wrong, so they're probably
                    // still playing in the parallel universe game
                    GameResult::Playing
                } else {
                    // Player was actually dropped, so change their defeat -> disconnect
                    GameResult::Disconnected
                };
            } else if quit && !is_ums && !has_victory && results[storm_id] == GameResult::Defeat {
                let player_id = storm_to_player_id[storm_id];
                if player_id < 8 {
                    let alliances = game_results.alliances[player_id];
                    for (p, _) in alliances.iter().enumerate().filter(|&(_, a)| *a == 2) {
                        let s = player_to_storm_id[p];
                        if s < 8
                            && !game_results.player_was_dropped[s]
                            && !game_results.player_has_quit[s]
                        {
                            // Change Defeat -> Disconnect because we can't know the terminal result yet,
                            // and this alliance could allow this player to win still
                            results[storm_id] = GameResult::Disconnected;
                            break;
                        }
                    }
                }
            }
        }
        match lose_type {
            Some(PlayerLoseType::UnknownDisconnect) => {
                results[local_storm_id] = GameResult::Disconnected;
            }
            Some(PlayerLoseType::UnknownChecksumMismatch) => {
                results[local_storm_id] = GameResult::Playing;
            }
            None => (),
        }

        if !is_ums && has_victory {
            // If someone has won and has the "allied victory" box checked, bring their allies along
            // for the victory even if they disconnected. (Note that we don't do this for UMS games
            // because it's assumed the UMS triggers manage their own victory state as they wish)
            let mut to_process: Vec<usize> = vec![];

            for player in &self.joined_players {
                if let Some(player_id) = player.player_id {
                    if player_id >= 8 {
                        // This is an observer, skip
                        continue;
                    }
                    let storm_id = player.storm_id.0 as usize;
                    if results[storm_id] == GameResult::Victory {
                        to_process.push(player_id as usize);
                    }
                }
            }

            while let Some(winner_player_id) = to_process.pop() {
                let winner_alliances = game_results.alliances[winner_player_id];
                debug!(
                    "processing player {}, alliances: {:?}",
                    winner_player_id, winner_alliances
                );

                for player in &self.joined_players {
                    if let Some(player_id) = player.player_id {
                        if player_id >= 8 {
                            // This is an observer, skip
                            continue;
                        }

                        let player_id = player_id as usize;
                        if player_id == winner_player_id {
                            // Don't need to worry about the player themselves
                            continue;
                        }

                        let storm_id = player.storm_id.0 as usize;
                        let allied_with_winner =
                            game_results.alliances[player_id][winner_player_id] == 2;
                        if allied_with_winner
                            && winner_alliances[player_id] == 2
                            && !matches!(
                                results[storm_id],
                                GameResult::Playing | GameResult::Victory
                            )
                        {
                            results[storm_id] = GameResult::Victory;
                            // Changing this player's result can mean that their allies now win, so
                            // we need to process them as well
                            to_process.push(player_id);
                        }
                    }
                }
            }

            // Now that we've processed all the possible victories, any players left as disconnected
            // are actually defeated
            for player in &self.joined_players {
                if let Some(player_id) = player.player_id {
                    if player_id >= 8 {
                        // This is an observer, skip
                        continue;
                    }
                    let storm_id = player.storm_id.0 as usize;
                    if results[storm_id] == GameResult::Disconnected {
                        results[storm_id] = GameResult::Defeat;
                    }
                }
            }
        }

        let results = self
            .joined_players
            .iter()
            .filter_map(|player| {
                if let Some(player_id) = player.player_id {
                    if player_id >= 8 {
                        // Observer, skip
                        return None;
                    }

                    Some((
                        player.sb_user_id,
                        GamePlayerResult {
                            result: results[player.storm_id.0 as usize] as u8,
                            race: match game_results.race[player_id as usize] {
                                bw::RACE_ZERG => Race::Zerg,
                                bw::RACE_TERRAN => Race::Terran,
                                bw::RACE_PROTOSS => Race::Protoss,
                                r => {
                                    warn!("Invalid race ({}) for player {}", r, player_id);
                                    Race::Zerg
                                }
                            },
                            // TODO(tec27): implement APM calculation
                            apm: 0,
                        },
                    ))
                } else {
                    None
                }
            })
            .collect::<HashMap<_, _>>();

        self.stall_durations.sort_unstable();
        let stall_median = self
            .stall_durations
            .get(self.stall_durations.len() / 2)
            .map_or(0, |d| d.as_millis());
        let (stall_min, stall_max) = if self.stall_count > 0 {
            (self.stall_min.as_millis(), self.stall_max.as_millis())
        } else {
            (0, 0)
        };

        let message = Arc::new(GameResults {
            results,
            // Assuming fastest speed
            time_ms: game_results.time_ms,
            network_stalls: NetworkStallInfo {
                count: self.stall_count as u32,
                median: stall_median as u32,
                min: stall_min as u32,
                max: stall_max as u32,
            },
        });
        for send in self.waiting_for_result.drain(..) {
            let _ = send.send(message.clone());
        }
    }
}

unsafe fn create_lobby(info: &GameSetupInfo, game_type: GameType) -> Result<(), GameInitError> {
    let map_path = Path::new(&info.map_path);
    get_bw()
        .create_lobby(
            map_path,
            &info.map,
            &info.name,
            game_type,
            info.turn_rate.unwrap_or(0),
        )
        .map_err(GameInitError::Bw)
}

unsafe fn join_lobby(
    info: &GameSetupInfo,
    game_type: GameType,
) -> impl Future<Output = Result<(), GameInitError>> {
    let map_data = match info.map.map_data {
        Some(ref s) => s,
        None => return future::err(GameInitError::MissingMapInfo("map data")).boxed(),
    };
    let map_name = match info.map.name {
        Some(ref s) => s,
        None => return future::err(GameInitError::MissingMapInfo("name")).boxed(),
    };
    let max_player_count = info.slots.len() as u8;
    let active_player_count = info
        .slots
        .iter()
        .filter(|x| x.is_human() || x.is_observer())
        .count() as u8;
    let is_eud = map_data.is_eud;

    // This info isn't used ingame (with exception of game_type?),
    // but it is written in the header of replays/saves.
    let game_info = {
        let mut game_info = bw::BwGameData {
            index: 1,
            map_width: map_data.width,
            map_height: map_data.height,
            active_player_count,
            max_player_count,
            game_speed: 6, // Fastest
            game_type: game_type.primary as u16,
            game_subtype: game_type.subtype as u16,
            tileset: map_data.tileset,
            is_replay: 0,
            ..mem::zeroed()
        };
        for (out, val) in game_info.game_creator.iter_mut().zip(b"fakename".iter()) {
            *out = *val;
        }
        for (out, val) in game_info.name.iter_mut().zip(info.name.as_bytes().iter()) {
            *out = *val;
        }
        for (out, val) in game_info
            .map_name
            .iter_mut()
            .zip(map_name.as_bytes().iter())
        {
            *out = *val;
        }
        game_info
    };
    let map_path = match CString::new(info.map_path.as_bytes()) {
        Ok(o) => Arc::new(o),
        Err(_) => return future::err(GameInitError::NullInPath(info.map_path.clone())).boxed(),
    };
    let turn_rate = info.turn_rate.unwrap_or(0);
    async move {
        let mut repeat_interval = tokio::time::interval(Duration::from_millis(10));
        loop {
            repeat_interval.tick().await;
            match try_join_lobby_once(game_info, is_eud, turn_rate, &map_path).await {
                Ok(()) => break,
                Err(e) => debug!("Storm join error: {:08x}", e),
            }
        }
        let bw = get_bw();
        bw.init_game_network();
        bw.maybe_receive_turns();
        let storm_flags = bw.storm_player_flags();
        for (i, &flags) in storm_flags.iter().enumerate() {
            if flags != 0 {
                bw.init_network_player_info(i as u32);
            }
        }
        let player_names = storm_player_names(bw);
        debug!("Storm player names at join: {:?}", player_names);
        Ok(())
    }
    .boxed()
}

async unsafe fn try_join_lobby_once(
    mut game_info: bw::BwGameData,
    is_eud: bool,
    turn_rate: u32,
    map_path: &Arc<CString>,
) -> Result<(), u32> {
    // Storm sends game join packets and then waits for a response *synchronously* (waiting for up to
    // 5 seconds). Since we're on the async thread, and our network code is on the async thread, obviously
    // that won't work out well (although did it work out "well" in the normal network interface? Not
    // really. But I digress). Therefore, we queue this onto a background thread, which will let our
    // network code actually do its job.
    let (send, recv) = oneshot::channel();
    let map_path = map_path.clone();
    std::thread::spawn(move || {
        let address = Ipv4Addr::new(10, 27, 27, 0);
        snp::spoof_game("shieldbattery", address);
        let bw = get_bw();
        let result = bw.join_lobby(&mut game_info, is_eud, turn_rate, &map_path, address);
        let _ = send.send(result);
    });

    match recv.await {
        Ok(storm_result) => storm_result,
        // Thread died??
        Err(_) => Err(!0u32),
    }
}

unsafe fn setup_slots(slots: &[PlayerInfo], game_type: GameType, ums_forces: &[MapForce]) {
    let bw = get_bw();
    let is_ums = game_type.is_ums();
    let players = bw.players();
    for i in 0..12 {
        *players.add(i) = bw::Player {
            id: i as u32,
            storm_id: u32::MAX,
            player_type: match slots.len() < i {
                true => bw::PLAYER_TYPE_OPEN,
                false => bw::PLAYER_TYPE_NONE,
            },
            race: bw::RACE_RANDOM,
            team: 0,
            name: [0; 25],
        };
    }

    for i in 12..16 {
        *players.add(i) = bw::Player {
            id: 128 + (i - 12) as u32,
            storm_id: u32::MAX,
            player_type: bw::PLAYER_TYPE_HUMAN,
            race: bw::RACE_RANDOM,
            team: 0,
            name: [0; 25],
        };
    }

    let mut num_observers = 0;
    for (i, slot) in slots.iter().enumerate() {
        let slot_id = if is_ums {
            slot.player_id.unwrap_or(0) as usize
        } else if slot.is_observer() {
            num_observers += 1;
            if num_observers > 4 {
                panic!("Slots had more than 4 observers!");
            }

            11 + num_observers
        } else {
            i
        };

        // This player_type_id check is completely ridiculous and doesn't make sense, but that gives
        // the same behaviour as normal bw. Not that any maps use those slot types as Scmdraft
        // doesn't allow setting them anyways D:
        let team = if !is_ums || (slot.player_type_id != 1 && slot.player_type_id != 2) {
            slot.team_id
        } else {
            0
        };
        *players.add(slot_id) = bw::Player {
            id: if slot.is_observer() {
                128 + (slot_id - 12) as u32
            } else {
                slot_id as u32
            },
            storm_id: match slot.is_human() || slot.is_observer() {
                true => 27,
                false => u32::MAX,
            },
            race: slot.bw_race(),
            player_type: if is_ums && !slot.is_human() {
                // The type of UMS computers is set in the map file, and we have no reason to
                // worry about the various possibilities there are, so just pass the integer onwards.
                slot.player_type_id
            } else {
                slot.bw_player_type()
            },
            team,
            name: [0; 25],
        };
        bw.set_player_name(slot_id as u8, &slot.name);
    }
    if game_type.is_ums() {
        // BW would normally set UMS user selectable slots in replay header around the
        // same part where it initializes lobby player data. As this function is pretty
        // much replacement for that code, we'll have to set this replay header value here.
        let replay_header = bw.replay_header();
        for player in ums_forces.iter().flat_map(|x| x.players.iter()) {
            if let Some(value) = (*replay_header)
                .ums_user_select_slots
                .get_mut(player.id as usize)
            {
                *value = if player.race == UmsLobbyRace::Any {
                    1
                } else {
                    0
                };
            }
        }
    }
    // Verify that computer team races in team melee are either all random or no random.
    // Otherwise the race randomization function will generate invalid races.
    // This is also supposed to be prevented server-side, but verifying it also here is
    // very preferable to debugging a game that broke due to invalid races.
    if game_type.is_team_game() {
        let players = std::slice::from_raw_parts(players, 8);
        for i in 0..4 {
            let team = i + 1;
            if players.iter().any(|x| {
                x.team == team
                    && x.player_type == bw::PLAYER_TYPE_LOBBY_COMPUTER
                    && x.race == bw::RACE_RANDOM
            }) {
                if players
                    .iter()
                    .any(|x| x.team == team && x.race != bw::RACE_RANDOM)
                {
                    panic!("Computer team {} has both random and non-random slots, which is not allowed", i);
                }
            }
        }
    }
}

unsafe fn storm_player_names(bw: &dyn bw::Bw) -> Vec<Option<String>> {
    let storm_players = bw.storm_players();
    storm_players
        .iter()
        .map(|player| {
            let name_len = player
                .name
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(player.name.len());
            if name_len != 0 {
                Some(String::from_utf8_lossy(&player.name[..name_len]).into())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
}

async unsafe fn do_lobby_game_init(info: &GameSetupInfo) {
    let bw = get_bw();
    bw.do_lobby_game_init(info.seed);
    loop {
        bw.maybe_receive_turns();
        let done = bw.try_finish_lobby_game_init();
        if done {
            break;
        }
        tokio::time::sleep(Duration::from_millis(42)).await;
    }
}

pub async fn create_future(
    ws_send: app_socket::SendMessages,
    async_stop: SharedCanceler,
    mut messages: mpsc::Receiver<GameStateMessage>,
    init_main_thread: std::sync::mpsc::Sender<()>,
    send_main_thread_requests: std::sync::mpsc::Sender<GameThreadRequest>,
) {
    let (internal_send, mut internal_recv) = mpsc::channel(8);
    let (network_send, network_recv) = mpsc::channel(64);
    let (from_network_send, mut from_network_recv) = mpsc::channel(64);
    let mut game_state = GameState {
        init_state: InitState::WaitingForInput(IncompleteInit {
            settings_set: false,
            local_user: None,
            routes_set: false,
        }),
        network: NetworkManager::new(from_network_send, network_recv),
        network_send,
        ws_send,
        internal_send,
        init_main_thread,
        send_main_thread_requests,
        running_game: None,
        async_stop,
        can_start_game: AwaitableTaskState::Incomplete(Vec::new()),
        game_started: false,
    };
    loop {
        let message = select! {
            x = messages.recv() => x,
            x = internal_recv.recv() => x,
            x = from_network_recv.recv() => x.map(GameStateMessage::Network),
        };
        match message {
            Some(m) => game_state.handle_message(m).await,
            None => break,
        }
    }
    debug!("Game state task ended");
}

/// Sends a request to game thread and waits for it to finish
fn send_game_request(
    sender: &std::sync::mpsc::Sender<GameThreadRequest>,
    request_type: GameThreadRequestType,
) -> impl Future<Output = ()> {
    // (Error means that game thread closed)
    let result = start_game_request(sender, request_type);
    async move {
        if let Ok(wait_done) = result {
            let _ = wait_done.await;
        };
    }
}

/// Sends a request to game thread and only waits until it has been sent,
/// resolves to a receiver that can be used to wait for finish.
fn start_game_request(
    sender: &std::sync::mpsc::Sender<GameThreadRequest>,
    request_type: GameThreadRequestType,
) -> Result<oneshot::Receiver<()>, ()> {
    let (request, wait_done) = GameThreadRequest::new(request_type);

    sender.send(request).map_err(|_| ())?;
    Ok(wait_done)
}

async fn read_sbat_replay_data(path: &Path) -> Result<Option<replay::SbatReplayData>, io::Error> {
    use byteorder::{ByteOrder, LittleEndian};
    use tokio::fs;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut file = fs::File::open(path).await?;
    let mut buffer = [0u8; 0x14];
    file.read_exact(&mut buffer).await?;
    let magic = LittleEndian::read_u32(&buffer[0xc..]);
    let scr_extension_offset = LittleEndian::read_u32(&buffer[0x10..]);
    if magic != 0x53526573 {
        return Ok(None);
    }
    let end_pos = file.seek(io::SeekFrom::End(0)).await?;
    file.seek(io::SeekFrom::Start(scr_extension_offset as u64))
        .await?;
    let length = end_pos.saturating_sub(scr_extension_offset as u64) as usize;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer).await?;
    let mut pos = 0;
    while pos < length {
        let header = match buffer.get(pos..(pos + 8)) {
            Some(s) => s,
            None => break,
        };
        let id = LittleEndian::read_u32(header);
        let section_length = LittleEndian::read_u32(&header[4..]) as usize;
        if id == replay::SECTION_ID {
            let data = Some(())
                .and_then(|()| buffer.get(pos.checked_add(8)?..)?.get(..section_length))
                .and_then(replay::parse_shieldbattery_data);
            return match data {
                Some(o) => Ok(Some(o)),
                None => Err(io::Error::new(
                    io::ErrorKind::Other,
                    "Failed to parse shieldbattery section",
                )),
            };
        } else {
            pos = pos.saturating_add(section_length).saturating_add(8);
        }
    }
    Ok(None)
}
