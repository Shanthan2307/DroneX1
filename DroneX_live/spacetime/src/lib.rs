//! DroneX shared airspace (SpacetimeDB module).
//!
//! One live world for every operator and every agent: the vehicles in the air, their latest positions, the
//! corridors they hold, the incidents they report and the missions they carry. The rules live here, next to the
//! data, and run inside transactions: a corridor is granted or refused atomically against every corridor already
//! held, a stale corridor expires on its own, and a vehicle that stops reporting goes offline on its own.
//!
//! Fed by DroneX_live's mirror (one per computer, reading the simulation engine's socket), read by the
//! configurator's Copilot page (subscriptions), and used by the Dispatch agents through the configurator's
//! /api/airspace routes.
//!
//! Who may write: everyone may subscribe (the tables are public, so browsers read the airspace live), but only the
//! module's owner and the identities in the private `writer` table may call the mutating reducers. The owner is the
//! identity that published the database (`init` runs with the publisher as `ctx.sender()`); the owner adds DroneX's
//! own server processes (the mirror and the configurator's server, sharing one token) with `add_writer`. The
//! housekeeping `tick` runs only on the module's own schedule.

mod geo;

use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

/// Corridors closer than this (edge to edge) conflict, metres.
const LATERAL_BUFFER_M: f64 = 10.0;
/// Altitude bands closer than this conflict, metres.
const VERTICAL_BUFFER_M: f64 = 10.0;
/// A vehicle with no position report for this long is marked offline, microseconds.
const OFFLINE_AFTER_US: i64 = 15_000_000;
/// The housekeeping tick.
const TICK_MS: u64 = 2_000;
/// How often the tick prunes old rows, microseconds.
const PRUNE_EVERY_US: i64 = 60_000_000;
/// Corridors that were never granted are deleted this long after the request; released and expired ones this long
/// after their expiry time.
const ENDED_CORRIDOR_TTL_US: i64 = 3_600_000_000;
/// Incidents are deleted this long after they happened.
const INCIDENT_TTL_US: i64 = 3_600_000_000;
/// A vehicle offline for this long is deleted, with its position and its mission assignment.
const OFFLINE_VEHICLE_TTL_US: i64 = 600_000_000;

/// The module's own settings (one row, id 0). Private: subscribers never see it.
#[spacetimedb::table(accessor = config)]
pub struct Config {
    #[primary_key]
    pub id: u8,
    /// The identity that published the database; the only one that may add or remove writers.
    pub owner: Identity,
    /// The last time the tick pruned old rows, microseconds since the Unix epoch.
    pub pruned_at: i64,
    /// The last keepalive call, microseconds since the Unix epoch.
    pub keepalive_at: i64,
}

/// The identities allowed to call the mutating reducers (besides the owner). Private.
#[spacetimedb::table(accessor = writer)]
pub struct Writer {
    #[primary_key]
    pub identity: Identity,
    pub added_at: i64,
}

#[spacetimedb::table(accessor = vehicle, public)]
pub struct Vehicle {
    #[primary_key]
    pub id: String,
    pub name: String,
    pub design_id: Option<String>,
    pub vehicle_type: String,
    /// Who flies it: the mirror's computer name, or an agent's name.
    pub operator: String,
    /// online | stale | offline
    pub presence: String,
    pub armed: bool,
    pub mode: String,
    pub size_cm: Option<f64>,
    /// Microseconds since the Unix epoch, the module's clock.
    pub updated_at: i64,
}

/// The latest position of each vehicle (one row per vehicle; the history lives in the flight index).
#[spacetimedb::table(accessor = position, public)]
pub struct Position {
    #[primary_key]
    pub vehicle_id: String,
    pub lat: f64,
    pub lon: f64,
    pub alt_amsl: Option<f64>,
    pub alt_home: Option<f64>,
    pub heading: Option<f64>,
    pub speed: Option<f64>,
    pub battery_pct: Option<f64>,
    pub gps_sats: Option<f64>,
    pub ekf_status: Option<String>,
    /// The vehicle's own clock, microseconds since the Unix epoch.
    pub time_us: i64,
    /// When the module saw it.
    pub seen_at: i64,
}

