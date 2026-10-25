//! Guests of the public listener (`--public-origin`, DEPLOY items 1 to 3,
//! 30 and 31): every visitor of the hosted simulator page is one, without
//! pairing. A guest is a `NetworkBrowser` whose client id starts with
//! `clguest`; it has no client record, is granted exactly `read` and
//! `control` on `initialize`, never escalates, and may ask only for what
//! `GUEST_METHODS` lists. Its control reaches only simulated vehicles no
//! other guest flies.

use uxduck_contracts::dto::state::{EntityType, StateSubscribeParams};
use uxduck_contracts::errors::{ApiError, ErrorKind};
use uxduck_contracts::rpc::ClientRequest;
use uxduck_core::domain::client::{Capability, NetworkAccess};
use uxduck_core::policy::admission::Trust;

use crate::pairing::{self, Session};
use crate::{ConnectionId, Engine, NO_CONNECTION};

/// What a guest may ask for, by method. The rule: what the 3D page sends
/// in Fly and Cockpit modes (found in the interface bundle's calls) that
/// either only reads the vehicles and the map, or commands a simulated
/// vehicle, which `guest_gate` then limits to one this guest flies.
/// Nothing that reads the host (logs, files, storage, sockets, router
/// events, `daemon/about`'s paths), nothing that starts or stops a
/// simulator, nothing of plugins, the account, feedback, analytics,
/// location, finding vehicles, or other visitors' pages
/// (`client/display*`). Methods that need more than `read` and `control`
/// stay refused by their handlers even when listed; `controller/claim`,
/// `controller/release` and `controller/setTarget` are operator-only there,
/// and `lease/*` is for the relay alone.
pub const GUEST_METHODS: &[&str] = &[
    "initialize",
    "state/subscribe",
    "layout/open",
    "interface/status",
    "vehicle/list",
    "vehicle/get",
    "vehicle/messages",
    "telemetry/subscribe",
    "telemetry/get",
    "telemetry/window",
    "terrain/at",
    "terrain/status",
    "lease/take",
    "lease/release",
    "controller/claim",
    "controller/release",
    "controller/keyboardStart",
    "controller/keyboardInput",
    "controller/keyboardStop",
    "controller/setTarget",
    "controller/inputs",
    "command/send",
    "command/list",
    "command/modes",
    "mission/refresh",
    "mission/upload",
    "plan/list",
    "plan/get",
    "plan/check",
    "plan/examples",
    "param/get",
    "param/list",
    "param/search",
    "place/search",
    "place/locate",
    // Only for a vehicle this guest flies (item 31).
    "sim/pause",
];

/// What a guest's `state/subscribe` may include: the vehicles and what the
/// map and Fly mode show of them. Not operators, chats, notifications,
/// client records, approvals, settings (host paths), plugins, history,
/// video or file transfers; asked for, they are left out of its answer.
const GUEST_ENTITIES: &[EntityType] = &[
    EntityType::Vehicle,
    EntityType::Link,
    EntityType::Receipt,
    EntityType::ParameterSet,
    EntityType::Parameter,
    EntityType::Mission,
    EntityType::Controller,
    EntityType::InputMapping,
    EntityType::Place,
    EntityType::Plan,
    EntityType::ParamDefinitions,
    EntityType::PracticeAttempt,
];

fn refused(why: &str) -> ApiError {
    ApiError::new(ErrorKind::CapabilityDenied, why.to_owned())
}

impl Engine {
    /// A new guest of the public listener at `origin`, from `peer`. None
    /// when the simulator is full.
    pub fn mint_guest(&mut self, origin: &str, peer: &str) -> Option<String> {
        self.sessions
            .mint_guest(origin, peer, self.clock.as_ref(), self.random.as_mut())
    }

    /// A guest's session by its token, counted as seen; never a paired one.
    pub fn guest(&mut self, token: &str) -> Option<Session> {
        self.sessions.guest(token, self.clock.as_ref())
    }

    /// Guests here now.
    #[must_use]
    pub fn guest_count(&self) -> usize {
        self.sessions.guest_count()
    }

    /// Ends guests idle too long or past their maximum age, with their
    /// open pages, as forgetting a phone does (S97). Called at 1 Hz.
    pub fn expire_guests(&mut self) {
        let connected: std::collections::BTreeSet<String> = self
            .connections
            .keys()
            .filter_map(|id| self.guest_client_of(*id).map(str::to_owned))
            .collect();
        let gone = self
            .sessions
            .expire_guests(self.clock.as_ref(), |client| connected.contains(client));
        if gone.is_empty() {
            return;
        }
        let open: Vec<ConnectionId> = self
            .connections
            .keys()
            .copied()
            .filter(|id| {
                self.guest_client_of(*id)
                    .is_some_and(|client| gone.iter().any(|g| g == client))
            })
            .collect();
        // Dropping its outbox ends the socket (`serve_websocket`).
        for connection in open {
            self.disconnect(connection);
        }
        self.guest_vehicles
            .retain(|_, guest| !gone.iter().any(|g| g == guest));
    }

