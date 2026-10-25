//! Browser sessions: one-time bootstrap tokens, pairing requests answered by an
//! operator, and the sessions both of them produce (ADR-0001, Transports and
//! authentication). Sessions survive restarts through the `Persistence` port,
//! stored by the SHA-256 of their token; bootstrap tokens and pairing
//! requests are short-lived and stay in memory.
//!
//! Guests of the public listener (`--public-origin`, DEPLOY items 1 and 2)
//! are sessions nobody approved: minted on the page's first look, capped,
//! expiring, and never saved, so a restart forgets every visitor.

use std::collections::HashMap;

use sha2::{Digest, Sha256};
use uxduck_contracts::dto::pairing::PairingRequest;

use crate::commands::Raise;
use crate::runtime::{Clock, Persistence, Random};

use uxduck_core::domain::client::NetworkAccess;
use uxduck_core::domain::notification::{
    Action, NotificationAction, NotificationKind, Severity, Subject,
};

const BOOTSTRAP_TTL_US: u64 = 60 * 1_000_000;
const PAIRING_TTL_US: u64 = 10 * 60 * 1_000_000;
/// A browser polls every second while it waits; one silent this long has
/// gone (closed, reloaded), and its question with it.
const ABANDONED_US: u64 = 15 * 1_000_000;
/// Phones and tablets on the network waiting at once (S97): anyone there
/// can open the page, so they cannot pile questions on the operator.
const NETWORK_WAITING: usize = 4;
/// Guests at once on the public listener: each may fly, so each costs the
/// host telemetry fan-out and a socket; past this the page says it is full.
pub const MAX_GUESTS: usize = 100;
/// Guests from one address at once: a few tabs, not a room's worth.
pub const MAX_GUESTS_PER_PEER: usize = 3;
/// A guest with no page open this long has gone.
pub const GUEST_IDLE_US: u64 = 60 * 60 * 1_000_000;
/// No guest lasts longer than this, open page or not: it gets a new one.
pub const GUEST_MAX_US: u64 = 12 * 60 * 60 * 1_000_000;
/// A guest whose page never opened `/rpc` this long after it last asked
/// was not a page: minting guests without using them cannot hold the
/// listener full for `GUEST_IDLE_US`.
pub const GUEST_UNCONNECTED_US: u64 = 2 * 60 * 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub origin: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingState {
    Pending {
        code: String,
    },
    /// The browser collects its session once; the request is then removed.
    Approved {
        session: String,
        /// For a phone or tablet on the network (S97): what it was allowed.
        network: Option<NetworkPairing>,
    },
    Denied,
    /// Unknown or expired.
    Unknown,
}

/// A phone or tablet on the network that was allowed in (S97).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkPairing {
    pub access: NetworkAccess,
    /// What it is, from its browser: "iPhone", "Android phone".
    pub device: String,
    /// Its address on the network when it paired.
    pub peer: Option<String>,
}

/// The operator's answer: no, or yes with what a phone on the network may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    Deny,
    Allow(NetworkAccess),
}

#[derive(Debug)]
struct Pending {
    code: String,
    origin: String,
    user_agent: Option<String>,
    /// Its address, when it asks through the network listener (S97).
    peer: Option<String>,
    requested_at_us: u64,
    polled_at_us: u64,
    answer: Option<Answer>,
}

/// A question to show while a browser waits.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Question {
    pub origin: String,
    pub code: String,
    pub device: Option<String>,
    pub peer: Option<String>,
}

impl Pending {
    /// Tabs of one browser on one site are asked as one.
    fn same_browser(&self, other: &Self) -> bool {
        self.origin == other.origin && self.user_agent == other.user_agent
    }
}

/// The client record of a phone or tablet paired on the network (S97): one
/// per session, so each device keeps what it was allowed.
#[must_use]
pub fn network_client(token: &str) -> String {
    client_of_hash(&token_hash(token))
}

fn client_of_hash(hash: &str) -> String {
    format!("clnet{}", &hash[..16.min(hash.len())])
}

/// The client id of a guest of the public listener: never a record in
/// `state.clients`, only this name on its connections.
#[must_use]
pub fn guest_client(token: &str) -> String {
    guest_of_hash(&token_hash(token))
}

const GUEST_PREFIX: &str = "clguest";

