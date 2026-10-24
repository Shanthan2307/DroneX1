//! Go to around buildings (`DroneX`). A simulated copter's Go to is planned
//! before it is sent: straight when nothing is in the way, else around the
//! buildings taller than it flies, else (no way around, or one much longer
//! than the straight line) over them, climbing gently after the start and
//! coming down gently before the end. The engine flies the plan as short
//! GUIDED legs, sending the next as each is reached; any other command, or
//! a mode other than GUIDED, ends it.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap};

use uxduck_core::domain::command::{Command, GoToHeading};
use uxduck_core::domain::notification::{NotificationKind, Severity, Subject};
use uxduck_core::domain::telemetry::AltitudeFrame;
use uxduck_terrain::grid;
use uxduck_terrain::lookup::{Ground as Surface, nearest_metre};

use crate::Engine;
use crate::buildings::{self, Building, global, inside, local, segment_distance};
use crate::commands::Raise;

/// How far the route keeps from a wall, and above a roof.
pub const SIDE_M: f64 = 5.0;
pub const ABOVE_M: f64 = 10.0;
/// Metres up for each metre along while climbing over, and coming down.
const SLOPE: f64 = 0.5;
/// `ArduCopter`'s default speeds in GUIDED (`WPNAV_SPEED`, `_UP`, `_DN`):
/// how long a plan takes, to choose between around and over.
const ALONG_MPS: f64 = 10.0;
const UP_MPS: f64 = 2.5;
const DOWN_MPS: f64 = 1.5;
/// How far around the straight line the search looks, at most.
const PAD_MAX_M: f64 = 400.0;
const PAD_MIN_M: f64 = 60.0;
const CELL_MIN_M: f64 = 3.0;
const CELLS_MAX: f64 = 250_000.0;
/// Longer Go tos are flown straight, with only the guard.
pub const LONGEST_M: f64 = 5_000.0;
/// A leg counts as reached this close, sideways and up.
const REACH_SIDE_M: f64 = 4.0;
const REACH_UP_M: f64 = 3.0;
/// A route waits this long for its buildings, then flies with what it has.
const WAIT_US: u64 = 60_000_000;
/// A just-sent leg may take this long to show GUIDED.
const MODE_GRACE_US: u64 = 4_000_000;

/// A building as the planner sees it: corners in local metres, and height.
#[derive(Debug)]
pub struct Obstacle {
    pub ring: Vec<(f64, f64)>,
    pub height_m: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum How {
    Straight,
    /// Around the buildings in the way, after climbing straight up to
    /// `cruise_m` above the lower ones, if it does.
    Around {
        buildings: usize,
        cruise_m: Option<f64>,
    },
    /// Over everything in the way.
    Over {
        cruise_m: f64,
    },
}

/// A plan: points in local metres east and north, with their height above
/// the ground, ending at the destination. The start is not one of them.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub legs: Vec<(f64, f64, f64)>,
    pub how: How,
    /// The destination's height was raised to clear a roof.
    pub raised_to_m: Option<f64>,
}

/// The closest a point comes to a polygon's outline; 0 inside it.
fn clearance(p: (f64, f64), ring: &[(f64, f64)]) -> f64 {
    segment_distance(p, p, ring)
}

/// How far the route keeps above the terrain. The simulator's ground is
/// a 30 m surface model that takes in rooftops, blurred: near a tower it is
/// solid well above the street, and a copter flying there is stuck on it.
pub const GROUND_ABOVE_M: f64 = 6.0;

/// Ground heights above home; unknown points read as far below.
#[derive(Debug, Default)]
pub struct Ground {
    kind: Kind,
}

#[derive(Debug, Default)]
enum Kind {
    #[default]
    Flat,
    /// Every `step` metres from `origin`, `w` columns, row after row: the
    /// highest of the four around a place counts.
    Raster {
        origin: (f64, f64),
        step: f64,
        w: usize,
        heights: Vec<f64>,
    },
    /// ArduPilot's terrain grid (`grid.rs`) around `origin`, interpolated
    /// as the autopilot and its simulator do: what a simulated copter
    /// actually stands on.
    Grid {
        origin: (f64, f64),
        spacing: u16,
        heights: HashMap<(i32, i32), f64>,
    },
}

/// The four terrain grid points around a place, as `[h00, h01, h10, h11]`
/// wants them, and where the place is between them.
pub(crate) fn corners(lat: f64, lon: f64, spacing: u16) -> (grid::GridInfo, [(i32, i32); 4]) {
    #[allow(clippy::cast_possible_truncation)]
    let info = grid::grid_info(
        (lat * 1e7).round() as i32,
        (lon * 1e7).round() as i32,
        spacing,
    );
    let s = f64::from(spacing);
    let (n, e) = (f64::from(info.idx_x) * s, f64::from(info.idx_y) * s);
    let at = |dn: f64, de: f64| grid::offset(info.grid_lat, info.grid_lon, n + dn, e + de);
    (info, [at(0.0, 0.0), at(0.0, s), at(s, 0.0), at(s, s)])
}

impl Ground {
    /// No terrain: only buildings count.
    #[must_use]
    pub fn flat() -> Self {
        Self::default()
    }

    /// `w` columns from `origin` every `step` metres, row after row.
    #[must_use]
    pub fn new(origin: (f64, f64), step: f64, w: usize, heights: Vec<f64>) -> Self {
        Self {
            kind: Kind::Raster {
                origin,
                step,
                w,
                heights,
            },
        }
    }