    /// The guest client a connection belongs to, if it is a guest's.
    pub(crate) fn guest_client_of(&self, connection: ConnectionId) -> Option<&str> {
        match &self.connections.get(&connection)?.trust {
            Trust::NetworkBrowser { client, .. } if pairing::is_guest_client(client) => {
                Some(client.as_str())
            }
            _ => None,
        }
    }

    /// Whether a connection is a guest's.
    pub(crate) fn is_guest(&self, connection: ConnectionId) -> bool {
        self.guest_client_of(connection).is_some()
    }

    /// What a guest is granted on `initialize`: watching and flying,
    /// without a client record. None once it has expired. Its page is
    /// connected now, so it no longer ends as an unused guest does.
    pub(crate) fn admit_guest(&mut self, client: &str) -> Option<Vec<Capability>> {
        self.sessions
            .guest_connected(client, self.clock.as_ref())
            .then(|| NetworkAccess::Fly.capabilities())
    }

    /// A guest's connection closed: with its last one, the vehicles it
    /// flew are free for other guests.
    pub(crate) fn guest_left(&mut self, client: &str) {
        let still_open = self
            .connections
            .keys()
            .any(|id| self.guest_client_of(*id) == Some(client));
        if !still_open {
            self.guest_vehicles.retain(|_, guest| guest != client);
        }
    }

    /// The vehicle a guest's request controls, as a vehicle id, for the
    /// requests that command one.
    fn guest_target(&self, request: &ClientRequest) -> Option<Result<String, ApiError>> {
        let id = match request {
            ClientRequest::CommandSend(params) => params.vehicle_id.clone(),
            ClientRequest::MissionUpload(params) => params.vehicle_id.clone(),
            ClientRequest::KeyboardStart(params) => params.vehicle_id.clone(),
            ClientRequest::SimPause(params) => {
                let on_link = self
                    .state
                    .vehicles
                    .values()
                    .find(|vehicle| vehicle.link_id == params.id)
                    .map(|vehicle| vehicle.id.clone());
                return Some(on_link.ok_or_else(|| refused("no simulated vehicle on that link")));
            }
            _ => return None,
        };
        Some(
            self.vehicle(&id)
                .map(|vehicle| vehicle.id.clone())
                .ok_or_else(|| ApiError::new(ErrorKind::NotFound, format!("no vehicle {id}"))),
        )
    }

    /// The guest gate (DEPLOY item 3), before any handler: refuses what
    /// `GUEST_METHODS` does not list, trims `state/subscribe` to
    /// `GUEST_ENTITIES`, and lets a guest command only a simulated vehicle
    /// that no other guest flies, which it then flies (item 31).
    pub(crate) fn guest_gate(
        &mut self,
        connection: ConnectionId,
        request: ClientRequest,
    ) -> Result<ClientRequest, ApiError> {
        let Some(client) = self.guest_client_of(connection).map(str::to_owned) else {
            return Ok(request);
        };
        let method = crate::approvals::method_of(&request);
        if !GUEST_METHODS.contains(&method.as_str()) {
            return Err(refused("Visitors to this simulator can't do that."));
        }
        match request {
            ClientRequest::StateSubscribe(StateSubscribeParams { mut entities }) => {
                entities.retain(|entity| GUEST_ENTITIES.contains(entity));
                return Ok(ClientRequest::StateSubscribe(StateSubscribeParams {
                    entities,
                }));
            }
            // Opening a tab in an operator's layout writes it.
            ClientRequest::LayoutOpen(ref params)
                if params.operator_id.is_some() || params.thread_id.is_some() =>
            {
                return Err(refused("Visitors to this simulator can't do that."));
            }
            _ => {}
        }
        if let Some(target) = self.guest_target(&request) {
            let vehicle_id = target?;
            let simulated = self
                .vehicle(&vehicle_id)
                .is_some_and(|vehicle| self.is_simulated(vehicle));
            if !simulated {
                return Err(refused("Visitors may fly only simulated vehicles."));
            }
            match self.guest_vehicles.get(&vehicle_id) {
                Some(flier) if *flier != client => {
                    return Err(ApiError::new(
                        ErrorKind::Busy,
                        "Another visitor is flying this vehicle.",
                    ));
                }
                Some(_) => {}
                None => {
                    self.guest_vehicles.insert(vehicle_id, client);
                }
            }
        }
        Ok(request)
    }