fn guest_of_hash(hash: &str) -> String {
    format!("{GUEST_PREFIX}{}", &hash[..16.min(hash.len())])
}

/// Whether a client id is a guest's: what the RPC gate (DEPLOY item 3) keys on.
#[must_use]
pub fn is_guest_client(client: &str) -> bool {
    client.starts_with(GUEST_PREFIX)
}

/// A visitor of the public listener, by token hash: in memory only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guest {
    pub origin: String,
    pub created_us: u64,
    /// Its page last asked, or had a socket open (`expire_guests`).
    pub seen_us: u64,
    /// Its address, as the proxy saw it: what the per-address cap counts.
    pub peer: String,
    /// It has opened `/rpc` at least once.
    pub connected: bool,
}

/// Whether a session's origin is a page on the network listener (S97): an
/// IPv4 address that is not this computer's loopback.
#[must_use]
pub fn network_origin(origin: &str) -> bool {
    origin
        .strip_prefix("http://")
        .and_then(|host| host.rsplit_once(':').map(|(ip, _)| ip))
        .and_then(|ip| ip.parse::<std::net::Ipv4Addr>().ok())
        .is_some_and(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

/// What a device is, from its browser's user agent, in a few words.
#[must_use]
pub fn device_name(user_agent: Option<&str>) -> String {
    let agent = user_agent.unwrap_or_default();
    let name = if agent.contains("iPhone") {
        "iPhone"
    } else if agent.contains("iPad") {
        "iPad"
    } else if agent.contains("Android") && agent.contains("Mobile") {
        "Android phone"
    } else if agent.contains("Android") {
        "Android tablet"
    } else if agent.contains("Macintosh") {
        "Mac"
    } else if agent.contains("Windows") {
        "Windows computer"
    } else if agent.contains("Linux") {
        "Linux computer"
    } else {
        "A device"
    };
    name.to_owned()
}

/// Lowercase hex SHA-256 of a session token: what is stored and looked up.
#[must_use]
pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            use std::fmt::Write;
            let _ = write!(out, "{byte:02x}");
            out
        })
}

#[derive(Debug, Default)]
pub struct Sessions {
    bootstrap: HashMap<String, (String, u64)>,
    pairing: HashMap<String, Pending>,
    /// By token hash.
    active: HashMap<String, Session>,
    /// Guests of the public listener, by token hash. Never persisted, and
    /// never returned by `session()`: they count only on that listener.
    guests: HashMap<String, Guest>,
}

impl Sessions {
    /// Sessions saved before a restart, by token hash.
    #[must_use]
    pub fn restored(sessions: impl IntoIterator<Item = (String, Session)>) -> Self {
        Self {
            active: sessions.into_iter().collect(),
            ..Self::default()
        }
    }

    /// A token that `exchange_bootstrap` turns into a session once, within a minute.
    pub fn create_bootstrap(
        &mut self,
        origin: &str,
        clock: &dyn Clock,
        random: &mut dyn Random,
    ) -> String {
        let token = random.token();
        self.bootstrap
            .insert(token.clone(), (origin.to_owned(), clock.now_us()));
        token
    }

    pub fn exchange_bootstrap(
        &mut self,
        token: &str,
        clock: &dyn Clock,
        random: &mut dyn Random,
        store: &mut dyn Persistence,
    ) -> Option<String> {
        let (origin, created) = self.bootstrap.remove(token)?;
        if clock.now_us().saturating_sub(created) > BOOTSTRAP_TTL_US {
            return None;
        }
        Some(self.create_session(origin, random, store))
    }

    /// Starts a pairing request. Returns its id, which only the browser
    /// knows, and the code it shows. A phone or tablet on the network gives
    /// its `peer` address; none when too many of those wait already.
    pub fn request_pairing(
        &mut self,
        origin: &str,
        user_agent: Option<String>,
        peer: Option<String>,
        clock: &dyn Clock,
        random: &mut dyn Random,
    ) -> Option<(String, String)> {
        self.expire(clock);
        let waiting = self
            .pairing
            .values()
            .filter(|pending| pending.peer.is_some() && pending.answer.is_none())
            .count();
        if peer.is_some() && waiting >= NETWORK_WAITING {
            return None;
        }
        let code = loop {
            let code = random.code();
            if !self.pairing.values().any(|pending| pending.code == code) {
                break code;
            }
        };
        let id = random.token();
        self.pairing.insert(
            id.clone(),
            Pending {
                code: code.clone(),
                origin: origin.to_owned(),
                user_agent,
                peer,
                requested_at_us: clock.now_us(),
                polled_at_us: clock.now_us(),
                answer: None,
            },
        );
        Some((id, code))
    }