#[spacetimedb::table(accessor = corridor, public)]
pub struct Corridor {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The caller's own id for the request, so it can find the answer.
    #[unique]
    pub request_id: String,
    #[index(btree)]
    pub vehicle_id: String,
    pub from_lat: f64,
    pub from_lon: f64,
    pub to_lat: f64,
    pub to_lon: f64,
    pub min_alt: f64,
    pub max_alt: f64,
    pub width_m: f64,
    /// granted | refused | released | expired
    #[index(btree)]
    pub status: String,
    pub requested_at: i64,
    pub expires_at: i64,
    /// Why it was refused (the holder and the overlap), or empty.
    pub reason: String,
}

#[spacetimedb::table(accessor = incident, public)]
pub struct Incident {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub vehicle_id: String,
    /// building-brake | gps-degraded | ekf | battery | mode | corridor-refused | other
    pub kind: String,
    pub detail: String,
    pub lat: f64,
    pub lon: f64,
    pub time_us: i64,
}

#[spacetimedb::table(accessor = mission_assignment, public)]
pub struct MissionAssignment {
    #[primary_key]
    pub vehicle_id: String,
    pub mission_id: String,
    /// The agent (or person) that assigned it.
    pub agent: String,
    /// proposed | accepted | flying | done | failed | released
    pub status: String,
    pub updated_at: i64,
}

#[spacetimedb::table(accessor = tick_timer, scheduled(tick))]
pub struct TickTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

fn now_us(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch()
}

fn owner(ctx: &ReducerContext) -> Option<Identity> {
    ctx.db.config().id().find(0).map(|c| c.owner)
}

fn require_owner(ctx: &ReducerContext) -> Result<(), String> {
    match owner(ctx) {
        Some(o) if o == ctx.sender() => Ok(()),
        _ => Err("only the airspace's owner may do this".into()),
    }
}

/// Every mutating reducer starts with this: the owner and the registered writers pass, everyone else is refused.
fn require_writer(ctx: &ReducerContext) -> Result<(), String> {
    let sender = ctx.sender();
    if owner(ctx) == Some(sender) || ctx.db.writer().identity().find(sender).is_some() {
        Ok(())
    } else {
        Err(format!("{} may read the airspace but not write to it", sender.to_hex()))
    }
}

/// Runs once, when the database is first published; the sender is the publishing identity, which becomes the owner
/// (checked against SpacetimeDB 2.13: `spacetime logs` shows the publisher's identity). A database published before
/// the allow-list existed has no owner, so nobody can add writers: republish it with a clean database.
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    if ctx.db.config().id().find(0).is_none() {
        log::info!("DroneX airspace: owner is {}", ctx.sender().to_hex());
        ctx.db.config().insert(Config { id: 0, owner: ctx.sender(), pruned_at: 0, keepalive_at: 0 });
    }
    log::info!("DroneX airspace: starting the housekeeping tick every {TICK_MS} ms");
    ctx.db.tick_timer().insert(TickTimer { scheduled_id: 0, scheduled_at: ScheduleAt::Interval(Duration::from_millis(TICK_MS).into()) });
}

/// Owner only: lets `identity` call the mutating reducers (DroneX's mirror and configurator server).
#[spacetimedb::reducer]
pub fn add_writer(ctx: &ReducerContext, identity: Identity) -> Result<(), String> {
    require_owner(ctx)?;
    if ctx.db.writer().identity().find(identity).is_none() {
        ctx.db.writer().insert(Writer { identity, added_at: now_us(ctx) });
    }
    log::info!("writer added: {}", identity.to_hex());
    Ok(())
}

