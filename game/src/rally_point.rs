use std::collections::{
    hash_map::{Entry, HashMap},
    HashSet,
};

use std::io;
use std::net::{SocketAddr, SocketAddrV6};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use byteorder::{ReadBytesExt, WriteBytesExt, LE};
use bytes::Bytes;
use futures::future::Either;
use futures::pin_mut;
use futures::prelude::*;
use quick_error::quick_error;
use tokio::select;
use tokio::sync::{mpsc, oneshot};

use crate::cancel_token::{cancelable_channel, CancelToken, CancelableSender, Canceler};
use crate::udp::{self, UdpRecv, UdpSend};

quick_error! {
    #[derive(Debug)]
    pub enum RallyPointError {
        Bind(error: io::Error) {
            display("UDP binding failed: {}", error)
        }
        Send(error: io::Error, addr: SocketAddr) {
            display("Failed to send datagram to {}: {}", addr, error)
        }
        NotActive {
            display("Rally-point instance has closed")
        }
        JoinFailed {
            display("Joining route failed")
        }
        Timeout {
            display("Operation timed out")
        }
        RouteNotActive {
            display("Route is not active")
        }
    }
}

const PING_TIMEOUT: Duration = Duration::from_millis(2000);
const RESEND_TIMEOUT: Duration = Duration::from_millis(500);

const MSG_JOIN_ROUTE: u8 = 0x5;
const MSG_JOIN_ROUTE_SUCCESS: u8 = 0x6;
const MSG_JOIN_ROUTE_SUCCESS_ACK: u8 = 0x7;
const MSG_JOIN_ROUTE_FAILURE: u8 = 0x8;
const MSG_JOIN_ROUTE_FAILURE_ACK: u8 = 0x9;
const MSG_ROUTE_READY: u8 = 0xa;
const MSG_ROUTE_READY_ACK: u8 = 0xb;
const MSG_KEEP_ALIVE: u8 = 0xc;
const MSG_RECEIVE: u8 = 0xd;
const MSG_FORWARD: u8 = 0xe;
const MSG_PING: u8 = 0xf;

#[derive(Hash, Eq, PartialEq, Debug, Clone)]
struct RouteKey(SocketAddrV6, RouteId);

struct JoinState {
    done: oneshot::Sender<Result<(), RallyPointError>>,
    player_id: PlayerId,
}

struct ActiveRoute {
    player_id: PlayerId,
    ready: bool,
    waiting_for_ready: Vec<oneshot::Sender<Result<(), RallyPointError>>>,
    on_data: Vec<mpsc::Sender<Bytes>>,
}

// Keep internal addrs as IPv6 since UDP recvs come as IPv6 always.
// External api uses SocketAddr
struct State {
    joins: HashMap<RouteKey, JoinState>,
    active_routes: HashMap<RouteKey, ActiveRoute>,
    joined_servers: HashSet<SocketAddrV6>,
    send_requests: mpsc::Sender<Request>,
    send_bytes: mpsc::Sender<(
        Bytes,
        SocketAddrV6,
        Option<oneshot::Sender<RallyPointError>>,
    )>,
    pings: HashMap<(u32, SocketAddrV6), Ping>,
    #[allow(dead_code)]
    end_recv_task: Canceler,
}

struct Ping {
    start: Instant,
    done: oneshot::Sender<Duration>,
}

fn to_ipv6_addr(addr: &SocketAddr) -> SocketAddrV6 {
    match addr {
        SocketAddr::V6(v6) => *v6,
        SocketAddr::V4(v4) => SocketAddrV6::new(v4.ip().to_ipv6_mapped(), v4.port(), 0, 0),
    }
}

fn send_bytes_future(
    send_bytes: &mpsc::Sender<(
        Bytes,
        SocketAddrV6,
        Option<oneshot::Sender<RallyPointError>>,
    )>,
    message: Bytes,
    to: SocketAddrV6,
) -> impl Future<Output = ()> + 'static {
    let send = send_bytes.clone();
    async move {
        let _ = send.send((message, to, None)).await;
    }
}