    pub fn poll_pairing(
        &mut self,
        id: &str,
        clock: &dyn Clock,
        random: &mut dyn Random,
        store: &mut dyn Persistence,
    ) -> PairingState {
        self.expire(clock);
        let Some(pending) = self.pairing.get_mut(id) else {
            return PairingState::Unknown;
        };
        pending.polled_at_us = clock.now_us();
        match pending.answer {
            None => PairingState::Pending {
                code: pending.code.clone(),
            },
            Some(Answer::Deny) => {
                self.pairing.remove(id);
                PairingState::Denied
            }
            Some(Answer::Allow(access)) => {
                let origin = pending.origin.clone();
                let network = pending.peer.as_ref().map(|peer| NetworkPairing {
                    access,
                    device: device_name(pending.user_agent.as_deref()),
                    peer: Some(peer.clone()),
                });
                self.pairing.remove(id);
                PairingState::Approved {
                    session: self.create_session(origin, random, store),
                    network,
                }
            }
        }
    }

    /// Records the operator's answer, for every tab of the same browser on
    /// the same site that waits too. False if no pending request shows `code`.
    /// `access` is what a phone or tablet on the network may do: watching
    /// unless said otherwise.
    pub fn answer_pairing(
        &mut self,
        code: &str,
        approve: bool,
        access: Option<NetworkAccess>,
        clock: &dyn Clock,
    ) -> bool {
        self.expire(clock);
        let Some(asked) = self
            .pairing
            .values()
            .find(|pending| pending.code == code && pending.answer.is_none())
            .map(|pending| (pending.origin.clone(), pending.user_agent.clone()))
        else {
            return false;
        };
        for pending in self.pairing.values_mut() {
            if pending.answer.is_none()
                && pending.origin == asked.0
                && pending.user_agent == asked.1
            {
                pending.answer = Some(if approve {
                    Answer::Allow(access.unwrap_or_default())
                } else {
                    Answer::Deny
                });
            }
        }
        true
    }

    /// The questions to show: one per browser and site still waiting, with
    /// the code of its newest tab, the one most likely in front of the
    /// person. Expired and abandoned requests are dropped first.
    pub(crate) fn questions(&mut self, clock: &dyn Clock) -> Vec<Question> {
        self.expire(clock);
        let waiting: Vec<&Pending> = self
            .pairing
            .values()
            .filter(|pending| pending.answer.is_none())
            .collect();
        let mut questions: Vec<Question> = waiting
            .iter()
            .filter(|pending| {
                !waiting.iter().any(|other| {
                    other.same_browser(pending)
                        && (other.requested_at_us, &other.code)
                            > (pending.requested_at_us, &pending.code)
                })
            })
            .map(|pending| Question {
                origin: pending.origin.clone(),
                code: pending.code.clone(),
                device: pending
                    .peer
                    .as_ref()
                    .map(|_| device_name(pending.user_agent.as_deref())),
                peer: pending.peer.clone(),
            })
            .collect();
        questions.sort();
        questions
    }

    pub fn pending_pairings(&mut self, clock: &dyn Clock) -> Vec<PairingRequest> {
        self.expire(clock);
        let mut requests: Vec<PairingRequest> = self
            .pairing
            .values()
            .filter(|pending| pending.answer.is_none())
            .map(|pending| PairingRequest {
                code: pending.code.clone(),
                origin: pending.origin.clone(),
                user_agent: pending.user_agent.clone(),
                network_peer: pending.peer.clone(),
                requested_at_us: pending.requested_at_us,
            })
            .collect();
        requests.sort_by_key(|request| request.requested_at_us);
        requests
    }

    /// Whether any browser has paired with this install.
    #[must_use]
    pub fn has_sessions(&self) -> bool {
        !self.active.is_empty()
    }

    #[must_use]
    pub fn session(&self, token: &str) -> Option<&Session> {
        self.active.get(&token_hash(token))
    }