/// Owner only: takes the write right away again.
#[spacetimedb::reducer]
pub fn remove_writer(ctx: &ReducerContext, identity: Identity) -> Result<(), String> {
    require_owner(ctx)?;
    ctx.db.writer().identity().delete(identity);
    log::info!("writer removed: {}", identity.to_hex());
    Ok(())
}

/// Writers only: a tiny write the mirror makes every few hours, so a hosted database never looks idle.
#[spacetimedb::reducer]
pub fn keepalive(ctx: &ReducerContext) -> Result<(), String> {
    require_writer(ctx)?;
    if let Some(mut c) = ctx.db.config().id().find(0) {
        c.keepalive_at = now_us(ctx);
        ctx.db.config().id().update(c);
    }
    Ok(())
}

/// A vehicle appears or changes (name, design, presence, arming, mode). Called by the mirror and by agents.
#[spacetimedb::reducer]
#[allow(clippy::too_many_arguments)]
pub fn upsert_vehicle(
    ctx: &ReducerContext,
    id: String,
    name: String,
    design_id: Option<String>,
    vehicle_type: String,
    operator: String,
    presence: String,
    armed: bool,
    mode: String,
    size_cm: Option<f64>,
) -> Result<(), String> {
    require_writer(ctx)?;
    if id.is_empty() {
        return Err("a vehicle needs an id".into());
    }
    let row = Vehicle { id: id.clone(), name, design_id, vehicle_type, operator, presence, armed, mode, size_cm, updated_at: now_us(ctx) };
    if ctx.db.vehicle().id().find(&id).is_some() {
        ctx.db.vehicle().id().update(row);
    } else {
        ctx.db.vehicle().insert(row);
    }
    Ok(())
}