    /// Stops simulated vehicles older than `max_age_us` (DEPLOY item 30,
    /// `--sim-max-age`, public mode only): a backstop for the configurator's
    /// own reaper. Returns the links stopped.
    pub fn stop_old_simulations(&mut self, max_age_us: u64) -> Vec<String> {
        let now = self.clock.now_us();
        let old: Vec<String> = self
            .state
            .links
            .values()
            .filter(|link| link.kind.is_simulator())
            .filter(|link| now.saturating_sub(link.created_at_us) > max_age_us)
            .map(|link| link.id.clone())
            .collect();
        for id in &old {
            // Its forward may have gone with an earlier one.
            if !self.state.links.contains_key(id) {
                continue;
            }
            self.give_up_practice_on(id, NO_CONNECTION);
            // Only a missing link fails, and that was checked.
            let _ = crate::rpc::vehicles::remove_link(self, NO_CONNECTION, id);
        }
        old
    }
}

#[cfg(test)]
mod tests {
    use futures::channel::mpsc::{UnboundedReceiver, unbounded};
    use serde_json::{Value, json};
    use uxduck_contracts::dto::trace::Transport;

    use super::*;
    use crate::runtime::{
        Clock, Forget, MemoryCredentials, NoAgent, NoLinks, NoPlugins, NoSystem, Ports, Random,
    };

    const NOW_US: u64 = 1_800_000_000_000_000;
    const HOUR_US: u64 = 60 * 60 * 1_000_000;
    const ORIGIN: &str = "https://sim.example.com";

    struct At;
    impl Clock for At {
        fn now_us(&self) -> u64 {
            NOW_US
        }
    }

    struct Counting(u64);
    impl Random for Counting {
        fn fill(&mut self, bytes: &mut [u8]) {
            self.0 += 1;
            for (i, byte) in bytes.iter_mut().enumerate() {
                *byte = self.0.to_le_bytes()[i % 8] ^ u8::try_from(i % 251).unwrap_or(0);
            }
        }
    }

    /// An engine with simulator links `(id, created_at_us)`, each with
    /// vehicle `v-<id>`, and one old link that is not a simulator.
    fn engine(simulations: &[(&str, u64)]) -> Engine {
        let mut engine = Engine::new(
            crate::EngineConfig {
                daemon_version: "0.6.0".into(),
                capabilities: uxduck_contracts::dto::initialize::DaemonCapabilities::default(),
                ui_url: "http://127.0.0.1:45000/".into(),
                checkpoint_every: 1000,
                models: vec![],
                agent_provider: "fake".into(),
                about: crate::HostAbout::default(),
            },
            Box::new(At),
            Box::new(Counting(0)),
            Ports {
                persistence: Box::new(Forget),
                agent: Box::new(NoAgent),
                credentials: Box::new(MemoryCredentials::default()),
                links: Box::new(NoLinks),
                system: Box::new(NoSystem::default()),
                plugins: Box::new(NoPlugins),
            },
            crate::Loaded::default(),
        );
        let link = |id: &str, kind: Value, created_at_us: u64| -> uxduck_core::domain::link::Link {
            serde_json::from_value(json!({
                "id": id, "name": id, "kind": kind,
                "policy": "read-write", "topology": "auto", "status": "up",
                "createdAtUs": created_at_us, "version": 1
            }))
            .unwrap()
        };
        for (id, created_at_us) in simulations {
            let kind = json!({
                "type": "simulator", "vehicle": "multicopter",
                "latitudeDeg": 37.0, "longitudeDeg": -122.0, "altitudeM": 0.0, "headingDeg": 0.0
            });
            engine
                .state
                .links
                .insert((*id).to_owned(), link(id, kind, *created_at_us));
            let vehicle: uxduck_core::domain::vehicle::Vehicle = serde_json::from_value(json!({
                "id": format!("v-{id}"), "name": id, "linkId": id, "peer": "sitl",
                "systemId": 1, "componentIds": [1], "autopilot": "ardupilotmega",
                "vehicleType": "quadrotor", "presence": "online", "lastHeartbeatUs": NOW_US,
                "saved": false, "dismissed": false, "version": 1
            }))
            .unwrap();
            engine.state.vehicles.insert(vehicle.id.clone(), vehicle);
        }
        let tcp = json!({ "type": "tcp-client", "host": "127.0.0.1", "port": 5760 });
        engine.state.links.insert("tcp".into(), link("tcp", tcp, 1));
        engine
    }