    /// Forgets sessions of phones and tablets whose client record is gone
    /// (S97), as when one was forgotten just before a crash.
    pub fn forget_orphaned_network_sessions(
        &mut self,
        known: impl Fn(&str) -> bool,
        store: &mut dyn Persistence,
    ) {
        let gone: Vec<String> = self
            .active
            .iter()
            .filter(|(hash, session)| {
                network_origin(&session.origin) && !known(&client_of_hash(hash))
            })
            .map(|(hash, _)| hash.clone())
            .collect();
        for hash in gone {
            self.active.remove(&hash);
            store.delete_session(&hash);
        }
    }

    /// Forgets the sessions of a phone or tablet paired on the network
    /// (S97): its cookie no longer counts, so it must pair again.
    pub fn forget_network_client(&mut self, client: &str, store: &mut dyn Persistence) {
        let gone: Vec<String> = self
            .active
            .keys()
            .filter(|hash| client_of_hash(hash) == client)
            .cloned()
            .collect();
        for hash in gone {
            self.active.remove(&hash);
            store.delete_session(&hash);
        }
    }

    /// A new guest of the public listener at `origin`, from `peer`. None
    /// when the listener is full or that address has enough guests already.
    /// Nothing is saved: the `Persistence` port never sees a guest.
    pub fn mint_guest(
        &mut self,
        origin: &str,
        peer: &str,
        clock: &dyn Clock,
        random: &mut dyn Random,
    ) -> Option<String> {
        self.expire_guests(clock, |_| false);
        let from_peer = self.guests.values().filter(|g| g.peer == peer).count();
        if self.guests.len() >= MAX_GUESTS || from_peer >= MAX_GUESTS_PER_PEER {
            return None;
        }
        let token = random.token();
        let now = clock.now_us();
        self.guests.insert(
            token_hash(&token),
            Guest {
                origin: origin.to_owned(),
                created_us: now,
                seen_us: now,
                peer: peer.to_owned(),
                connected: false,
            },
        );
        Some(token)
    }

    /// A guest's session, if it has not expired; it counts as seen now.
    pub fn guest(&mut self, token: &str, clock: &dyn Clock) -> Option<Session> {
        let now = clock.now_us();
        let guest = self.guests.get_mut(&token_hash(token))?;
        if guest_expired(guest, now) {
            return None;
        }
        guest.seen_us = now;
        Some(Session {
            origin: guest.origin.clone(),
        })
    }

    /// A guest's page opened `/rpc`: from now on only `GUEST_IDLE_US`
    /// ends it for being idle. False when it is not here.
    pub fn guest_connected(&mut self, client: &str, clock: &dyn Clock) -> bool {
        let now = clock.now_us();
        let Some(guest) = self
            .guests
            .iter_mut()
            .find(|(hash, _)| guest_of_hash(hash) == client)
            .map(|(_, guest)| guest)
        else {
            return false;
        };
        if guest_expired(guest, now) {
            return false;
        }
        guest.connected = true;
        guest.seen_us = now;
        true
    }

    /// Whether `client` is a guest that is still here.
    #[must_use]
    pub fn has_guest_client(&self, client: &str) -> bool {
        self.guests.keys().any(|hash| guest_of_hash(hash) == client)
    }

    /// How many guests there are now.
    #[must_use]
    pub fn guest_count(&self) -> usize {
        self.guests.len()
    }

    /// Drops guests idle for `GUEST_IDLE_US` or older than `GUEST_MAX_US`,
    /// and returns their client ids, so their sockets can be closed. A guest
    /// `connected` says has a socket open counts as seen first.
    pub fn expire_guests(
        &mut self,
        clock: &dyn Clock,
        connected: impl Fn(&str) -> bool,
    ) -> Vec<String> {
        let now = clock.now_us();
        let mut gone = Vec::new();
        self.guests.retain(|hash, guest| {
            let client = guest_of_hash(hash);
            if connected(&client) {
                guest.connected = true;
                guest.seen_us = now;
            }
            let keep = !guest_expired(guest, now);
            if !keep {
                gone.push(client);
            }
            keep
        });
        gone.sort();
        gone
    }