/// The latest fix of a vehicle. Keeps the vehicle online.
#[spacetimedb::reducer]
#[allow(clippy::too_many_arguments)]
pub fn report_position(
    ctx: &ReducerContext,
    vehicle_id: String,
    lat: f64,
    lon: f64,
    alt_amsl: Option<f64>,
    alt_home: Option<f64>,
    heading: Option<f64>,
    speed: Option<f64>,
    battery_pct: Option<f64>,
    gps_sats: Option<f64>,
    ekf_status: Option<String>,
    time_us: i64,
) -> Result<(), String> {
    require_writer(ctx)?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err(format!("{vehicle_id}: position {lat}, {lon} is off the planet"));
    }
    let seen_at = now_us(ctx);
    let row = Position { vehicle_id: vehicle_id.clone(), lat, lon, alt_amsl, alt_home, heading, speed, battery_pct, gps_sats, ekf_status, time_us, seen_at };
    if ctx.db.position().vehicle_id().find(&vehicle_id).is_some() {
        ctx.db.position().vehicle_id().update(row);
    } else {
        ctx.db.position().insert(row);
    }
    if let Some(mut v) = ctx.db.vehicle().id().find(&vehicle_id) {
        if v.presence != "online" {
            v.presence = "online".into();
            v.updated_at = seen_at;
            ctx.db.vehicle().id().update(v);
        }
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_incident(ctx: &ReducerContext, vehicle_id: String, kind: String, detail: String, lat: f64, lon: f64, time_us: i64) -> Result<(), String> {
    require_writer(ctx)?;
    if kind.is_empty() {
        return Err("an incident needs a kind".into());
    }
    ctx.db.incident().insert(Incident { id: 0, vehicle_id, kind, detail, lat, lon, time_us });
    Ok(())
}

fn corridor_geometry(c: &Corridor, ref_lat: f64, ref_lon: f64) -> geo::Corridor {
    geo::Corridor {
        a: geo::to_local(c.from_lat, c.from_lon, ref_lat, ref_lon),
        b: geo::to_local(c.to_lat, c.to_lon, ref_lat, ref_lon),
        half_width_m: c.width_m / 2.0,
        min_alt_m: c.min_alt,
        max_alt_m: c.max_alt,
    }
}

/// Asks for a corridor: a segment between two points, a width and an altitude band above home, for `ttl_s`
/// seconds. Granted unless it conflicts with a corridor another vehicle holds, in which case the row is written
/// as refused with the reason (the holder, the distance, the band), so every subscriber sees the refusal. A
/// vehicle's own earlier corridors never block it. Atomic: two requests for the same air cannot both be granted.
#[spacetimedb::reducer]
#[allow(clippy::too_many_arguments)]
pub fn request_corridor(
    ctx: &ReducerContext,
    request_id: String,
    vehicle_id: String,
    from_lat: f64,
    from_lon: f64,
    to_lat: f64,
    to_lon: f64,
    min_alt: f64,
    max_alt: f64,
    width_m: f64,
    ttl_s: u64,
) -> Result<(), String> {
    require_writer(ctx)?;
    if request_id.is_empty() || vehicle_id.is_empty() {
        return Err("a corridor request needs a request_id and a vehicle_id".into());
    }
    if !(min_alt < max_alt) || !(width_m > 0.0) {
        return Err("a corridor needs min_alt < max_alt and a positive width".into());
    }
    if ctx.db.corridor().request_id().find(&request_id).is_some() {
        return Err(format!("request {request_id} was already answered"));
    }
    let now = now_us(ctx);
    let ttl = ttl_s.clamp(10, 3_600) as i64 * 1_000_000;
    let mut row = Corridor {
        id: 0,
        request_id,
        vehicle_id: vehicle_id.clone(),
        from_lat,
        from_lon,
        to_lat,
        to_lon,
        min_alt,
        max_alt,
        width_m,
        status: "granted".into(),
        requested_at: now,
        expires_at: now + ttl,
        reason: String::new(),
    };
    let mine = corridor_geometry(&row, from_lat, from_lon);
    for other in ctx.db.corridor().status().filter("granted") {
        if other.vehicle_id == vehicle_id || other.expires_at <= now {
            continue;
        }
        let theirs = corridor_geometry(&other, from_lat, from_lon);
        if geo::corridors_conflict(&mine, &theirs, LATERAL_BUFFER_M, VERTICAL_BUFFER_M) {
            let holder = ctx.db.vehicle().id().find(&other.vehicle_id).map(|v| v.name).unwrap_or(other.vehicle_id.clone());
            let gap = geo::segment_distance(mine.a, mine.b, theirs.a, theirs.b);
            row.status = "refused".into();
            row.reason = format!(
                "conflicts with corridor {} held by {} ({:.0} m apart, {:.0}-{:.0} m band); climb above {:.0} m or wait for it to expire",
                other.id,
                holder,
                gap,
                other.min_alt,
                other.max_alt,
                other.max_alt + VERTICAL_BUFFER_M
            );
            break;
        }
    }
    let refused = row.status == "refused";
    let reason = row.reason.clone();
    let inserted = ctx.db.corridor().insert(row);
    if refused {
        log::info!("corridor {} for {} refused: {}", inserted.id, vehicle_id, reason);
        ctx.db.incident().insert(Incident { id: 0, vehicle_id, kind: "corridor-refused".into(), detail: reason, lat: from_lat, lon: from_lon, time_us: now });
    } else {
        log::info!("corridor {} granted to {}", inserted.id, vehicle_id);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn release_corridor(ctx: &ReducerContext, id: u64) -> Result<(), String> {
    require_writer(ctx)?;
    let mut c = ctx.db.corridor().id().find(&id).ok_or_else(|| format!("no corridor {id}"))?;
    if c.status == "granted" {
        c.status = "released".into();
        ctx.db.corridor().id().update(c);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn assign_mission(ctx: &ReducerContext, vehicle_id: String, mission_id: String, agent: String, status: String) -> Result<(), String> {
    require_writer(ctx)?;
    if vehicle_id.is_empty() || mission_id.is_empty() {
        return Err("an assignment needs a vehicle_id and a mission_id".into());
    }
    let row = MissionAssignment { vehicle_id: vehicle_id.clone(), mission_id, agent, status, updated_at: now_us(ctx) };
    if ctx.db.mission_assignment().vehicle_id().find(&vehicle_id).is_some() {
        ctx.db.mission_assignment().vehicle_id().update(row);
    } else {
        ctx.db.mission_assignment().insert(row);
    }
    Ok(())
}

/// Housekeeping: expire granted corridors past their time; mark vehicles offline after OFFLINE_AFTER_US without
/// a position (stale halfway there); once a minute, prune old rows. Runs only on the module's own schedule: a
/// scheduled call comes from the database's own identity, a client call does not.
#[spacetimedb::reducer]
pub fn tick(ctx: &ReducerContext, _timer: TickTimer) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tick runs on the module's schedule only".into());
    }
    let now = now_us(ctx);
    let expired: Vec<Corridor> = ctx.db.corridor().status().filter("granted").filter(|c| c.expires_at <= now).collect();
    for mut c in expired {
        c.status = "expired".into();
        log::info!("corridor {} of {} expired", c.id, c.vehicle_id);
        ctx.db.corridor().id().update(c);
    }
    let vehicles: Vec<Vehicle> = ctx.db.vehicle().iter().collect();
    for mut v in vehicles {
        if v.presence == "offline" {
            continue;
        }
        let last = ctx.db.position().vehicle_id().find(&v.id).map(|p| p.seen_at).unwrap_or(v.updated_at);
        let age = now - last;
        let next = if age > OFFLINE_AFTER_US { "offline" } else if age > OFFLINE_AFTER_US / 2 { "stale" } else { "online" };
        if v.presence != next {
            v.presence = next.into();
            v.updated_at = now;
            ctx.db.vehicle().id().update(v);
        }
    }
    prune(ctx, now);
    Ok(())
}

/// Deletes what nobody needs any more, at most once per PRUNE_EVERY_US: corridors never granted and requested more
/// than an hour ago, released or expired corridors an hour past their expiry, incidents older than an hour, and
/// vehicles offline for ten minutes together with their position and mission assignment.
fn prune(ctx: &ReducerContext, now: i64) {
    let Some(mut cfg) = ctx.db.config().id().find(0) else { return };
    if now - cfg.pruned_at < PRUNE_EVERY_US {
        return;
    }
    cfg.pruned_at = now;
    ctx.db.config().id().update(cfg);

    let corridors: Vec<u64> = ctx
        .db
        .corridor()
        .iter()
        .filter(|c| match c.status.as_str() {
            "granted" => false,
            "refused" => now - c.requested_at > ENDED_CORRIDOR_TTL_US,
            _ => now - c.expires_at > ENDED_CORRIDOR_TTL_US,
        })
        .map(|c| c.id)
        .collect();
    for id in &corridors {
        ctx.db.corridor().id().delete(id);
    }

    let incidents: Vec<u64> = ctx.db.incident().iter().filter(|i| now - i.time_us > INCIDENT_TTL_US).map(|i| i.id).collect();
    for id in &incidents {
        ctx.db.incident().id().delete(id);
    }

    let vehicles: Vec<String> = ctx.db.vehicle().iter().filter(|v| v.presence == "offline" && now - v.updated_at > OFFLINE_VEHICLE_TTL_US).map(|v| v.id).collect();
    for id in &vehicles {
        ctx.db.position().vehicle_id().delete(id);
        ctx.db.mission_assignment().vehicle_id().delete(id);
        ctx.db.vehicle().id().delete(id);
    }

    if !corridors.is_empty() || !incidents.is_empty() || !vehicles.is_empty() {
        log::info!("pruned {} corridors, {} incidents, {} offline vehicles", corridors.len(), incidents.len(), vehicles.len());
    }
}