static PING_ID: AtomicUsize = AtomicUsize::new(0);
fn ping_id() -> u32 {
    let id = PING_ID.fetch_add(1, Ordering::Relaxed);
    if id == 0 {
        let id: usize = rand::random();
        PING_ID.store(id.wrapping_add(1), Ordering::Relaxed);
        id as u32
    } else {
        id as u32
    }
}

impl State {
    fn external_request(&mut self, request: ExternalRequest) -> impl Future<Output = ()> {
        match request {
            ExternalRequest::JoinRoute(route, player, address, timeout, done) => {
                let message = join_route_message(&route, player);
                let key = route_key(&address, &route);
                let (send_done, recv_done) = oneshot::channel();
                let (send_error, mut recv_error) = mpsc::channel(1);
                self.joins.insert(
                    key.clone(),
                    JoinState {
                        done: send_done,
                        player_id: player,
                    },
                );
                self.joined_servers.insert(address);
                let send_self_requests = self.send_requests.clone();
                let recv_error = async move {
                    let opt_err = recv_error.recv().await;
                    opt_err.ok_or(())
                };
                let send_bytes = self.send_bytes.clone();
                let send_requests = async move {
                    let mut interval = resend_interval();
                    loop {
                        interval.tick().await;
                        let (send_this_error, recv_this_error) = oneshot::channel();
                        let send_error = send_error.clone();
                        let forward_error = async move {
                            if let Ok(error) = recv_this_error.await {
                                let _ = send_error.send(error).await;
                            }
                        };
                        tokio::spawn(forward_error);
                        let to_send = (message.clone(), address, Some(send_this_error));
                        if (send_bytes.send(to_send).await).is_err() {
                            break;
                        }
                    }
                };
                let task = async move {
                    // recv_done finishes => Ok
                    // recv_error finishes => Err
                    // neither finishes => Err(NotActive)
                    let inner_result = async move {
                        pin_mut!(recv_error);
                        let first = future::try_select(recv_done, recv_error).await;
                        match first {
                            Ok(Either::Left((result, _))) => result,
                            Ok(Either::Right((err, _))) => Err(err),
                            Err(Either::Left((_, other))) => other
                                .await
                                .map_err(|_| RallyPointError::NotActive)
                                .and_then(Err),
                            Err(Either::Right((_, other))) => other
                                .await
                                .map_err(|_| RallyPointError::NotActive)
                                .and_then(|x| x),
                        }
                    };
                    let result = async move {
                        let timeout_result = tokio::time::timeout(timeout, inner_result).await;
                        match timeout_result {
                            Ok(inner) => inner,
                            Err(_) => Err(RallyPointError::Timeout),
                        }
                    };
                    pin_mut!(result);
                    pin_mut!(send_requests);
                    future::select(done.send_result(result), send_requests).await;
                    let _ = send_self_requests.send(Request::CleanupJoin(key)).await;
                };
                tokio::spawn(task);
                future::ready(()).boxed()
            }
            ExternalRequest::Ping(address, done) => {
                let (send_done, recv_done) = oneshot::channel();
                let (send_error, recv_error) = oneshot::channel();
                let id = ping_id();
                let now = Instant::now();
                self.pings.insert(
                    (id, address),
                    Ping {
                        start: now,
                        done: send_done,
                    },
                );
                let message = ping_message(id);

                let send_bytes = self.send_bytes.clone();
                let send_requests = self.send_requests.clone();
                let send = async move {
                    let _ = send_bytes.send((message, address, Some(send_error))).await;
                };
                let task = async move {
                    // recv_done finishes => Ok
                    // recv_error finishes => Err
                    // neither finishes => Err(NotActive)
                    let inner_result = async move {
                        let first = future::try_select(recv_done, recv_error).await;
                        match first {
                            Ok(Either::Left((ok, _))) => Ok(ok),
                            Ok(Either::Right((err, _))) => Err(err),
                            Err(Either::Left((_, other))) => other
                                .await
                                .map_err(|_| RallyPointError::NotActive)
                                .and_then(Err),
                            Err(Either::Right((_, other))) => {
                                other.await.map_err(|_| RallyPointError::NotActive)
                            }
                        }
                    };
                    let result = async move {
                        let timeout_result = tokio::time::timeout(PING_TIMEOUT, inner_result).await;
                        match timeout_result {
                            Ok(inner) => inner,
                            Err(_) => Err(RallyPointError::Timeout),
                        }
                    };
                    pin_mut!(result);
                    done.send_result(result).await;
                    let _ = send_requests
                        .send(Request::CleanupPing((id, address)))
                        .await;
                };
                tokio::spawn(task);
                send.boxed()
            }
            ExternalRequest::Forward(route, player, data, address) => {
                let message = forward_message(&route, player, &data);
                let send_bytes = self.send_bytes.clone();
                let send = async move {
                    let _ = send_bytes.send((message, address, None)).await;
                };
                send.boxed()
            }
            ExternalRequest::WaitRouteReady(route, address, done) => {
                let key = route_key(&address, &route);
                if let Some(active_route) = self.active_routes.get_mut(&key) {
                    if active_route.ready {
                        let _ = done.send(Ok(()));
                    } else {
                        active_route.waiting_for_ready.push(done);
                    }
                } else {
                    let _ = done.send(Err(RallyPointError::RouteNotActive));
                }
                future::ready(()).boxed()
            }
            ExternalRequest::KeepAlive(route, player, address) => {
                // I don't think there's any way to confirm the route is actually still alive
                let message = keep_alive_message(&route, player);
                let send_bytes = self.send_bytes.clone();
                let send = async move {
                    let _ = send_bytes.send((message, address, None));
                };
                send.boxed()
            }
            ExternalRequest::ListenData(route, address, listen) => {
                let key = route_key(&address, &route);
                if let Some(active_route) = self.active_routes.get_mut(&key) {
                    active_route.on_data.push(listen);
                } else {
                    error!("Attempted to listen on route {:?} which is not active", key);
                }
                future::ready(()).boxed()
            }
        }
    }