    /// The heights of terrain grid points (`corners`), above home, around
    /// `origin` (latitude, longitude).
    pub(crate) fn grid(
        origin: (f64, f64),
        spacing: u16,
        heights: HashMap<(i32, i32), f64>,
    ) -> Self {
        Self {
            kind: Kind::Grid {
                origin,
                spacing,
                heights,
            },
        }
    }

    /// The ground at a place, local metres.
    #[must_use]
    pub fn at(&self, p: (f64, f64)) -> f64 {
        match &self.kind {
            Kind::Flat => f64::NEG_INFINITY,
            Kind::Raster {
                origin,
                step,
                w,
                heights,
            } => raster_at(*origin, *step, *w, heights, p),
            Kind::Grid {
                origin,
                spacing,
                heights,
            } => {
                let (lat, lon) = global(*origin, p);
                let (info, points) = corners(lat, lon, *spacing);
                let mut four = [0.0f32; 4];
                for (h, point) in four.iter_mut().zip(points) {
                    let Some(&m) = heights.get(&point) else {
                        return f64::NEG_INFINITY;
                    };
                    #[allow(clippy::cast_possible_truncation)]
                    {
                        *h = m as f32;
                    }
                }
                f64::from(grid::interpolate(&info, four))
            }
        }
    }

    /// The highest ground along a line.
    #[allow(clippy::many_single_char_names)]
    fn along(&self, a: (f64, f64), b: (f64, f64)) -> f64 {
        let d = (b.0 - a.0).hypot(b.1 - a.1);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = (d / 5.0).ceil() as usize;
        (0..=n)
            .map(|k| {
                #[allow(clippy::cast_precision_loss)]
                let t = if n == 0 { 0.0 } else { k as f64 / n as f64 };
                self.at((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t))
            })
            .fold(f64::NEG_INFINITY, f64::max)
    }
}

#[allow(clippy::many_single_char_names)]
fn raster_at(origin: (f64, f64), step: f64, w: usize, heights: &[f64], p: (f64, f64)) -> f64 {
    if w == 0 || step <= 0.0 {
        return f64::NEG_INFINITY;
    }
    let h = heights.len() / w;
    let (x, y) = ((p.0 - origin.0) / step, (p.1 - origin.1) / step);
    let mut top = f64::NEG_INFINITY;
    for (i, j) in [
        (x.floor(), y.floor()),
        (x.ceil(), y.floor()),
        (x.floor(), y.ceil()),
        (x.ceil(), y.ceil()),
    ] {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        if i >= 0.0 && j >= 0.0 && (i as usize) < w && (j as usize) < h {
            top = top.max(heights[j as usize * w + i as usize]);
        }
    }
    top
}

/// The area a plan's search covers, in local metres: low and high corners.
#[must_use]
pub fn search_area(goal: (f64, f64)) -> ((f64, f64), (f64, f64)) {
    let length = goal.0.hypot(goal.1);
    let pad = (0.6 * length).clamp(PAD_MIN_M, PAD_MAX_M);
    (
        (goal.0.min(0.0) - pad, goal.1.min(0.0) - pad),
        (goal.0.max(0.0) + pad, goal.1.max(0.0) + pad),
    )
}

/// The tallest building that a straight leg from (0, 0) at `from_m` to
/// `goal` at `to_m` flies into or within `SIDE_M` of, if any: what `plan`
/// would not fly straight, by buildings alone.
#[must_use]
pub fn in_the_way(from_m: f64, goal: (f64, f64), to_m: f64, obstacles: &[Obstacle]) -> Option<f64> {
    let start = (0.0, 0.0);
    obstacles
        .iter()
        .filter(|o| o.height_m + ABOVE_M > from_m.min(to_m) && !inside(start, &o.ring))
        .filter(|o| {
            let ends = clearance(start, &o.ring).min(clearance(goal, &o.ring));
            segment_distance(start, goal, &o.ring) < SIDE_M.min(ends - 0.1)
        })
        .map(|o| o.height_m)
        .reduce(f64::max)
}

/// At most this many cruise heights are tried.
const HEIGHTS: usize = 6;

