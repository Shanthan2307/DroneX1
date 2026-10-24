//! Missions and buildings (`DroneX`). A mission is flown by the autopilot,
//! so Core can't steer it on the way like a Go to: its legs are checked
//! against the buildings before it is uploaded (`building` warnings in the
//! plan's checks), and `plan/route` gives a multicopter plan's legs that fly
//! into one waypoints around or over it, with the planner Go to uses. Heights
//! are compared above home, as for Go to.

use uxduck_core::domain::plan::{PlanBody, PlanFrame, PlanItem, PlanVehicleType};
use uxduck_terrain::Dataset;
use uxduck_terrain::lookup::Ground as Surface;

use crate::Engine;
use crate::buildings::{global, local};
use crate::plan_checks::{Check, Severity};
use crate::route::{self, Ground, How, Obstacle};

const NAV_WAYPOINT: u16 = 16;
/// Buildings this far either side of a leg are looked at by the check.
const CHECK_PAD_M: f64 = 50.0;

/// Commands the vehicle flies to: what makes a leg.
fn flown(command: u16) -> bool {
    matches!(command, 16..=19 | 21 | 22 | 30 | 31 | 82 | 84 | 85)
}

/// A leg between two items it flies to, by their index.
struct Leg {
    from: usize,
    to: usize,
    a: (f64, f64),
    b: (f64, f64),
}

fn legs(body: &PlanBody) -> Vec<Leg> {
    let points: Vec<usize> = body
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| flown(item.command) && uxduck_core::domain::plan::has_position(item))
        .map(|(k, _)| k)
        .collect();
    let at = |k: usize| (body.items[k].latitude_deg, body.items[k].longitude_deg);
    points
        .windows(2)
        .map(|w| Leg {
            from: w[0],
            to: w[1],
            a: at(w[0]),
            b: at(w[1]),
        })
        .collect()
}

/// The tiles along a line, `pad_m` either side.
#[allow(clippy::many_single_char_names)]
fn line_tiles(a: (f64, f64), b: (f64, f64), pad_m: f64) -> std::collections::BTreeSet<(u32, u32)> {
    let (e, n) = local(a, b);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let steps = (e.hypot(n) / 200.0).ceil() as usize + 1;
    (0..=steps)
        .flat_map(|k| {
            #[allow(clippy::cast_precision_loss)]
            let t = k as f64 / steps as f64;
            let p = global(a, (e * t, n * t));
            Engine::tiles_around(p.0, p.1, pad_m)
        })
        .collect()
}

/// Why a leg can't be looked at yet.
enum Unknown {
    /// Its buildings or ground are on their way.
    Coming,
    /// Its height can't be put above home.
    Height,
}

impl Engine {
    fn plan_dataset(&self, vehicle_id: Option<&str>) -> Dataset {
        vehicle_id.map_or_else(
            || crate::terrain::setting(self.state.settings.terrain_dataset),
            |id| self.terrain_dataset_of(id),
        )
    }

    /// The ground above sea level: `Some(None)` where there is no height,
    /// `None` while it is on its way (as `plan_checks::Ground`).
    #[allow(clippy::option_option)]
    fn ground_at(&mut self, dataset: Dataset, (lat, lon): (f64, f64)) -> Option<Option<f64>> {
        let params = uxduck_contracts::dto::terrain::TerrainAtParams {
            latitude_deg: lat,
            longitude_deg: lon,
            dataset: None,
        };
        let answer = self.terrain_answer(dataset, &params)?;
        Some(match answer.ground {
            Ok(Surface::Height(h)) => Some(h),
            Ok(Surface::Sea) => Some(0.0),
            _ => None,
        })
    }

    /// Home's ground above sea level, as the plan's ground check finds it.
    fn plan_home_amsl(&mut self, body: &PlanBody, dataset: Dataset) -> Option<f64> {
        let home = body.planned_home?;
        self.ground_at(dataset, (home.latitude_deg, home.longitude_deg))
            .flatten()
            .or(home.altitude_m)
    }