    fn server_message(
        &mut self,
        message: ServerMessage,
        addr: SocketAddrV6,
    ) -> impl Future<Output = ()> {
        match message {
            ServerMessage::JoinRouteSuccess(route) => {
                let key = route_key(&addr, &route);
                let join_entry = self.joins.entry(key.clone());
                let player_id = match join_entry {
                    Entry::Occupied(ref entry) => entry.get().player_id,
                    Entry::Vacant(_) => match self.active_routes.get(&key) {
                        Some(s) => s.player_id,
                        None => {
                            // We'd like to ack this, but we don't have a player ID so tough luck
                            return future::ready(()).boxed();
                        }
                    },
                };
                let ack = join_route_success_ack(&route, player_id);
                let send_ack = send_bytes_future(&self.send_bytes, ack, addr);
                if let Entry::Occupied(entry) = join_entry {
                    let (_, join_state) = entry.remove_entry();
                    self.active_routes.insert(
                        key,
                        ActiveRoute {
                            player_id,
                            ready: false,
                            waiting_for_ready: Vec::new(),
                            on_data: Vec::new(),
                        },
                    );
                    let _ = join_state.done.send(Ok(()));
                }
                send_ack.boxed()
            }
            ServerMessage::JoinRouteFailure(route, failure_id) => {
                if !self.joined_servers.contains(&addr) {
                    return future::ready(()).boxed();
                }
                let key = route_key(&addr, &route);
                let ack = join_route_failure_ack(failure_id);
                let send_ack = send_bytes_future(&self.send_bytes, ack, addr);
                if let Some(join_state) = self.joins.remove(&key) {
                    let _ = join_state.done.send(Err(RallyPointError::JoinFailed));
                }
                send_ack.boxed()
            }
            ServerMessage::Ping(ping_id) => {
                if let Some(ping) = self.pings.remove(&(ping_id, addr)) {
                    let _ = ping.done.send(ping.start.elapsed());
                }
                future::ready(()).boxed()
            }
            ServerMessage::RouteReady(route_id) => {
                let key = route_key(&addr, &route_id);
                if let Some(route) = self.active_routes.get_mut(&key) {
                    route.ready = true;
                    for send in route.waiting_for_ready.drain(..) {
                        let _ = send.send(Ok(()));
                    }
                    let ack = route_ready_ack(&route_id, route.player_id);
                    let send_ack = send_bytes_future(&self.send_bytes, ack, addr);
                    send_ack.boxed()
                } else {
                    debug!(
                        "Route ready received for route {:?} which wasn't active",
                        key
                    );
                    future::ready(()).boxed()
                }
            }
            ServerMessage::Receive(route, bytes) => {
                let key = route_key(&addr, &route);
                if let Some(route) = self.active_routes.get_mut(&key) {
                    let mut send_futures = Vec::new();
                    // If any of the listeners have been dropped, clean them up here
                    let mut closed_indices = Vec::new();
                    for (i, send) in route.on_data.iter_mut().enumerate() {
                        match send.try_send(bytes.clone()) {
                            Ok(()) => (),
                            Err(err) => match err {
                                mpsc::error::TrySendError::Closed(..) => {
                                    closed_indices.push(i);
                                }
                                mpsc::error::TrySendError::Full(bytes) => {
                                    let send = send.clone();
                                    let future = async move {
                                        let _ = send.send(bytes).await;
                                    };
                                    send_futures.push(future);
                                }
                            },
                        }
                    }
                    for &i in closed_indices.iter().rev() {
                        debug!("Removing listener {}", i);
                        route.on_data.swap_remove(i);
                    }
                    future::join_all(send_futures).map(|_| ()).boxed()
                } else {
                    debug!("Data received for route {:?} which wasn't active", key);
                    future::ready(()).boxed()
                }
            }
        }
    }