/// Plans from (0, 0) at `from_m` to `goal` at `to_m`, heights above ground.
/// It tries going around at a few cruise heights (as low as it flies, and
/// just above each building on the straight line, the highest being over
/// them all) and keeps the quickest.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn plan(
    from_m: f64,
    goal: (f64, f64),
    to_m: f64,
    obstacles: &[Obstacle],
    ground: &Ground,
) -> Plan {
    let start = (0.0, 0.0);
    let mut to_m = to_m;
    let mut raised_to_m = None;
    // A destination into the ground: stop above it.
    if ground.at(goal) + GROUND_ABOVE_M > to_m {
        to_m = ground.at(goal) + GROUND_ABOVE_M;
        raised_to_m = Some(to_m);
    }
    // A destination on a roof taller than asked: stop above it.
    for o in obstacles {
        if inside(goal, &o.ring) && o.height_m + ABOVE_M > to_m {
            to_m = o.height_m + ABOVE_M;
            raised_to_m = Some(to_m);
        }
    }
    let low_m = from_m.min(to_m);
    // Taller than `h`, and so to be kept clear of. One it is already
    // inside, too low, is left out: it can only get out.
    let taller = |h: f64| {
        obstacles
            .iter()
            .filter(move |o| o.height_m + ABOVE_M > h && !inside(start, &o.ring))
    };
    let in_the_way = |o: &&Obstacle| {
        // No closer than it already is at either end.
        let ends = clearance(start, &o.ring).min(clearance(goal, &o.ring));
        segment_distance(start, goal, &o.ring) < SIDE_M.min(ends - 0.1)
    };
    // The ground on the straight line, away from the ends: the start's is
    // below it, and the end's is cleared above.
    let ground_m = {
        let length = goal.0.hypot(goal.1);
        if length > 2.0 * SIDE_M {
            let (a, b) = (SIDE_M / length, 1.0 - SIDE_M / length);
            ground.along((goal.0 * a, goal.1 * a), (goal.0 * b, goal.1 * b)) + GROUND_ABOVE_M
        } else {
            f64::NEG_INFINITY
        }
    };
    let mut heights: Vec<f64> = taller(low_m)
        .filter(in_the_way)
        .map(|o| o.height_m + ABOVE_M)
        .chain((ground_m > low_m).then_some(ground_m))
        .map(|h| h.max(from_m.max(to_m)))
        .collect();
    if heights.is_empty() {
        return Plan {
            legs: vec![(goal.0, goal.1, to_m)],
            how: How::Straight,
            raised_to_m,
        };
    }
    heights.push(low_m);
    heights.sort_by(f64::total_cmp);
    heights.dedup_by(|a, b| *a - *b < 1.0);
    if heights.len() > HEIGHTS {
        let n = heights.len() - 1;
        heights = (0..HEIGHTS)
            .map(|k| heights[k * n / (HEIGHTS - 1)])
            .collect();
    }
    heights
        .into_iter()
        .filter_map(|h| {
            let blocking: Vec<&Obstacle> = taller(h).collect();
            let in_way = blocking.iter().filter(|o| in_the_way(o)).count();
            if in_way == 0 && ground_m <= h {
                return Some(over(from_m, goal, to_m, obstacles, ground, h));
            }
            let path = around(goal, &blocking, ground, h)?;
            let legs = if h <= low_m {
                // As low as it flies: changing height on the way is safe.
                let along: f64 = path
                    .windows(2)
                    .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1))
                    .sum();
                let mut gone = 0.0;
                path.windows(2)
                    .map(|w| {
                        gone += (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1);
                        let k = if along > 0.0 { gone / along } else { 1.0 };
                        (w[1].0, w[1].1, from_m + (to_m - from_m) * k)
                    })
                    .collect()
            } else {
                // Straight up, around at `h`, and straight down.
                let mut legs = Vec::new();
                if h - from_m > 1.0 {
                    legs.push((0.0, 0.0, h));
                }
                legs.extend(path.iter().skip(1).map(|p| (p.0, p.1, h)));
                if h - to_m > 1.0 {
                    legs.push((goal.0, goal.1, to_m));
                }
                legs
            };
            Some(Plan {
                legs,
                how: How::Around {
                    buildings: in_way,
                    cruise_m: (h > low_m).then_some(h),
                },
                raised_to_m,
            })
        })
        .min_by(|a, b| seconds(from_m, &a.legs).total_cmp(&seconds(from_m, &b.legs)))
        .map(|mut plan| {
            plan.raised_to_m = raised_to_m;
            plan
        })
        // Nothing found, not even over: straight, and the guard watches.
        .unwrap_or(Plan {
            legs: vec![(goal.0, goal.1, to_m)],
            how: How::Straight,
            raised_to_m,
        })
}

/// Roughly how long legs take to fly, from (0, 0) at `from_m`.
fn seconds(from_m: f64, legs: &[(f64, f64, f64)]) -> f64 {
    let mut at = (0.0, 0.0, from_m);
    legs.iter()
        .map(|&leg| {
            let side = (leg.0 - at.0).hypot(leg.1 - at.1) / ALONG_MPS;
            let up = leg.2 - at.2;
            let vertical = if up > 0.0 {
                up / UP_MPS
            } else {
                -up / DOWN_MPS
            };
            at = leg;
            side.max(vertical)
        })
        .sum()
}

/// Straight over the buildings on the line at `cruise_m`: climb gently to
/// it, cruise, and come down gently to the destination's height.
fn over(
    from_m: f64,
    goal: (f64, f64),
    to_m: f64,
    obstacles: &[Obstacle],
    ground: &Ground,
    cruise_m: f64,
) -> Plan {
    let length = goal.0.hypot(goal.1);
    let near: Vec<&Obstacle> = obstacles
        .iter()
        .filter(|o| segment_distance((0.0, 0.0), goal, &o.ring) < SIDE_M)
        .filter(|o| !inside((0.0, 0.0), &o.ring))
        .collect();
    // Where along the line the first building it must climb for begins,
    // and where the last one it must come down after ends.
    let (mut first, mut last) = (length, 0.0_f64);
    let step = 2.0;
    let mut x = 0.0;
    while x <= length {
        let p = (goal.0 * x / length, goal.1 * x / length);
        let rise = ground.at(p) + GROUND_ABOVE_M;
        if x > SIDE_M && rise > from_m {
            first = first.min(x);
        }
        if x < length - SIDE_M && rise > to_m {
            last = last.max(x);
        }
        for o in &near {
            if clearance(p, &o.ring) < SIDE_M {
                if o.height_m + ABOVE_M > from_m {
                    first = first.min(x);
                }
                if o.height_m + ABOVE_M > to_m {
                    last = last.max(x);
                }
            }
        }
        x += step;
    }
    // Gently along the way when there is room, else straight up at the
    // start and straight down at the end: never steeply.
    let gentle = |rise: f64, room: f64| {
        let along = rise.max(0.0) / SLOPE;
        if along <= room { along } else { 0.0 }
    };
    let mut up = gentle(cruise_m - from_m, first - step);
    let mut down = gentle(cruise_m - to_m, length - last - step);
    if up + down > length {
        let k = length / (up + down);
        up *= k;
        down *= k;
    }
    let at = |x: f64| (goal.0 * x / length, goal.1 * x / length);
    let mut legs = Vec::new();
    if cruise_m - from_m > 1.0 {
        // Too close to climb along the way: straight up first.
        let p = if up < 5.0 { (0.0, 0.0) } else { at(up) };
        legs.push((p.0, p.1, cruise_m));
    }
    if length - down > up + 1.0 {
        let p = at(length - down);
        legs.push((p.0, p.1, cruise_m));
    }
    if down < 5.0 && cruise_m - to_m > 1.0 {
        legs.push((goal.0, goal.1, cruise_m));
    }
    legs.push((goal.0, goal.1, to_m));
    Plan {
        legs,
        how: How::Over { cruise_m },
        raised_to_m: None,
    }
}