    /// An item's height above home.
    fn above_home(
        &mut self,
        item: &PlanItem,
        home_amsl: Option<f64>,
        dataset: Dataset,
    ) -> Result<f64, Unknown> {
        match PlanFrame::from_mav_frame(item.frame) {
            Some(PlanFrame::AboveHome) => Ok(item.altitude_m),
            Some(PlanFrame::AboveSeaLevel) => {
                Ok(item.altitude_m - home_amsl.ok_or(Unknown::Height)?)
            }
            Some(PlanFrame::AboveTerrain) => {
                let home = home_amsl.ok_or(Unknown::Height)?;
                let ground = self
                    .ground_at(dataset, (item.latitude_deg, item.longitude_deg))
                    .ok_or(Unknown::Coming)?
                    .ok_or(Unknown::Height)?;
                Ok(item.altitude_m + ground - home)
            }
            None => Err(Unknown::Height),
        }
    }

    /// A height above home at a place, in a frame.
    fn in_plan_frame(
        &mut self,
        height_m: f64,
        frame: Option<PlanFrame>,
        at: (f64, f64),
        home_amsl: Option<f64>,
        dataset: Dataset,
    ) -> Result<f64, Unknown> {
        match frame {
            Some(PlanFrame::AboveHome) => Ok(height_m),
            Some(PlanFrame::AboveSeaLevel) => Ok(height_m + home_amsl.ok_or(Unknown::Height)?),
            Some(PlanFrame::AboveTerrain) => {
                let home = home_amsl.ok_or(Unknown::Height)?;
                let ground = self
                    .ground_at(dataset, at)
                    .ok_or(Unknown::Coming)?
                    .ok_or(Unknown::Height)?;
                Ok(height_m + home - ground)
            }
            None => Err(Unknown::Height),
        }
    }

    /// The loaded buildings of some tiles, in local metres from `origin`.
    fn obstacles_in(
        &self,
        tiles: &std::collections::BTreeSet<(u32, u32)>,
        origin: (f64, f64),
    ) -> Vec<Obstacle> {
        self.buildings
            .in_tiles(tiles)
            .into_iter()
            .map(|b| Obstacle {
                ring: b.local(origin),
                height_m: b.height_m,
            })
            .collect()
    }

    /// Asks for tiles; whether they are all here.
    fn tiles_here(&mut self, tiles: &std::collections::BTreeSet<(u32, u32)>) -> bool {
        for &tile in tiles {
            self.want_tile(tile);
        }
        tiles.iter().all(|t| self.buildings.ready(*t))
    }

    /// A plan's `building` checks: each leg that flies into a building, or
    /// that the buildings are still being fetched.
    pub(crate) fn building_checks(
        &mut self,
        body: &PlanBody,
        vehicle_id: Option<&str>,
    ) -> Vec<Check> {
        if !self.buildings.has_port() || !body.vehicle_type.flies() {
            return Vec::new();
        }
        let dataset = self.plan_dataset(vehicle_id);
        let home = self.plan_home_amsl(body, dataset);
        let mut checks = Vec::new();
        let mut coming = false;
        for leg in legs(body) {
            let heights = (
                self.above_home(&body.items[leg.from], home, dataset),
                self.above_home(&body.items[leg.to], home, dataset),
            );
            let (from_m, to_m) = match heights {
                (Ok(a), Ok(b)) => (a, b),
                (Err(Unknown::Coming), _) | (_, Err(Unknown::Coming)) => {
                    coming = true;
                    continue;
                }
                _ => continue,
            };
            let tiles = line_tiles(leg.a, leg.b, CHECK_PAD_M);
            if !self.tiles_here(&tiles) {
                coming = true;
                continue;
            }
            let obstacles = self.obstacles_in(&tiles, leg.a);
            if let Some(height_m) = route::in_the_way(from_m, local(leg.a, leg.b), to_m, &obstacles)
            {
                let number = leg.to + 1;
                checks.push(Check {
                    severity: Severity::Warning,
                    code: "building",
                    item: u32::try_from(number).ok(),
                    message: format!(
                        "the leg to item {number} flies into a building about {height_m:.0} m \
                         tall: ask the agent to route the plan around buildings"
                    ),
                });
            }
        }
        if coming {
            checks.push(Check {
                severity: Severity::Warning,
                code: "buildings-missing",
                item: None,
                message: "the buildings along it are not known yet: fetching them".into(),
            });
        }
        checks
    }