    fn new(
        addr: &SocketAddr,
        send_requests: mpsc::Sender<Request>,
    ) -> Result<State, RallyPointError> {
        let (udp_send, udp_recv) = match udp::udp_socket(addr) {
            Ok(o) => o,
            Err(e) => return Err(RallyPointError::Bind(e)),
        };
        let (send_bytes, recv_bytes) = mpsc::channel(16);
        // Send task closes from send_bytes dropping, but recv task will not notice
        // recv_requests dropping if it doesn't receive anyhing, so use an explicit canceler.
        let (cancel_token, end_recv_task) = CancelToken::new();
        let send_task = udp_send_task(udp_send, recv_bytes);
        let recv_task = udp_recv_task(udp_recv, send_requests.clone());
        tokio::spawn(send_task);
        tokio::spawn(async move {
            pin_mut!(recv_task);
            cancel_token.bind(recv_task).await
        });
        Ok(State {
            joins: HashMap::default(),
            active_routes: HashMap::default(),
            joined_servers: HashSet::default(),
            send_requests,
            send_bytes,
            pings: HashMap::default(),
            end_recv_task,
        })
    }
}

async fn udp_send_task(
    mut udp_send: UdpSend,
    mut recv_bytes: mpsc::Receiver<(
        Bytes,
        SocketAddrV6,
        Option<oneshot::Sender<RallyPointError>>,
    )>,
) {
    // TODO UdpSend should take report_error as an argument when sending so this
    // wouldn't have to flush after each send
    while let Some((bytes, addr, report_error)) = recv_bytes.recv().await {
        match udp_send.send((bytes, addr.into())).await {
            Ok(()) => (),
            Err(e) => {
                error!("UDP send error: {}", e);
                if let Some(report) = report_error {
                    let _ = report.send(RallyPointError::Send(e, addr.into()));
                }
            }
        }
    }
}

