//! Buildings as obstacles (`DroneX`). The simulator only knows the ground, so
//! a vehicle flies through the buildings the 3D map draws. The engine keeps
//! OpenStreetMap's outlines and heights, a web-map tile at a time, from the
//! account server's `/v1/buildings` (the host fetches them, like places),
//! and a simulated copter about to fly into one is stopped in BRAKE.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use uxduck_core::domain::command::{Command, Receipt, ReceiptStatus};
use uxduck_core::domain::link::LinkKind;
use uxduck_core::domain::modes::Family;
use uxduck_core::domain::notification::{NotificationKind, Severity, Subject};
use uxduck_core::domain::telemetry::{AltitudeFrame, PositionEstimate};
use uxduck_core::events::{Actor, Change};

use crate::Engine;
use crate::commands::Raise;
use crate::runtime::CommandOrder;

/// The web-map zoom of a tile of buildings: about a kilometre.
pub const ZOOM: u32 = 15;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const EARTH_M: f64 = 6_371_000.0;
/// A tile that failed is asked for again after this long.
const RETRY_US: u64 = 30_000_000;
/// Buildings are loaded this far around a flying simulated vehicle.
const LOAD_AROUND_M: f64 = 1_200.0;
/// How close the guard lets a copter come, sideways and above a roof.
const GUARD_MARGIN_M: f64 = 1.5;
/// The guard's deceleration estimate for BRAKE, and its reaction time.
const BRAKE_MPS2: f64 = 4.0;
const REACTION_S: f64 = 0.7;
/// A stopped vehicle is not stopped again for this long.
const GUARD_REPEAT_US: u64 = 3_000_000;
const ACTOR: &str = "building-guard";

fn guard_actor() -> Actor {
    Actor {
        client_id: ACTOR.into(),
        operator_id: None,
        identity: None,
    }
}

/// One building: its height above the ground and its outline.
#[derive(Clone, Debug, PartialEq)]
pub struct Building {
    pub id: String,
    pub height_m: f64,
    /// Latitude and longitude of each corner, in order.
    pub ring: Vec<(f64, f64)>,
    south: f64,
    west: f64,
    north: f64,
    east: f64,
}

impl Building {
    #[must_use]
    pub fn new(id: String, height_m: f64, ring: Vec<(f64, f64)>) -> Self {
        let (mut south, mut west, mut north, mut east) = (90.0, 180.0, -90.0, -180.0);
        for &(lat, lon) in &ring {
            south = f64::min(south, lat);
            north = f64::max(north, lat);
            west = f64::min(west, lon);
            east = f64::max(east, lon);
        }
        Self {
            id,
            height_m,
            ring,
            south,
            west,
            north,
            east,
        }
    }

    /// Whether its outline comes within `radius_m` of a place, roughly.
    fn near(&self, lat: f64, lon: f64, radius_m: f64) -> bool {
        let dlat = radius_m / EARTH_M * 180.0 / std::f64::consts::PI;
        let dlon = dlat / lat.to_radians().cos().max(0.01);
        lat + dlat >= self.south
            && lat - dlat <= self.north
            && lon + dlon >= self.west
            && lon - dlon <= self.east
    }

    /// Its corners in metres east and north of a place.
    #[must_use]
    pub fn local(&self, origin: (f64, f64)) -> Vec<(f64, f64)> {
        self.ring.iter().map(|&p| local(origin, p)).collect()
    }
}

/// Metres east and north of `origin`, both latitude and longitude.
#[must_use]
pub fn local(origin: (f64, f64), point: (f64, f64)) -> (f64, f64) {
    let k = EARTH_M * std::f64::consts::PI / 180.0;
    (
        (point.1 - origin.1) * k * origin.0.to_radians().cos(),
        (point.0 - origin.0) * k,
    )
}

/// The latitude and longitude `east` and `north` metres from `origin`.
#[must_use]
pub fn global(origin: (f64, f64), (east, north): (f64, f64)) -> (f64, f64) {
    let k = EARTH_M * std::f64::consts::PI / 180.0;
    (
        origin.0 + north / k,
        origin.1 + east / (k * origin.0.to_radians().cos()),
    )
}

/// Whether a point is inside a polygon, in local metres.
#[must_use]
pub fn inside(p: (f64, f64), ring: &[(f64, f64)]) -> bool {
    let mut is = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            is = !is;
        }
        j = i;
    }
    is
}