    fn create_session(
        &mut self,
        origin: String,
        random: &mut dyn Random,
        store: &mut dyn Persistence,
    ) -> String {
        let token = random.token();
        let hash = token_hash(&token);
        let session = Session { origin };
        store.save_session(&hash, &session);
        self.active.insert(hash, session);
        token
    }

    fn expire(&mut self, clock: &dyn Clock) {
        let now = clock.now_us();
        self.pairing.retain(|_, pending| {
            now.saturating_sub(pending.requested_at_us) <= PAIRING_TTL_US
                && (pending.answer.is_some()
                    || now.saturating_sub(pending.polled_at_us) <= ABANDONED_US)
        });
        self.bootstrap
            .retain(|_, (_, created)| now.saturating_sub(*created) <= BOOTSTRAP_TTL_US);
    }
}

fn guest_expired(guest: &Guest, now: u64) -> bool {
    let idle = if guest.connected {
        GUEST_IDLE_US
    } else {
        GUEST_UNCONNECTED_US
    };
    now.saturating_sub(guest.seen_us) > idle || now.saturating_sub(guest.created_us) > GUEST_MAX_US
}

/// What a pairing question is bound to, resolved once it is answered.
#[must_use]
pub fn condition(code: &str) -> String {
    format!("pairing:{code}")
}