async fn udp_recv_task(mut udp_recv: UdpRecv, send_requests: mpsc::Sender<Request>) {
    while let Some(result) = udp_recv.next().await {
        let (bytes, addr) = match result {
            Ok(o) => o,
            Err(e) => {
                error!("UDP recv error: {}", e);
                // TODO(tec27): Might be some errors worth quitting over? At least some of these are
                // definitely things we can continue with though (e.g. packet too large for buffer)
                continue;
            }
        };
        if let Some(msg) = decode_message(&bytes) {
            let _ = send_requests.send(Request::ServerMessage(msg, addr)).await;
        }
    }
}

fn resend_interval() -> tokio::time::Interval {
    tokio::time::interval(RESEND_TIMEOUT)
}

pub fn init() -> RallyPoint {
    // Rally-point uses 2 tasks.
    // The main task receives requests from recv/send tasks and outer world,
    // while recv/send task just communicate their results to the main task.
    // Though additionally, in order to report send errors to whichever future caused the send,
    // send requests take an optional mpsc::Sender that can should link back to the relevant
    // future. Acks sent to server can/should have it as None.
    let args = crate::parse_args();
    let addr = format!("[::]:{}", args.rally_point_port).parse().unwrap();
    debug!("Binding rally-point to {}", addr);

    let (send_requests, mut recv_requests) = mpsc::channel(16);
    // Separate channel for internal communication, so that dropping RallyPoint
    // will cause main_future to stop.
    let (internal_send_requests, mut internal_recv_requests) = mpsc::channel(16);
    let mut state = State::new(&addr, internal_send_requests).expect("Couldn't bind rally-point");
    let main_future = async move {
        loop {
            let request = select! {
                x = recv_requests.recv() => x,
                x = internal_recv_requests.recv() => x,
            };
            let request = match request {
                Some(s) => s,
                None => break,
            };
            match request {
                Request::External(req) => state.external_request(req).await,
                Request::ServerMessage(msg, from) => state.server_message(msg, from).await,
                Request::CleanupJoin(key) => {
                    state.joins.remove(&key);
                }
                Request::CleanupPing(key) => {
                    state.pings.remove(&key);
                }
            };
        }
        debug!("Rally-point task ended");
    };
    tokio::spawn(main_future);
    RallyPoint { send_requests }
}

/// Messages sent from server to players
#[derive(Debug)]
enum ServerMessage {
    JoinRouteSuccess(RouteId),
    JoinRouteFailure(RouteId, FailureId),
    RouteReady(RouteId),
    Receive(RouteId, Bytes),
    Ping(u32),
}

type ResponseSender<T> = CancelableSender<Result<T, RallyPointError>>;

enum ExternalRequest {
    JoinRoute(
        RouteId,
        PlayerId,
        SocketAddrV6,
        Duration,
        ResponseSender<()>,
    ),
    Ping(SocketAddrV6, ResponseSender<Duration>),
    WaitRouteReady(
        RouteId,
        SocketAddrV6,
        oneshot::Sender<Result<(), RallyPointError>>,
    ),
    KeepAlive(RouteId, PlayerId, SocketAddrV6),
    ListenData(RouteId, SocketAddrV6, mpsc::Sender<Bytes>),
    Forward(RouteId, PlayerId, Bytes, SocketAddrV6),
}

enum Request {
    External(ExternalRequest),
    ServerMessage(ServerMessage, SocketAddrV6),
    CleanupJoin(RouteKey),
    CleanupPing((u32, SocketAddrV6)),
}

#[derive(Clone)]
pub struct RallyPoint {
    send_requests: mpsc::Sender<Request>,
}

#[derive(Copy, Clone, Debug, Hash, Eq, PartialEq)]
pub struct RouteId(u64);
#[derive(Copy, Clone, Debug)]
pub struct FailureId(u64);
#[derive(Copy, Clone, Debug)]
pub struct PlayerId(u32);