    /// A guest's page: connected through the public listener, initialized.
    fn page(engine: &mut Engine, token: &str) -> (ConnectionId, UnboundedReceiver<String>) {
        let (outbox, replies) = unbounded();
        let connection = engine.connect(
            Transport::WebSocket,
            Trust::NetworkBrowser {
                origin: ORIGIN.into(),
                client: pairing::guest_client(token),
            },
            outbox,
        );
        let mut page = (connection, replies);
        let granted = ask(
            engine,
            &mut page,
            1,
            "initialize",
            json!({
                "clientInfo": { "name": "visitor", "kind": "operator-ui", "version": "0.6.0" },
                "capabilities": { "protocolVersion": uxduck_contracts::version::PROTOCOL_VERSION }
            }),
        );
        assert_eq!(
            granted["result"]["granted"],
            json!(["read", "control"]),
            "{granted}"
        );
        page
    }

    /// The reply to a request; null while it waits on the vehicle, as a
    /// command does with no link behind it. The gate answers at once.
    #[allow(clippy::needless_pass_by_value, reason = "json! literals at the call")]
    fn ask(
        engine: &mut Engine,
        (connection, replies): &mut (ConnectionId, UnboundedReceiver<String>),
        id: u64,
        method: &str,
        params: Value,
    ) -> Value {
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        engine.receive(*connection, &message.to_string());
        loop {
            let Ok(text) = replies.try_recv() else {
                return Value::Null;
            };
            let reply: Value = serde_json::from_str(&text).unwrap();
            if reply["id"] == id {
                return reply;
            }
        }
    }

    const BUSY: i64 = -32007;

    #[test]
    fn a_guest_cannot_fly_another_guests_vehicle_until_its_last_page_closes() {
        let mut engine = engine(&[("lk1", NOW_US)]);
        let first = engine.mint_guest(ORIGIN, "203.0.113.1").unwrap();
        let second = engine.mint_guest(ORIGIN, "203.0.113.2").unwrap();
        let mut flying = page(&mut engine, &first);
        let mut again = page(&mut engine, &first);
        let mut other = page(&mut engine, &second);
        let arm = json!({ "vehicleId": "v-lk1", "command": { "type": "arm" } });

        let taken = ask(&mut engine, &mut flying, 2, "command/send", arm.clone());
        assert_ne!(taken["error"]["code"], BUSY, "{taken}");
        let refused = ask(&mut engine, &mut other, 2, "command/send", arm.clone());
        assert_eq!(refused["error"]["code"], BUSY, "{refused}");
        let pause = json!({ "id": "lk1", "paused": true });
        let paused = ask(&mut engine, &mut other, 3, "sim/pause", pause);
        assert_eq!(paused["error"]["code"], BUSY, "{paused}");
        // The guest's other page flies it too.
        let same = ask(&mut engine, &mut again, 2, "command/send", arm.clone());
        assert_ne!(same["error"]["code"], BUSY, "{same}");
        // A real vehicle is never a guest's.
        let real = ask(
            &mut engine,
            &mut other,
            4,
            "command/send",
            json!({ "vehicleId": "nowhere", "command": { "type": "arm" } }),
        );
        assert!(real.get("error").is_some(), "{real}");

        // Closing one of its pages keeps the hold; closing the last frees it.
        engine.disconnect(again.0);
        let still = ask(&mut engine, &mut other, 5, "command/send", arm.clone());
        assert_eq!(still["error"]["code"], BUSY, "{still}");
        engine.disconnect(flying.0);
        let freed = ask(&mut engine, &mut other, 6, "command/send", arm.clone());
        assert_ne!(freed["error"]["code"], BUSY, "{freed}");
        // Now the second guest holds it.
        let third = engine.mint_guest(ORIGIN, "203.0.113.3").unwrap();
        let mut late = page(&mut engine, &third);
        let refused = ask(&mut engine, &mut late, 2, "command/send", arm);
        assert_eq!(refused["error"]["code"], BUSY, "{refused}");
    }

    #[test]
    fn old_simulations_alone_are_stopped() {
        let mut engine = engine(&[("old", NOW_US - 2 * HOUR_US), ("new", NOW_US - 1)]);
        assert_eq!(engine.stop_old_simulations(HOUR_US), ["old"]);
        let links: Vec<&String> = engine.state.links.keys().collect();
        assert_eq!(links, ["new", "tcp"]);
        let vehicles: Vec<&String> = engine.state.vehicles.keys().collect();
        assert_eq!(vehicles, ["v-new"]);
        assert!(engine.stop_old_simulations(24 * HOUR_US).is_empty());
    }
}
