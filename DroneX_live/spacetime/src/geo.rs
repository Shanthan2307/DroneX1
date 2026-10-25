//! Corridor geometry on a local flat-earth metre grid: good to well under a metre over the few kilometres an
//! airspace spans. A corridor is a segment with a half-width; two corridors conflict when their segments come
//! within the sum of their half-widths of each other and their altitude bands overlap.

/// Metres per degree of latitude (WGS-84 mean), and per degree of longitude at a latitude.
const M_PER_DEG_LAT: f64 = 111_320.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Local east/north metres of a lat/lon about a reference latitude.
pub fn to_local(lat_deg: f64, lon_deg: f64, ref_lat_deg: f64, ref_lon_deg: f64) -> Point {
    let m_per_deg_lon = M_PER_DEG_LAT * ref_lat_deg.to_radians().cos();
    Point {
        x: (lon_deg - ref_lon_deg) * m_per_deg_lon,
        y: (lat_deg - ref_lat_deg) * M_PER_DEG_LAT,
    }
}

fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.y * b.y
}

fn sub(a: Point, b: Point) -> Point {
    Point { x: a.x - b.x, y: a.y - b.y }
}

fn cross(a: Point, b: Point) -> f64 {
    a.x * b.y - a.y * b.x
}

/// Distance from a point to a segment.
pub fn point_segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let ab = sub(b, a);
    let len2 = dot(ab, ab);
    if len2 == 0.0 {
        return dot(sub(p, a), sub(p, a)).sqrt();
    }
    let t = (dot(sub(p, a), ab) / len2).clamp(0.0, 1.0);
    let proj = Point { x: a.x + t * ab.x, y: a.y + t * ab.y };
    dot(sub(p, proj), sub(p, proj)).sqrt()
}

fn orient(a: Point, b: Point, c: Point) -> f64 {
    cross(sub(b, a), sub(c, a))
}

/// Whether two segments cross (including touching).
pub fn segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    if (o1 > 0.0) != (o2 > 0.0) && (o3 > 0.0) != (o4 > 0.0) && o1 != 0.0 && o2 != 0.0 && o3 != 0.0 && o4 != 0.0 {
        return true;
    }
    let on = |p: Point, q: Point, r: Point| orient(p, q, r) == 0.0 && r.x >= p.x.min(q.x) && r.x <= p.x.max(q.x) && r.y >= p.y.min(q.y) && r.y <= p.y.max(q.y);
    on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)
}

/// Shortest distance between two segments.
pub fn segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    if segments_intersect(a, b, c, d) {
        return 0.0;
    }
    point_segment_distance(a, c, d)
        .min(point_segment_distance(b, c, d))
        .min(point_segment_distance(c, a, b))
        .min(point_segment_distance(d, a, b))
}

/// Whether two altitude bands (metres above home) overlap, with a vertical buffer between them.
pub fn bands_overlap(min_a: f64, max_a: f64, min_b: f64, max_b: f64, buffer_m: f64) -> bool {
    min_a <= max_b + buffer_m && min_b <= max_a + buffer_m
}

/// A corridor in local metres: a segment, a half-width and an altitude band.
#[derive(Clone, Copy, Debug)]
pub struct Corridor {
    pub a: Point,
    pub b: Point,
    pub half_width_m: f64,
    pub min_alt_m: f64,
    pub max_alt_m: f64,
}

/// Two corridors conflict when their centre lines come closer than the sum of their half-widths (plus the
/// lateral buffer) and their altitude bands overlap (within the vertical buffer).
pub fn corridors_conflict(p: &Corridor, q: &Corridor, lateral_buffer_m: f64, vertical_buffer_m: f64) -> bool {
    if !bands_overlap(p.min_alt_m, p.max_alt_m, q.min_alt_m, q.max_alt_m, vertical_buffer_m) {
        return false;
    }
    segment_distance(p.a, p.b, q.a, q.b) < p.half_width_m + q.half_width_m + lateral_buffer_m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn corridor(ax: f64, ay: f64, bx: f64, by: f64, half: f64, lo: f64, hi: f64) -> Corridor {
        Corridor { a: p(ax, ay), b: p(bx, by), half_width_m: half, min_alt_m: lo, max_alt_m: hi }
    }

    #[test]
    fn local_metres_scale_with_latitude() {
        let q = to_local(37.761, -122.386, 37.760, -122.387);
        assert!((q.y - 111.32).abs() < 0.01);
        // a degree of longitude at 37.76° N is about 88 km, so 0.001° is about 88 m
        assert!((q.x - 88.0).abs() < 0.5, "x was {}", q.x);
    }

    #[test]
    fn point_to_segment() {
        assert!((point_segment_distance(p(0.0, 5.0), p(0.0, 0.0), p(10.0, 0.0)) - 5.0).abs() < 1e-9);
        assert!((point_segment_distance(p(-3.0, 4.0), p(0.0, 0.0), p(10.0, 0.0)) - 5.0).abs() < 1e-9);
        assert!((point_segment_distance(p(13.0, 4.0), p(0.0, 0.0), p(10.0, 0.0)) - 5.0).abs() < 1e-9);
        assert!((point_segment_distance(p(1.0, 1.0), p(2.0, 2.0), p(2.0, 2.0)) - 2f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn crossing_segments_are_at_distance_zero() {
        assert!(segments_intersect(p(0.0, 0.0), p(10.0, 10.0), p(0.0, 10.0), p(10.0, 0.0)));
        assert_eq!(segment_distance(p(0.0, 0.0), p(10.0, 10.0), p(0.0, 10.0), p(10.0, 0.0)), 0.0);
        assert!(!segments_intersect(p(0.0, 0.0), p(10.0, 0.0), p(0.0, 1.0), p(10.0, 1.0)));
        assert!((segment_distance(p(0.0, 0.0), p(10.0, 0.0), p(0.0, 1.0), p(10.0, 1.0)) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn parallel_corridors_conflict_only_when_close_and_at_the_same_height() {
        let a = corridor(0.0, 0.0, 1000.0, 0.0, 20.0, 30.0, 60.0);
        let near_same_height = corridor(0.0, 30.0, 1000.0, 30.0, 20.0, 40.0, 70.0);
        let far_same_height = corridor(0.0, 60.0, 1000.0, 60.0, 20.0, 40.0, 70.0);
        let near_above = corridor(0.0, 30.0, 1000.0, 30.0, 20.0, 80.0, 110.0);
        assert!(corridors_conflict(&a, &near_same_height, 5.0, 10.0));
        assert!(!corridors_conflict(&a, &far_same_height, 5.0, 10.0));
        assert!(!corridors_conflict(&a, &near_above, 5.0, 10.0));
        // the vertical buffer counts: 60 m top against a 65 m floor with a 10 m buffer still conflicts
        let just_above = corridor(0.0, 30.0, 1000.0, 30.0, 20.0, 65.0, 90.0);
        assert!(corridors_conflict(&a, &just_above, 5.0, 10.0));
    }

    #[test]
    fn crossing_corridors_conflict() {
        let a = corridor(0.0, 0.0, 1000.0, 1000.0, 15.0, 40.0, 60.0);
        let b = corridor(0.0, 1000.0, 1000.0, 0.0, 15.0, 50.0, 70.0);
        assert!(corridors_conflict(&a, &b, 0.0, 0.0));
        let b_over = corridor(0.0, 1000.0, 1000.0, 0.0, 15.0, 90.0, 110.0);
        assert!(!corridors_conflict(&a, &b_over, 0.0, 10.0));
    }
}