impl RouteId {
    pub fn from_string(val: &str) -> RouteId {
        RouteId(val.as_bytes().read_u64::<LE>().unwrap_or(0))
    }
}

impl PlayerId {
    pub fn from_u32(val: u32) -> PlayerId {
        PlayerId(val)
    }
}

impl RallyPoint {
    pub fn join_route(
        &self,
        address: SocketAddr,
        route_id: RouteId,
        player_id: PlayerId,
        timeout: Duration,
    ) -> impl Future<Output = Result<(), RallyPointError>> {
        let (send, recv) = cancelable_channel();

        let address = to_ipv6_addr(&address);
        let request = ExternalRequest::JoinRoute(route_id, player_id, address, timeout, send);
        let sender = self.send_requests.clone();
        async move {
            sender
                .send(Request::External(request))
                .await
                .map_err(|_| RallyPointError::NotActive)?;
            recv.await.map_err(|_| RallyPointError::NotActive)?
        }
    }

    pub fn ping_server(
        &self,
        address: SocketAddr,
    ) -> impl Future<Output = Result<Duration, RallyPointError>> {
        let (send, recv) = cancelable_channel();

        let address = to_ipv6_addr(&address);
        let request = ExternalRequest::Ping(address, send);
        let sender = self.send_requests.clone();
        async move {
            sender
                .send(Request::External(request))
                .await
                .map_err(|_| RallyPointError::NotActive)?;
            recv.await.map_err(|_| RallyPointError::NotActive)?
        }
    }

    pub fn wait_route_ready(
        &self,
        route: &RouteId,
        address: &SocketAddr,
    ) -> impl Future<Output = Result<(), RallyPointError>> {
        let (send, recv) = oneshot::channel();
        let address = to_ipv6_addr(address);
        let request = ExternalRequest::WaitRouteReady(*route, address, send);
        let sender = self.send_requests.clone();
        async move {
            sender
                .send(Request::External(request))
                .await
                .map_err(|_| RallyPointError::NotActive)?;
            recv.await.map_err(|_| RallyPointError::NotActive)?
        }
    }

    pub fn keep_alive(
        &self,
        route: &RouteId,
        player_id: PlayerId,
        address: &SocketAddr,
    ) -> impl Future<Output = Result<(), RallyPointError>> {
        let address = to_ipv6_addr(address);
        let request = ExternalRequest::KeepAlive(*route, player_id, address);
        let sender = self.send_requests.clone();
        async move {
            sender
                .send(Request::External(request))
                .await
                .map_err(|_| RallyPointError::NotActive)?;
            Ok(())
        }
    }

    pub fn listen_route_data(
        &self,
        route: &RouteId,
        address: &SocketAddr,
    ) -> impl Stream<Item = Result<Bytes, RallyPointError>> {
        let address = to_ipv6_addr(address);
        let (send, recv) = mpsc::channel(32);
        let request = ExternalRequest::ListenData(*route, address, send);
        let sender = self.send_requests.clone();
        let sent = async move {
            sender
                .send(Request::External(request))
                .await
                .map_err(|_| RallyPointError::NotActive)?;
            Ok(())
        };
        sent.into_stream()
            .try_filter_map(|_| future::ready(Ok(None)))
            .chain(tokio_stream::wrappers::ReceiverStream::new(recv).map(Ok))
    }

    pub fn forward(
        &self,
        route: &RouteId,
        player: PlayerId,
        data: Bytes,
        address: &SocketAddr,
    ) -> impl Future<Output = Result<(), RallyPointError>> {
        let address = to_ipv6_addr(address);
        let request = ExternalRequest::Forward(*route, player, data, address);
        let sender = self.send_requests.clone();
        async move {
            sender
                .send(Request::External(request))
                .await
                .map_err(|_| RallyPointError::NotActive)?;
            Ok(())
        }
    }
}