/// The shortest way around, on a grid: corners in local metres from (0, 0)
/// to `goal`, or none.
#[allow(
    clippy::many_single_char_names,
    clippy::too_many_lines,
    clippy::cast_precision_loss
)]
fn around(
    goal: (f64, f64),
    blockers: &[&Obstacle],
    ground: &Ground,
    cruise_m: f64,
) -> Option<Vec<(f64, f64)>> {
    let ((x0, y0), (x1, y1)) = search_area(goal);
    let cell = CELL_MIN_M.max(((x1 - x0) * (y1 - y0) / CELLS_MAX).sqrt());
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (w, h) = (
        ((x1 - x0) / cell).ceil() as usize + 1,
        ((y1 - y0) / cell).ceil() as usize + 1,
    );
    #[allow(clippy::cast_precision_loss)]
    let centre = |i: usize, j: usize| (x0 + i as f64 * cell, y0 + j as f64 * cell);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let index = |p: (f64, f64)| {
        let i = ((p.0 - x0) / cell).round().clamp(0.0, (w - 1) as f64) as usize;
        let j = ((p.1 - y0) / cell).round().clamp(0.0, (h - 1) as f64) as usize;
        (i, j)
    };
    let mut blocked = vec![false; w * h];
    let mut solid = vec![false; w * h];
    // Ground higher than it flies is as solid as a building.
    for j in 0..h {
        for i in 0..w {
            // Not `solid`: right at the ends it is where it is, or is raised.
            if ground.at(centre(i, j)) + GROUND_ABOVE_M > cruise_m {
                blocked[j * w + i] = true;
            }
        }
    }
    for o in blockers {
        let (mut lo, mut hi) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
        for &(x, y) in &o.ring {
            lo = (lo.0.min(x), lo.1.min(y));
            hi = (hi.0.max(x), hi.1.max(y));
        }
        let (i0, j0) = index((lo.0 - SIDE_M - cell, lo.1 - SIDE_M - cell));
        let (i1, j1) = index((hi.0 + SIDE_M + cell, hi.1 + SIDE_M + cell));
        for j in j0..=j1 {
            for i in i0..=i1 {
                let p = centre(i, j);
                if inside(p, &o.ring) {
                    blocked[j * w + i] = true;
                    solid[j * w + i] = true;
                } else if clearance(p, &o.ring) < SIDE_M {
                    blocked[j * w + i] = true;
                }
            }
        }
    }
    // The ends may sit within the margin of a wall: let it leave and arrive.
    for end in [(0.0, 0.0), goal] {
        let (ci, cj) = index(end);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let r = (SIDE_M / cell).ceil() as usize + 1;
        for j in cj.saturating_sub(r)..=(cj + r).min(h - 1) {
            for i in ci.saturating_sub(r)..=(ci + r).min(w - 1) {
                let p = centre(i, j);
                if (p.0 - end.0).hypot(p.1 - end.1) <= SIDE_M + cell && !solid[j * w + i] {
                    blocked[j * w + i] = false;
                }
            }
        }
    }
    let (si, sj) = index((0.0, 0.0));
    let (gi, gj) = index(goal);
    let (s, g) = (sj * w + si, gj * w + gi);
    if blocked[s] || blocked[g] {
        return None;
    }
    // A* over eight neighbours, costs in millimetres.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let mm = |m: f64| (m * 1000.0) as u64;
    let guess = |n: usize| {
        let (dx, dy) = ((n % w).abs_diff(gi), (n / w).abs_diff(gj));
        let (a, b) = (dx.max(dy), dx.min(dy));
        #[allow(clippy::cast_precision_loss)]
        mm(((a - b) as f64 + b as f64 * std::f64::consts::SQRT_2) * cell)
    };
    let mut cost = vec![u64::MAX; w * h];
    let mut came = vec![usize::MAX; w * h];
    let mut open = BinaryHeap::new();
    cost[s] = 0;
    open.push(Reverse((guess(s), s)));
    while let Some(Reverse((_, n))) = open.pop() {
        if n == g {
            break;
        }
        let (i, j) = (n % w, n / w);
        for (di, dj) in [
            (-1, 0),
            (1, 0),
            (0, -1),
            (0, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
            (1, 1),
        ] {
            let (Some(ni), Some(nj)) = (i.checked_add_signed(di), j.checked_add_signed(dj)) else {
                continue;
            };
            if ni >= w || nj >= h {
                continue;
            }
            let m = nj * w + ni;
            if blocked[m] {
                continue;
            }
            let step = if di != 0 && dj != 0 {
                mm(cell * std::f64::consts::SQRT_2)
            } else {
                mm(cell)
            };
            let c = cost[n] + step;
            if c < cost[m] {
                cost[m] = c;
                came[m] = n;
                open.push(Reverse((c + guess(m), m)));
            }
        }
    }
    if cost[g] == u64::MAX {
        return None;
    }
    let mut cells = vec![g];
    while let Some(&n) = cells.last()
        && n != s
    {
        cells.push(came[n]);
    }
    cells.reverse();
    let mut points: Vec<(f64, f64)> = cells.iter().map(|&n| centre(n % w, n / w)).collect();
    points[0] = (0.0, 0.0);
    *points.last_mut().unwrap_or(&mut (0.0, 0.0)) = goal;
    // Pull the string: keep only the corners it can't see past.
    let clear = |a: (f64, f64), b: (f64, f64)| {
        let d = (b.0 - a.0).hypot(b.1 - a.1);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = (d / (cell * 0.5)).ceil() as usize;
        (0..=n).all(|k| {
            #[allow(clippy::cast_precision_loss)]
            let t = if n == 0 { 0.0 } else { k as f64 / n as f64 };
            let (i, j) = index((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
            !blocked[j * w + i]
        })
    };
    let mut kept = vec![points[0]];
    let mut from = 0;
    while from < points.len() - 1 {
        let mut to = points.len() - 1;
        while to > from + 1 && !clear(points[from], points[to]) {
            to -= 1;
        }
        kept.push(points[to]);
        from = to;
    }
    Some(kept)
}

/// A Go to being flown as legs.
pub(crate) struct Route {
    frame: AltitudeFrame,
    heading: Option<GoToHeading>,
    /// The destination, in the Go to's own frame.
    destination: (f64, f64, f64),
    /// Latitude, longitude and height in `frame`.
    legs: Vec<(f64, f64, f64)>,
    /// The leg being flown.
    next: usize,
    sent_at_us: u64,
    /// Tiles it was planned without; replanned when they arrive.
    waiting: BTreeSet<(u32, u32)>,
    /// Planned before some of the ground's heights had arrived.
    terrain_pending: bool,
    waiting_since_us: u64,
    /// What it last told the operator, so a replan says only what changed.
    announced: Option<How>,
}

impl Route {
    /// How far the current leg is from a place, in metres; for the guard.
    pub(crate) fn leg_distance(&self, lat: f64, lon: f64) -> f64 {
        let (e, n) = local((lat, lon), (self.legs[self.next].0, self.legs[self.next].1));
        e.hypot(n)
    }
}

/// The tiles a Go to's search covers.
pub(crate) fn corridor(from: (f64, f64), goal: (f64, f64)) -> BTreeSet<(u32, u32)> {
    let (e, n) = local(from, goal);
    let length = e.hypot(n);
    let pad = (0.6 * length).clamp(PAD_MIN_M, PAD_MAX_M);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let steps = (length / 200.0).ceil() as usize + 1;
    (0..=steps)
        .flat_map(|k| {
            #[allow(clippy::cast_precision_loss)]
            let t = k as f64 / steps as f64;
            let p = global(from, (e * t, n * t));
            Engine::tiles_around(p.0, p.1, pad)
        })
        .collect()
}

fn command(leg: (f64, f64, f64), frame: AltitudeFrame, heading: Option<GoToHeading>) -> Command {
    Command::GoTo {
        latitude_deg: leg.0,
        longitude_deg: leg.1,
        altitude_m: leg.2,
        altitude_frame: frame,
        heading,
    }
}

impl Engine {
    /// A Go to is about to be sent: plan it, and answer the first leg to
    /// send instead, if any. Any earlier route of the vehicle ends.
    pub(crate) fn route_go_to(&mut self, vehicle_id: &str, command: &Command) -> Option<Command> {
        self.buildings.routes.remove(vehicle_id);
        let Command::GoTo {
            latitude_deg,
            longitude_deg,
            altitude_m,
            altitude_frame,
            heading,
        } = command.clone()
        else {
            return None;
        };
        if !self.buildings.has_port() || !self.simulated_copter(vehicle_id) {
            return None;
        }
        let now = self.clock.now_us();
        let route = Route {
            frame: altitude_frame,
            heading,
            destination: (latitude_deg, longitude_deg, altitude_m),
            legs: Vec::new(),
            next: 0,
            sent_at_us: now,
            waiting: BTreeSet::new(),
            terrain_pending: false,
            waiting_since_us: now,
            announced: None,
        };
        let (route, first) = self.replan(vehicle_id, route)?;
        if let Some(route) = route {
            self.buildings.routes.insert(vehicle_id.to_owned(), route);
        }
        Some(first)
    }

    /// Plans a route from where the vehicle is now: the first leg to send,
    /// and the route to follow, if there is more than that leg to it. None
    /// when it can't be planned, and the Go to is sent as it is.
    fn replan(&mut self, vehicle_id: &str, mut route: Route) -> Option<(Option<Route>, Command)> {
        let fix = self
            .telemetry(vehicle_id)
            .and_then(|t| buildings::fix(&t.positions))?;
        // Heights in the Go to's frame, less the height above ground.
        let offset_m = fix.in_frame(route.frame)? - fix.agl_m;
        let here = (fix.lat, fix.lon);
        let (lat, lon, alt) = route.destination;
        let goal = local(here, (lat, lon));
        if goal.0.hypot(goal.1) > LONGEST_M {
            return None;
        }
        let tiles = corridor(here, (lat, lon));
        for &tile in &tiles {
            self.want_tile(tile);
        }
        let now = self.clock.now_us();
        route.waiting = if now.saturating_sub(route.waiting_since_us) < WAIT_US {
            tiles
                .iter()
                .copied()
                .filter(|t| !self.buildings.ready(*t))
                .collect()
        } else {
            BTreeSet::new()
        };
        let obstacles: Vec<Obstacle> = self
            .buildings
            .in_tiles(&tiles)
            .into_iter()
            .map(|b: &Building| Obstacle {
                ring: b.local(here),
                height_m: b.height_m,
            })
            .collect();
        let (ground, terrain_pending) = self.ground_around(vehicle_id, &fix, goal);
        route.terrain_pending =
            terrain_pending && now.saturating_sub(route.waiting_since_us) < WAIT_US;
        let plan = plan(fix.agl_m, goal, alt - offset_m, &obstacles, &ground);
        route.legs = plan
            .legs
            .iter()
            .map(|&(e, n, h)| {
                let (lat, lon) = global(here, (e, n));
                (lat, lon, h + offset_m)
            })
            .collect();
        if let Some(last) = route.legs.last_mut() {
            // The destination exactly as asked, unless raised above a roof.
            last.0 = lat;
            last.1 = lon;
            if plan.raised_to_m.is_none() {
                last.2 = alt;
            }
        }
        route.next = 0;
        route.sent_at_us = now;
        if route.announced != Some(plan.how) {
            route.announced = Some(plan.how);
            self.announce(vehicle_id, &plan, offset_m);
        }
        let first = command(route.legs[0], route.frame, route.heading);
        // Straight there, with everything known: nothing to follow.
        let follow = route.legs.len() > 1 || !route.waiting.is_empty() || route.terrain_pending;
        Some((follow.then_some(route), first))
    }

    /// The ground around a Go to, above home, from the terrain the vehicle
    /// uses (a simulator's is the same), and whether some is still coming.
    fn ground_around(
        &mut self,
        vehicle_id: &str,
        fix: &buildings::Fix,
        goal: (f64, f64),
    ) -> (Ground, bool) {
        // Heights are compared above home; without both, buildings only.
        let (Some(amsl), Some(home)) = (
            fix.in_frame(AltitudeFrame::Amsl),
            fix.in_frame(AltitudeFrame::AboveHome),
        ) else {
            return (Ground::flat(), false);
        };
        let dataset = self.terrain_dataset_of(vehicle_id);
        let spacing = self.terrain_spacing(vehicle_id);
        self.ground_grid(dataset, spacing, (fix.lat, fix.lon), amsl - home, goal)
    }

    /// The ground around a plan from `here` to `goal` (local metres), above
    /// a home `home_amsl` above sea level, on the vehicle's terrain grid as
    /// Core answers it (to the metre), and whether some is still coming.
    pub(crate) fn ground_grid(
        &mut self,
        dataset: uxduck_terrain::Dataset,
        spacing: u16,
        here: (f64, f64),
        home_amsl: f64,
        goal: (f64, f64),
    ) -> (Ground, bool) {
        let now = self.clock.now_us();
        let ((x0, y0), (x1, y1)) = search_area(goal);
        let step = f64::from(spacing.max(10)) / 2.0;
        let mut points = BTreeSet::new();
        let mut y = y0 - step;
        while y <= y1 + step {
            let mut x = x0 - step;
            while x <= x1 + step {
                let (lat, lon) = global(here, (x, y));
                points.extend(corners(lat, lon, spacing).1);
                x += step;
            }
            y += step;
        }
        let Some(cache) = self.terrain.cache.as_mut() else {
            return (Ground::flat(), false);
        };
        let mut pending = false;
        let mut heights = HashMap::new();
        for (lat, lon) in points {
            let at = (f64::from(lat) * 1e-7, f64::from(lon) * 1e-7);
            match cache.at(dataset, at.0, at.1, now).map(|a| a.ground) {
                None => pending = true,
                Some(Ok(Surface::Height(g))) => {
                    heights.insert((lat, lon), f64::from(nearest_metre(g)) - home_amsl);
                }
                Some(Ok(Surface::Sea)) => {
                    heights.insert((lat, lon), -home_amsl);
                }
                Some(_) => {}
            }
        }
        self.terrain_flush();
        (Ground::grid(here, spacing, heights), pending)
    }

    fn announce(&mut self, vehicle_id: &str, plan: &Plan, offset_m: f64) {
        let Some(name) = self.vehicle(vehicle_id).map(|v| v.name.clone()) else {
            return;
        };
        let raised = plan.raised_to_m.map(|h| {
            format!(
                " Its destination is on a roof or high ground, so it will stop {:.0} m up.",
                h + offset_m
            )
        });
        let (title, body) = match plan.how {
            How::Straight if raised.is_none() => return,
            How::Straight => (format!("{name} will stop higher than asked"), String::new()),
            How::Around {
                buildings,
                cruise_m,
            } => (
                format!("{name} is going around buildings"),
                format!(
                    "{}{buildings} building{} taller than {} {} in the way, so it \
                     takes a way around {}.",
                    cruise_m.map_or(String::new(), |h| format!(
                        "It climbs to {:.0} m, above the lower buildings. ",
                        h + offset_m
                    )),
                    if buildings == 1 { "" } else { "s" },
                    if cruise_m.is_some() {
                        "that"
                    } else {
                        "it flies"
                    },
                    if buildings == 1 { "is" } else { "are" },
                    if buildings == 1 { "it" } else { "them" },
                ),
            ),
            How::Over { cruise_m } => (
                format!("{name} is climbing over buildings"),
                format!(
                    "There is no short way around the buildings in the way, so it \
                     climbs gently to {:.0} m, crosses above them, and comes down \
                     gently to the height you asked for.",
                    cruise_m + offset_m
                ),
            ),
        };
        self.raise(Raise {
            severity: Severity::Info,
            kind: NotificationKind::Transient,
            subject: Subject::Vehicle {
                id: vehicle_id.to_owned(),
            },
            title,
            body: Some(
                format!("{body}{}", raised.unwrap_or_default())
                    .trim()
                    .to_owned(),
            ),
            actions: Vec::new(),
            condition: None,
            report: None,
        });
    }

    /// Telemetry arrived for a simulated copter on a route: send the next
    /// leg when this one is reached, replan when its buildings arrive, and
    /// end it when the vehicle is flown some other way.
    pub(crate) fn follow_route(&mut self, vehicle_id: &str) {
        let Some(route) = self.buildings.routes.get(vehicle_id) else {
            return;
        };
        let now = self.clock.now_us();
        let mode = self
            .vehicle(vehicle_id)
            .and_then(|v| v.mode.clone())
            .unwrap_or_default();
        let armed = self.vehicle(vehicle_id).is_some_and(|v| v.armed);
        if !armed
            || (!mode.eq_ignore_ascii_case("GUIDED") && now > route.sent_at_us + MODE_GRACE_US)
        {
            self.buildings.routes.remove(vehicle_id);
            return;
        }
        if !route.waiting.is_empty() || route.terrain_pending {
            let tiles_in = route.waiting.iter().all(|t| self.buildings.ready(*t));
            // The ground is looked at again every few seconds.
            let terrain_in = !route.terrain_pending || now > route.sent_at_us + 2_000_000;
            let late = now > route.waiting_since_us + WAIT_US;
            if (tiles_in && terrain_in) || late {
                let Some(route) = self.buildings.routes.remove(vehicle_id) else {
                    return;
                };
                // Planned again with every building, or with what came.
                if let Some((route, first)) = self.replan(vehicle_id, route) {
                    if let Some(route) = route {
                        self.buildings.routes.insert(vehicle_id.to_owned(), route);
                    }
                    self.send_as_building_guard(vehicle_id, first);
                }
                return;
            }
        }
        let Some(fix) = self
            .telemetry(vehicle_id)
            .and_then(|t| buildings::fix(&t.positions))
        else {
            return;
        };
        if route.next + 1 >= route.legs.len() {
            return;
        }
        let leg = route.legs[route.next];
        let Some(height) = fix.in_frame(route.frame) else {
            return;
        };
        let side = route.leg_distance(fix.lat, fix.lon);
        let speed = fix.velocity.0.hypot(fix.velocity.1);
        if side > REACH_SIDE_M.max(0.8 * speed) || (height - leg.2).abs() > REACH_UP_M {
            return;
        }
        let Some(route) = self.buildings.routes.get_mut(vehicle_id) else {
            return;
        };
        route.next += 1;
        route.sent_at_us = now;
        let order = command(route.legs[route.next], route.frame, route.heading);
        if route.next + 1 == route.legs.len() && route.waiting.is_empty() && !route.terrain_pending
        {
            // The last leg: the autopilot finishes it on its own.
            self.buildings.routes.remove(vehicle_id);
        }
        self.send_as_building_guard(vehicle_id, order);
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    /// A square building centred at (x, y), `side` metres across.
    fn block(x: f64, y: f64, side: f64, height_m: f64) -> Obstacle {
        let s = side / 2.0;
        Obstacle {
            ring: vec![
                (x - s, y - s),
                (x + s, y - s),
                (x + s, y + s),
                (x - s, y + s),
            ],
            height_m,
        }
    }

    fn clear_of(plan: &Plan, from_m: f64, obstacles: &[Obstacle]) -> bool {
        let mut at = (0.0, 0.0, from_m);
        plan.legs.iter().all(|&leg| {
            let ok = obstacles.iter().all(|o| {
                let low = at.2.min(leg.2);
                low >= o.height_m + ABOVE_M - 1e-6
                    || segment_distance((at.0, at.1), (leg.0, leg.1), &o.ring) >= SIDE_M - 1.0
            });
            at = leg;
            ok
        })
    }

    #[test]
    fn nothing_in_the_way_goes_straight() {
        let city = [block(0.0, 100.0, 40.0, 200.0)];
        let p = plan(30.0, (200.0, 0.0), 30.0, &city, &Ground::flat());
        assert_eq!(p.how, How::Straight);
        assert_eq!(p.legs, vec![(200.0, 0.0, 30.0)]);
        // Lower buildings don't count.
        let low = [block(100.0, 0.0, 40.0, 15.0)];
        assert_eq!(
            plan(30.0, (200.0, 0.0), 30.0, &low, &Ground::flat()).how,
            How::Straight
        );
    }

    #[test]
    fn a_tower_in_the_way_is_gone_around() {
        let city = [block(100.0, 0.0, 40.0, 200.0)];
        let p = plan(30.0, (200.0, 0.0), 30.0, &city, &Ground::flat());
        assert_eq!(
            p.how,
            How::Around {
                buildings: 1,
                cruise_m: None
            }
        );
        assert!(p.legs.len() >= 2);
        assert_eq!(*p.legs.last().unwrap(), (200.0, 0.0, 30.0));
        assert!(clear_of(&p, 30.0, &city));
    }

    #[test]
    fn a_wall_with_no_short_way_round_is_climbed_over_gently() {
        // A row of buildings 600 m long across the way.
        let city: Vec<Obstacle> = (-6..=6)
            .map(|k| block(150.0, f64::from(k) * 50.0, 50.0, 60.0))
            .collect();
        let p = plan(30.0, (400.0, 0.0), 30.0, &city, &Ground::flat());
        let How::Over { cruise_m } = p.how else {
            panic!("{:?}", p.how)
        };
        assert!((cruise_m - 70.0).abs() < 1e-9);
        assert!(clear_of(&p, 30.0, &city));
        assert_eq!(*p.legs.last().unwrap(), (400.0, 0.0, 30.0));
        // Up 40 m over 80 m before the wall, and down 40 m over 80 m after.
        assert_eq!(p.legs.len(), 3);
        assert!((p.legs[0].0 - 80.0).abs() < 1e-6 && p.legs[0].2 == cruise_m);
        assert!((p.legs[1].0 - 320.0).abs() < 1e-6 && p.legs[1].2 == cruise_m);
    }

    #[test]
    fn a_very_tall_tower_is_gone_around_even_the_long_way() {
        // Going around is more than 1.5 times as long, but far quicker than
        // climbing 300 m.
        let city = [block(70.0, 0.0, 100.0, 300.0)];
        let p = plan(30.0, (140.0, 0.0), 30.0, &city, &Ground::flat());
        assert_eq!(
            p.how,
            How::Around {
                buildings: 1,
                cruise_m: None
            }
        );
        assert!(clear_of(&p, 30.0, &city));
    }

    #[test]
    fn right_beside_a_wall_it_climbs_straight_up_first() {
        let city: Vec<Obstacle> = (-6..=6)
            .map(|k| block(30.0, f64::from(k) * 50.0, 50.0, 60.0))
            .collect();
        let p = plan(20.0, (200.0, 0.0), 20.0, &city, &Ground::flat());
        assert!(matches!(p.how, How::Over { .. }));
        assert_eq!((p.legs[0].0, p.legs[0].1), (0.0, 0.0));
        assert!(clear_of(&p, 20.0, &city));
    }

    #[test]
    fn it_climbs_above_a_long_low_block_and_goes_around_the_tower_behind() {
        let mut city: Vec<Obstacle> = (-6..=6)
            .map(|k| block(60.0, f64::from(k) * 50.0, 50.0, 40.0))
            .collect();
        city.push(block(200.0, 0.0, 60.0, 300.0));
        let p = plan(30.0, (320.0, 0.0), 30.0, &city, &Ground::flat());
        assert_eq!(
            p.how,
            How::Around {
                buildings: 1,
                cruise_m: Some(50.0)
            }
        );
        assert_eq!(p.legs[0], (0.0, 0.0, 50.0));
        assert_eq!(*p.legs.last().unwrap(), (320.0, 0.0, 30.0));
        assert!(clear_of(&p, 30.0, &city));
    }

    #[test]
    fn ground_higher_than_it_flies_is_crossed_above() {
        // A ridge 50 m high across the way, everywhere the search looks.
        let (w, h) = (101, 101);
        let heights = (0..w * h)
            .map(|k| {
                if (9..=11).contains(&(k % w)) {
                    50.0
                } else {
                    0.0
                }
            })
            .collect();
        let ground = Ground::new((-100.0, -500.0), 10.0, w, heights);
        let p = plan(30.0, (200.0, 0.0), 30.0, &[], &ground);
        assert_eq!(p.how, How::Over { cruise_m: 56.0 });
        assert!(p.legs.iter().all(|l| l.2 >= 30.0));
        assert_eq!(*p.legs.last().unwrap(), (200.0, 0.0, 30.0));
    }

    #[test]
    fn the_grid_ground_is_the_autopilots_interpolation() {
        // Heights on the four grid points around a place in San Francisco:
        // it reads what ArduPilot's `height_amsl` would.
        let at = (37.7895, -122.3970);
        let (info, points) = corners(at.0, at.1, 100);
        let heights: HashMap<(i32, i32), f64> = points
            .iter()
            .copied()
            .zip([10.0, 20.0, 30.0, 300.0])
            .collect();
        let ground = Ground::grid(at, 100, heights);
        let expected = f64::from(grid::interpolate(&info, [10.0, 20.0, 30.0, 300.0]));
        assert!((ground.at((0.0, 0.0)) - expected).abs() < 1e-3);
        // Off the known points: unknown, so far below.
        assert_eq!(ground.at((500.0, 500.0)), f64::NEG_INFINITY);
    }

    #[test]
    fn a_destination_on_a_roof_stops_above_it() {
        let city = [block(200.0, 0.0, 40.0, 50.0)];
        let p = plan(80.0, (200.0, 0.0), 20.0, &city, &Ground::flat());
        assert_eq!(p.raised_to_m, Some(60.0));
        assert_eq!(p.legs.last().unwrap().2, 60.0);
    }
}