/// The question every operator's app shows while a browser waits: who asks,
/// its code to compare with the one on its page, and Allow or Deny. A phone
/// or tablet on the network is named with its address, and is allowed to
/// watch, or to watch and fly (S97).
pub(crate) fn question(asked: &Question) -> Raise {
    let Question {
        origin,
        code,
        device,
        peer,
    } = asked;
    let answer = |label: &str, allow, access| NotificationAction {
        label: label.into(),
        action: Action::AnswerPairing {
            code: code.clone(),
            allow,
            access,
        },
    };
    let spaced = format!(
        "{} {}",
        &code[..code.len().min(3)],
        &code[code.len().min(3)..]
    );
    if let (Some(device), Some(peer)) = (device, peer) {
        return Raise {
            severity: Severity::Warning,
            kind: NotificationKind::Persistent,
            subject: Subject::System,
            title: format!("{device} at {peer} asks to connect to UXDuck"),
            body: Some(format!(
                "From this computer's network. Allow it only if it's your device and it shows {spaced}. Watching can't send commands. Flying can."
            )),
            actions: vec![
                answer("Watch only", true, Some(NetworkAccess::Watch)),
                answer("Watch and fly", true, Some(NetworkAccess::Fly)),
                answer("Deny", false, None),
            ],
            condition: Some(condition(code)),
            report: None,
        };
    }
    let site = origin
        .split_once("://")
        .map_or(origin.as_str(), |(_, host)| host)
        .trim_end_matches('/');
    let site = if site.is_empty() { "A browser" } else { site };
    Raise {
        severity: Severity::Warning,
        kind: NotificationKind::Persistent,
        subject: Subject::System,
        title: format!("{site} asks to connect to UXDuck"),
        body: Some(format!(
            "Allow it only if you asked to connect just now and the page shows {spaced}."
        )),
        actions: vec![answer("Allow", true, None), answer("Deny", false, None)],
        condition: Some(condition(code)),
        report: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct At(u64);
    impl Clock for At {
        fn now_us(&self) -> u64 {
            self.0
        }
    }

    /// Distinct tokens, one after another.
    struct Counting(u8);
    impl Random for Counting {
        fn fill(&mut self, bytes: &mut [u8]) {
            self.0 = self.0.wrapping_add(1);
            bytes.fill(self.0);
        }
    }

    /// Records what would be saved.
    #[derive(Default)]
    struct Saved(Vec<String>);
    impl Persistence for Saved {
        fn append(&mut self, _: &uxduck_core::events::Event) {}
        fn checkpoint(&mut self, _: &crate::state::State) {}
        fn save_session(&mut self, hash: &str, _: &Session) {
            self.0.push(hash.to_owned());
        }
    }

    const ORIGIN: &str = "https://sim.example.com";

    #[test]
    fn guests_are_capped_per_address_and_in_all() {
        let (clock, mut random) = (At(1), Counting(0));
        let mut sessions = Sessions::default();
        for _ in 0..MAX_GUESTS_PER_PEER {
            assert!(
                sessions
                    .mint_guest(ORIGIN, "203.0.113.9", &clock, &mut random)
                    .is_some()
            );
        }
        assert!(
            sessions
                .mint_guest(ORIGIN, "203.0.113.9", &clock, &mut random)
                .is_none()
        );
        let mut peers = 0;
        while sessions.guest_count() < MAX_GUESTS {
            peers += 1;
            let peer = format!("198.51.100.{peers}");
            assert!(
                sessions
                    .mint_guest(ORIGIN, &peer, &clock, &mut random)
                    .is_some()
            );
        }
        assert!(
            sessions
                .mint_guest(ORIGIN, "192.0.2.1", &clock, &mut random)
                .is_none()
        );
    }

    #[test]
    fn guests_expire_when_idle_and_at_their_maximum_age() {
        let mut clock = At(1_000);
        let mut random = Counting(0);
        let mut sessions = Sessions::default();
        let idle = sessions
            .mint_guest(ORIGIN, "a", &clock, &mut random)
            .unwrap();
        let busy = sessions
            .mint_guest(ORIGIN, "b", &clock, &mut random)
            .unwrap();
        let open = sessions
            .mint_guest(ORIGIN, "c", &clock, &mut random)
            .unwrap();
        assert!(sessions.guest_connected(&guest_client(&idle), &clock));
        assert!(sessions.guest_connected(&guest_client(&busy), &clock));
        clock.0 += GUEST_IDLE_US / 2;
        assert!(sessions.guest(&busy, &clock).is_some());
        clock.0 += GUEST_IDLE_US / 2 + 1;
        let open_client = guest_client(&open);
        let gone = sessions.expire_guests(&clock, |client| client == open_client);
        assert_eq!(gone, vec![guest_client(&idle)]);
        assert!(sessions.guest(&idle, &clock).is_none());
        assert!(sessions.guest(&busy, &clock).is_some());
        // A page kept open still ends at the maximum age.
        clock.0 = 1_000 + GUEST_MAX_US + 1;
        let gone = sessions.expire_guests(&clock, |_| true);
        let mut both = vec![guest_client(&busy), open_client];
        both.sort();
        assert_eq!(gone, both);
        assert_eq!(sessions.guest_count(), 0);
    }

    #[test]
    fn a_guest_that_never_connects_goes_soon() {
        let mut clock = At(1_000);
        let mut random = Counting(0);
        let mut sessions = Sessions::default();
        let unused = sessions
            .mint_guest(ORIGIN, "a", &clock, &mut random)
            .unwrap();
        let used = sessions
            .mint_guest(ORIGIN, "a", &clock, &mut random)
            .unwrap();
        assert!(sessions.guest_connected(&guest_client(&used), &clock));
        clock.0 += GUEST_UNCONNECTED_US + 1;
        let gone = sessions.expire_guests(&clock, |_| false);
        assert_eq!(gone, vec![guest_client(&unused)]);
        assert!(sessions.guest(&unused, &clock).is_none());
        assert!(!sessions.guest_connected(&guest_client(&unused), &clock));
        assert!(sessions.guest(&used, &clock).is_some());
        // Its address may mint again at once.
        assert_eq!(sessions.guest_count(), 1);
    }

    #[test]
    fn guests_are_never_saved_nor_sessions_elsewhere() {
        let (clock, mut random) = (At(1), Counting(0));
        let mut store = Saved::default();
        let mut sessions = Sessions::default();
        let token = sessions
            .mint_guest(ORIGIN, "a", &clock, &mut random)
            .unwrap();
        assert!(sessions.session(&token).is_none());
        assert!(!sessions.has_sessions());
        assert!(sessions.has_guest_client(&guest_client(&token)));
        assert!(is_guest_client(&guest_client(&token)));
        assert!(!is_guest_client(&network_client(&token)));
        assert_eq!(
            sessions.guest(&token, &clock),
            Some(Session {
                origin: ORIGIN.into()
            })
        );
        // A paired browser is saved; the guest never was.
        let bootstrap = sessions.create_bootstrap("http://127.0.0.1:45000", &clock, &mut random);
        let paired = sessions
            .exchange_bootstrap(&bootstrap, &clock, &mut random, &mut store)
            .unwrap();
        assert_eq!(store.0, vec![token_hash(&paired)]);
        assert!(sessions.guest(&paired, &clock).is_none());
    }
}