fn point_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx * dx + dy * dy;
    let t = if len == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len).clamp(0.0, 1.0)
    };
    (p.0 - (a.0 + t * dx)).hypot(p.1 - (a.1 + t * dy))
}

fn segments_cross(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> bool {
    let side = |p: (f64, f64), q: (f64, f64), r: (f64, f64)| {
        (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0)
    };
    let (d1, d2) = (side(c, d, a), side(c, d, b));
    let (d3, d4) = (side(a, b, c), side(a, b, d));
    (d1 > 0.0) != (d2 > 0.0) && (d3 > 0.0) != (d4 > 0.0)
}

/// How far a segment passes from a polygon: 0 if it enters it.
#[must_use]
pub fn segment_distance(a: (f64, f64), b: (f64, f64), ring: &[(f64, f64)]) -> f64 {
    if inside(a, ring) || inside(b, ring) {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    for i in 0..ring.len() {
        let (c, d) = (ring[i], ring[(i + 1) % ring.len()]);
        if segments_cross(a, b, c, d) {
            return 0.0;
        }
        best = best
            .min(point_segment(a, c, d))
            .min(point_segment(b, c, d))
            .min(point_segment(c, a, b))
            .min(point_segment(d, a, b));
    }
    best
}

/// The web-map tile holding a place, at `ZOOM`.
#[must_use]
pub fn tile_of(lat: f64, lon: f64) -> (u32, u32) {
    let n = f64::from(1u32 << ZOOM);
    let lat = lat.clamp(-85.0, 85.0).to_radians();
    let x = ((lon + 180.0) / 360.0 * n).floor();
    let y = ((1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0 * n).floor();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (x.clamp(0.0, n - 1.0) as u32, y.clamp(0.0, n - 1.0) as u32)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    buildings: Vec<WireBuilding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireBuilding {
    id: String,
    height_m: f64,
    ring: Vec<f64>,
}

/// The account server's answer. A building that makes no sense is dropped.
///
/// # Errors
/// When the answer is not the server's JSON.
pub fn parse(bytes: &[u8]) -> Result<Vec<Building>, String> {
    let wire: Wire = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    Ok(wire
        .buildings
        .into_iter()
        .filter(|b| b.height_m.is_finite() && b.height_m > 0.0 && b.ring.len() >= 8)
        .map(|b| {
            let ring = b
                .ring
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&[lat, lon]| (lat, lon))
                .collect();
            Building::new(b.id, b.height_m, ring)
        })
        .collect())
}

/// Fetches tiles; completes each with `Engine::buildings_loaded`.
pub trait BuildingPort: Send {
    fn request(&mut self, x: u32, y: u32);
}

enum Tile {
    Loading,
    Ready(Vec<Building>),
    Failed { retry_at_us: u64 },
}

#[derive(Default)]
pub(crate) struct Buildings {
    port: Option<Box<dyn BuildingPort>>,
    tiles: BTreeMap<(u32, u32), Tile>,
    /// When the guard last stopped each vehicle.
    stopped_at: BTreeMap<String, u64>,
    /// Go tos being flown around or over buildings (`route.rs`).
    pub(crate) routes: BTreeMap<String, crate::route::Route>,
}

impl Buildings {
    pub(crate) fn has_port(&self) -> bool {
        self.port.is_some()
    }

    pub(crate) fn ready(&self, tile: (u32, u32)) -> bool {
        matches!(self.tiles.get(&tile), Some(Tile::Ready(_)))
    }

    /// The loaded buildings of some tiles, each once.
    pub(crate) fn in_tiles(&self, tiles: &BTreeSet<(u32, u32)>) -> Vec<&Building> {
        let mut seen = BTreeSet::new();
        tiles
            .iter()
            .filter_map(|t| match self.tiles.get(t) {
                Some(Tile::Ready(found)) => Some(found),
                _ => None,
            })
            .flatten()
            .filter(|b| seen.insert(b.id.as_str()))
            .collect()
    }
}

/// Where a vehicle is now, from its autopilot's estimate.
pub(crate) struct Fix {
    pub lat: f64,
    pub lon: f64,
    /// Its height above home, else above the ground below it: what a
    /// building's height is compared with.
    pub agl_m: f64,
    /// Metres a second east, north and up.
    pub velocity: (f64, f64, f64),
    /// Its height in each frame the autopilot reports.
    pub altitudes: Vec<(AltitudeFrame, f64)>,
}

impl Fix {
    /// Its height in a frame, if reported.
    pub fn in_frame(&self, frame: AltitudeFrame) -> Option<f64> {
        self.altitudes
            .iter()
            .find(|(f, _)| *f == frame)
            .map(|(_, m)| *m)
    }
}

pub(crate) fn fix(positions: &[PositionEstimate]) -> Option<Fix> {
    let p = positions
        .iter()
        .find(|p| p.source == "fused")
        .or_else(|| positions.first())?;
    let altitude = |frame| {
        p.altitudes
            .iter()
            .find(|a| a.frame == frame)
            .map(|a| a.meters)
    };
    // Above home first: terrain data in a city can take rooftops for the
    // ground (downtown San Francisco reads 27 m where the street is ~5 m).
    let agl_m = altitude(AltitudeFrame::AboveHome).or(altitude(AltitudeFrame::AboveGround))?;
    let speed = p.ground_speed_mps.unwrap_or(0.0);
    let (east, north) = match p.course_deg.or(p.heading_deg) {
        Some(course) if speed > 0.2 => {
            let c = course.to_radians();
            (speed * c.sin(), speed * c.cos())
        }
        _ => (0.0, 0.0),
    };
    Some(Fix {
        lat: p.latitude_deg,
        lon: p.longitude_deg,
        agl_m,
        velocity: (east, north, p.climb_mps.unwrap_or(0.0)),
        altitudes: p.altitudes.iter().map(|a| (a.frame, a.meters)).collect(),
    })
}

/// The building a vehicle would hit while stopping from where it is, if
/// any. Ones it is already inside are left out: it can only get out. On a
/// route, it looks no further than just past the leg it is flying to,
/// where it turns.
pub(crate) fn collision<'a>(
    fix: &Fix,
    buildings: &[&'a Building],
    turn_at_m: Option<f64>,
) -> Option<&'a Building> {
    let (east, north, up) = fix.velocity;
    let speed = east.hypot(north);
    let time_s = REACTION_S + speed / BRAKE_MPS2;
    let reach = speed * REACTION_S + speed * speed / (2.0 * BRAKE_MPS2);
    let reach = turn_at_m.map_or(reach, |m| reach.min(m + 3.0));
    let ahead = if speed > 0.0 {
        (east / speed * reach, north / speed * reach)
    } else {
        (0.0, 0.0)
    };
    // The height it reaches while stopping: lower when sinking.
    let low_m = fix.agl_m + (up * time_s).min(0.0);
    let origin = (fix.lat, fix.lon);
    buildings.iter().copied().find(|b| {
        let ring = b.local(origin);
        if low_m >= b.height_m + GUARD_MARGIN_M {
            return false;
        }
        // Over or inside its outline, only sinking onto the roof hits it:
        // climbing out of it, or crossing it, never does.
        if inside((0.0, 0.0), &ring) {
            return up < 0.0 && fix.agl_m >= b.height_m;
        }
        segment_distance((0.0, 0.0), ahead, &ring) < GUARD_MARGIN_M
    })
}

impl Engine {
    pub fn set_buildings(&mut self, port: Box<dyn BuildingPort>) {
        self.buildings.port = Some(port);
    }

    /// A tile's buildings arrived, or could not be had.
    pub fn buildings_loaded(&mut self, x: u32, y: u32, result: Result<Vec<Building>, String>) {
        let tile = match result {
            Ok(found) => Tile::Ready(found),
            Err(_) => Tile::Failed {
                retry_at_us: self.clock.now_us() + RETRY_US,
            },
        };
        self.buildings.tiles.insert((x, y), tile);
    }

    pub(crate) fn tiles_around(lat: f64, lon: f64, radius_m: f64) -> BTreeSet<(u32, u32)> {
        let (south, west) = global((lat, lon), (-radius_m, -radius_m));
        let (north, east) = global((lat, lon), (radius_m, radius_m));
        let (x0, y0) = tile_of(north, west);
        let (x1, y1) = tile_of(south, east);
        (x0..=x1)
            .flat_map(|x| (y0..=y1).map(move |y| (x, y)))
            .collect()
    }

    /// Asks for the tiles around a place that are not loaded or loading.
    pub(crate) fn want_buildings(&mut self, lat: f64, lon: f64, radius_m: f64) {
        for tile in Self::tiles_around(lat, lon, radius_m) {
            self.want_tile(tile);
        }
    }

    /// Asks for a tile unless it is loaded, loading, or failed just now.
    pub(crate) fn want_tile(&mut self, tile: (u32, u32)) {
        let due = match self.buildings.tiles.get(&tile) {
            None => true,
            Some(Tile::Failed { retry_at_us }) => self.clock.now_us() >= *retry_at_us,
            Some(_) => false,
        };
        if due && let Some(port) = self.buildings.port.as_mut() {
            self.buildings.tiles.insert(tile, Tile::Loading);
            port.request(tile.0, tile.1);
        }
    }

    /// The loaded buildings within `radius_m` of a place, each once.
    pub(crate) fn buildings_near(&self, lat: f64, lon: f64, radius_m: f64) -> Vec<&Building> {
        let mut seen = BTreeSet::new();
        Self::tiles_around(lat, lon, radius_m)
            .iter()
            .filter_map(|t| match self.buildings.tiles.get(t) {
                Some(Tile::Ready(found)) => Some(found),
                _ => None,
            })
            .flatten()
            .filter(|b| b.near(lat, lon, radius_m) && seen.insert(b.id.as_str()))
            .collect()
    }

    /// Whether a vehicle is a simulated copter: the guard and routing only
    /// steer those (real vehicles keep their own pilot's judgement).
    pub(crate) fn simulated_copter(&self, vehicle_id: &str) -> bool {
        self.vehicle(vehicle_id).is_some_and(|v| {
            Family::of(&v.vehicle_type) == Some(Family::Copter)
                && self
                    .state
                    .links
                    .get(&v.link_id)
                    .is_some_and(|l| matches!(l.kind, LinkKind::Simulator { .. }))
        })
    }

    /// Telemetry arrived: load the buildings around a flying simulated
    /// copter, and stop it before it flies into one.
    pub(crate) fn review_buildings(&mut self, vehicle_id: &str) {
        if self.buildings.port.is_none() || !self.simulated_copter(vehicle_id) {
            return;
        }
        let Some(vehicle) = self.vehicle(vehicle_id) else {
            return;
        };
        let (id, name, armed) = (vehicle.id.clone(), vehicle.name.clone(), vehicle.armed);
        let mode = vehicle.mode.clone().unwrap_or_default();
        let Some(fix) = self.telemetry(&id).and_then(|t| fix(&t.positions)) else {
            return;
        };
        self.want_buildings(fix.lat, fix.lon, LOAD_AROUND_M);
        self.follow_route(&id);
        if !armed
            || ["BRAKE", "LAND"]
                .iter()
                .any(|m| mode.eq_ignore_ascii_case(m))
            || !self.off_the_ground(&id, true)
        {
            return;
        }
        let now = self.clock.now_us();
        if self
            .buildings
            .stopped_at
            .get(&id)
            .is_some_and(|at| now < at + GUARD_REPEAT_US)
        {
            return;
        }
        let turn_at_m = self
            .buildings
            .routes
            .get(&id)
            .map(|r| r.leg_distance(fix.lat, fix.lon));
        let near = self.buildings_near(fix.lat, fix.lon, 150.0);
        let Some(height_m) = collision(&fix, &near, turn_at_m).map(|b| b.height_m) else {
            return;
        };
        self.buildings.stopped_at.insert(id.clone(), now);
        self.buildings.routes.remove(&id);
        self.send_as_building_guard(
            &id,
            Command::SetMode {
                mode: "BRAKE".into(),
            },
        );
        self.raise(Raise {
            severity: Severity::Warning,
            kind: NotificationKind::Transient,
            subject: Subject::Vehicle { id },
            title: format!("{name} stopped before hitting a building"),
            body: Some(format!(
                "Buildings are solid. It is braking in front of one about {height_m:.0} m tall. \
                 Fly away from it, or climb above it."
            )),
            actions: Vec::new(),
            condition: None,
            report: None,
        });
    }

    /// A command as `building-guard`: journaled with a receipt like any other.
    pub(crate) fn send_as_building_guard(&mut self, vehicle_id: &str, command: Command) -> String {
        let receipt = Receipt {
            id: format!("rc{}", &self.random.token()[..16]),
            vehicle_id: vehicle_id.to_owned(),
            command: command.clone(),
            status: ReceiptStatus::Sent,
            detail: None,
            reason: None,
            sent_without_recent_heartbeat: false,
            forced: false,
            attempts: 0,
            client_id: ACTOR.into(),
            operator_id: None,
            remote: None,
            created_at_us: self.clock.now_us(),
            completed_at_us: None,
            version: 1,
        };
        let id = receipt.id.clone();
        self.commit_as(guard_actor(), Change::ReceiptUpserted { receipt });
        self.links.command(CommandOrder {
            receipt_id: id.clone(),
            vehicle_id: vehicle_id.to_owned(),
            command,
            force: false,
        });
        id
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    const AT: (f64, f64) = (37.79, -122.40);

    /// A 20 m square building whose near wall is `ahead_m` north of `AT`.
    fn wall(ahead_m: f64, height_m: f64) -> Building {
        let c = [
            (-10.0, ahead_m),
            (10.0, ahead_m),
            (10.0, ahead_m + 20.0),
            (-10.0, ahead_m + 20.0),
        ];
        Building::new(
            "w1".into(),
            height_m,
            c.iter().map(|&p| global(AT, p)).collect(),
        )
    }

    fn flying(north_mps: f64, agl_m: f64, up_mps: f64) -> Fix {
        Fix {
            lat: AT.0,
            lon: AT.1,
            agl_m,
            velocity: (0.0, north_mps, up_mps),
            altitudes: vec![(AltitudeFrame::AboveHome, agl_m)],
        }
    }

    #[test]
    fn local_and_global_round_trip() {
        let p = global(AT, (120.0, -45.0));
        let (e, n) = local(AT, p);
        assert!((e - 120.0).abs() < 1e-6 && (n + 45.0).abs() < 1e-6);
    }

    #[test]
    fn geometry_finds_inside_and_crossings() {
        let sq = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(inside((5.0, 5.0), &sq));
        assert!(!inside((15.0, 5.0), &sq));
        assert_eq!(segment_distance((-5.0, 5.0), (15.0, 5.0), &sq), 0.0);
        assert!((segment_distance((-5.0, 12.0), (15.0, 12.0), &sq) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn tiles_are_web_map_tiles() {
        // Downtown San Francisco at zoom 15.
        assert_eq!(tile_of(37.7899, -122.3969), (5243, 12663));
    }

    #[test]
    fn a_copter_flying_at_a_wall_it_cannot_stop_short_of_is_stopped() {
        let b = wall(8.0, 40.0);
        assert!(collision(&flying(8.0, 20.0, 0.0), &[&b], None).is_some());
        // Far enough away to stop on its own, for now.
        assert!(collision(&flying(8.0, 20.0, 0.0), &[&wall(60.0, 40.0)], None).is_none());
        // Flying away, or above the roof.
        assert!(collision(&flying(-8.0, 20.0, 0.0), &[&b], None).is_none());
        assert!(collision(&flying(8.0, 45.0, 0.0), &[&b], None).is_none());
    }

    #[test]
    fn sinking_onto_a_roof_is_stopped_and_one_already_inside_can_leave() {
        let under = wall(-10.0, 30.0);
        assert!(collision(&flying(0.0, 32.0, -2.0), &[&under], None).is_some());
        assert!(collision(&flying(0.0, 40.0, -2.0), &[&under], None).is_none());
        assert!(collision(&flying(5.0, 10.0, 0.0), &[&under], None).is_none());
        // Climbing up out through the roof.
        assert!(collision(&flying(0.0, 29.5, 2.5), &[&under], None).is_none());
    }

    #[test]
    fn the_server_answer_is_read_and_nonsense_dropped() {
        let found = parse(
            br#"{"tile":{"z":15,"x":1,"y":2},"attribution":"x","buildings":[
              {"id":"w1","heightM":30,"ring":[37.0,-122.0,37.0,-121.999,37.001,-121.999,37.0,-122.0]},
              {"id":"w2","heightM":-1,"ring":[37.0,-122.0,37.0,-121.999,37.001,-121.999,37.0,-122.0]},
              {"id":"w3","heightM":10,"ring":[37.0,-122.0]}]}"#,
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].ring[1], (37.0, -121.999));
    }
}