    /// A multicopter plan with waypoints around or over the buildings its
    /// legs fly into: the new body, the legs routed, the waypoints added,
    /// and notes on what was left. An error when it can't be done yet.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn route_plan(
        &mut self,
        body: &PlanBody,
        vehicle_id: Option<&str>,
    ) -> Result<(PlanBody, u32, u32, Vec<String>), String> {
        if body.vehicle_type != PlanVehicleType::Multicopter {
            return Err(
                "only multicopter plans are routed around buildings: other vehicles can't \
                 turn and climb in place like that"
                    .into(),
            );
        }
        if !self.buildings.has_port() {
            return Err("building data isn't available: DroneX's account server is needed".into());
        }
        let dataset = self.plan_dataset(vehicle_id);
        let home = self.plan_home_amsl(body, dataset);
        let coming = || {
            "the buildings or ground along it are still being fetched: try again in a moment"
                .to_owned()
        };
        let mut notes = Vec::new();
        let mut inserts: Vec<(usize, Vec<PlanItem>)> = Vec::new();
        let (mut routed, mut added) = (0u32, 0u32);
        for leg in legs(body) {
            let number = leg.to + 1;
            let (from_item, to_item) = (&body.items[leg.from], &body.items[leg.to]);
            let from_m = match self.above_home(from_item, home, dataset) {
                Ok(h) => h,
                Err(Unknown::Coming) => return Err(coming()),
                Err(Unknown::Height) => continue,
            };
            let to_m = match self.above_home(to_item, home, dataset) {
                Ok(h) => h,
                Err(Unknown::Coming) => return Err(coming()),
                Err(Unknown::Height) => continue,
            };
            let goal = local(leg.a, leg.b);
            let tiles = route::corridor(leg.a, leg.b);
            if !self.tiles_here(&tiles) {
                return Err(coming());
            }
            let obstacles = self.obstacles_in(&tiles, leg.a);
            if route::in_the_way(from_m, goal, to_m, &obstacles).is_none() {
                continue;
            }
            if to_item.pattern.is_some() && to_item.pattern == from_item.pattern {
                notes.push(format!(
                    "The leg to item {number} is inside a pattern, which is made again \
                     from its shape: raise the pattern or move it clear of the buildings."
                ));
                continue;
            }
            let ground = match home {
                Some(home) => {
                    let spacing = vehicle_id.map_or(100, |id| self.terrain_spacing(id));
                    let (ground, pending) = self.ground_grid(dataset, spacing, leg.a, home, goal);
                    if pending {
                        return Err(coming());
                    }
                    ground
                }
                None => Ground::flat(),
            };
            let plan = route::plan(from_m, goal, to_m, &obstacles, &ground);
            if plan.how == How::Straight || plan.legs.len() < 2 {
                continue;
            }
            if let Some(raised) = plan.raised_to_m {
                notes.push(format!(
                    "Item {number} is on a roof or high ground: raise it to about \
                     {raised:.0} m above home."
                ));
            }
            let frame = PlanFrame::from_mav_frame(to_item.frame);
            let mut items = Vec::new();
            for &(e, n, h) in &plan.legs[..plan.legs.len() - 1] {
                let at = global(leg.a, (e, n));
                let altitude_m = match self.in_plan_frame(h, frame, at, home, dataset) {
                    Ok(a) => (a * 10.0).round() / 10.0,
                    Err(Unknown::Coming) => return Err(coming()),
                    Err(Unknown::Height) => {
                        items.clear();
                        break;
                    }
                };
                items.push(PlanItem {
                    command: NAV_WAYPOINT,
                    frame: to_item.frame,
                    params: [Some(0.0), Some(0.0), Some(0.0), None],
                    latitude_deg: (at.0 * 1e7).round() / 1e7,
                    longitude_deg: (at.1 * 1e7).round() / 1e7,
                    altitude_m,
                    autocontinue: true,
                    pattern: None,
                });
            }
            if items.is_empty() {
                notes.push(format!(
                    "The leg to item {number} was left: its heights can't be placed."
                ));
                continue;
            }
            routed += 1;
            added += u32::try_from(items.len()).unwrap_or(u32::MAX);
            inserts.push((leg.to, items));
        }
        let mut out = body.clone();
        for (before, items) in inserts.into_iter().rev() {
            out.items.splice(before..before, items);
        }
        Ok((out, routed, added, notes))
    }
}