fn route_key(address: &SocketAddrV6, route_id: &RouteId) -> RouteKey {
    RouteKey(*address, *route_id)
}

fn decode_message(bytes: &Bytes) -> Option<ServerMessage> {
    let mut read: &[u8] = bytes;
    let message = match read.read_u8().ok()? {
        MSG_JOIN_ROUTE_SUCCESS => {
            let route = RouteId(read.read_u64::<LE>().ok()?);
            ServerMessage::JoinRouteSuccess(route)
        }
        MSG_JOIN_ROUTE_FAILURE => {
            let route = RouteId(read.read_u64::<LE>().ok()?);
            let failure = FailureId(read.read_u64::<LE>().ok()?);
            ServerMessage::JoinRouteFailure(route, failure)
        }
        MSG_ROUTE_READY => {
            let route = RouteId(read.read_u64::<LE>().ok()?);
            ServerMessage::RouteReady(route)
        }
        MSG_RECEIVE => {
            let route = RouteId(read.read_u64::<LE>().ok()?);
            let data = bytes.slice((bytes.len() - read.len())..);
            // Length validation below doesn't work here since `data` is not read from `read`.
            return Some(ServerMessage::Receive(route, data));
        }
        MSG_PING => {
            let id = read.read_u32::<LE>().ok()?;
            ServerMessage::Ping(id)
        }
        // Should this be handled?
        MSG_KEEP_ALIVE => return None,
        _ => {
            warn!("Received an unknown rally-point message: {:x?}", bytes);
            return None;
        }
    };
    if read.is_empty() {
        Some(message)
    } else {
        warn!(
            "Rally-point message {:?} contained additional data, ignoring",
            message
        );
        None
    }
}

fn join_route_message(route_id: &RouteId, player_id: PlayerId) -> Bytes {
    let mut data = Vec::with_capacity(16);
    data.push(MSG_JOIN_ROUTE);
    data.write_u64::<LE>(route_id.0).unwrap();
    data.write_u32::<LE>(player_id.0).unwrap();
    data.into()
}

fn join_route_success_ack(route_id: &RouteId, player_id: PlayerId) -> Bytes {
    let mut data = Vec::with_capacity(13);
    data.push(MSG_JOIN_ROUTE_SUCCESS_ACK);
    data.write_u64::<LE>(route_id.0).unwrap();
    data.write_u32::<LE>(player_id.0).unwrap();
    data.into()
}

fn join_route_failure_ack(failure_id: FailureId) -> Bytes {
    let mut data = Vec::with_capacity(9);
    data.push(MSG_JOIN_ROUTE_FAILURE_ACK);
    data.write_u64::<LE>(failure_id.0).unwrap();
    data.into()
}

fn route_ready_ack(route_id: &RouteId, player_id: PlayerId) -> Bytes {
    let mut data = Vec::with_capacity(13);
    data.push(MSG_ROUTE_READY_ACK);
    data.write_u64::<LE>(route_id.0).unwrap();
    data.write_u32::<LE>(player_id.0).unwrap();
    data.into()
}

fn keep_alive_message(route_id: &RouteId, player_id: PlayerId) -> Bytes {
    let mut data = Vec::with_capacity(13);
    data.push(MSG_KEEP_ALIVE);
    data.write_u64::<LE>(route_id.0).unwrap();
    data.write_u32::<LE>(player_id.0).unwrap();
    data.into()
}

fn forward_message(route_id: &RouteId, player_id: PlayerId, bytes: &[u8]) -> Bytes {
    let mut data = Vec::with_capacity(13 + bytes.len());
    data.push(MSG_FORWARD);
    data.write_u64::<LE>(route_id.0).unwrap();
    data.write_u32::<LE>(player_id.0).unwrap();
    data.extend(bytes.iter().cloned());
    data.into()
}

fn ping_message(id: u32) -> Bytes {
    let mut data = Vec::with_capacity(5);
    data.push(MSG_PING);
    data.write_u32::<LE>(id).unwrap();
    data.into()
}
