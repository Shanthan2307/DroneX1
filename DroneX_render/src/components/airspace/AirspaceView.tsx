"use client";
// The shared airspace, live: a subscription to the SpacetimeDB tables (vehicle, position, corridor, incident,
// mission_assignment) drawn as a top-down map on a local metre grid around the vehicles, with every drone as an
// arrow (name, mode, battery), every granted corridor as a band, a refused request flashing with the module's
// reason, a vehicle list, the latest incidents, and a "Request corridor" control: pick a vehicle, click two points,
// choose an altitude band, and watch the reducer grant or refuse it. Every number here comes from the tables.
import { useEffect, useMemo, useRef, useState } from "react";
import { airspaceTarget, toCorridor, toIncident, toMission, toPosition, toVehicle } from "@/lib/airspace/client";
import { DbConnection, tables } from "@/lib/airspace/bindings/index";
import type { Corridor, Incident, MissionAssignment, Position, Vehicle } from "@/lib/airspace/bindings/types";
import type { AirCorridor, AirIncident, AirMission, AirPosition, AirVehicle } from "@/lib/airspace/types";

type State = "connecting" | "live" | "error";

interface Snapshot {
  vehicles: AirVehicle[];
  positions: AirPosition[];
  corridors: AirCorridor[];
  incidents: AirIncident[];
  missions: Map<string, AirMission>;
  byId: Map<string, AirVehicle>;
}

interface Store {
  vehicles: Map<string, AirVehicle>;
  positions: Map<string, AirPosition>;
  corridors: Map<number, AirCorridor>;
  incidents: Map<number, AirIncident>;
  missions: Map<string, AirMission>;
}

const emptyStore = (): Store => ({ vehicles: new Map(), positions: new Map(), corridors: new Map(), incidents: new Map(), missions: new Map() });

// What the view renders: plain arrays copied out of the store whenever a row changes (the store itself is a ref
// written by subscription callbacks, never read during render).
const snapshotOf = (s: Store): Snapshot => ({
  vehicles: [...s.vehicles.values()].sort((a, b) => a.name.localeCompare(b.name)),
  positions: [...s.positions.values()],
  corridors: [...s.corridors.values()].sort((a, b) => a.id - b.id),
  incidents: [...s.incidents.values()].sort((a, b) => b.id - a.id).slice(0, 8),
  missions: new Map(s.missions),
  byId: new Map(s.vehicles),
});

const M_PER_DEG_LAT = 111_320; // WGS-84 mean metres per degree of latitude: a projection constant, not a dataset value

interface Frame {
  refLat: number;
  refLon: number;
  mPerDegLon: number;
  scale: number; // px per metre
  w: number;
  h: number;
}

const project = (f: Frame, lat: number, lon: number): { x: number; y: number } => ({
  x: f.w / 2 + (lon - f.refLon) * f.mPerDegLon * f.scale,
  y: f.h / 2 - (lat - f.refLat) * M_PER_DEG_LAT * f.scale,
});

const unproject = (f: Frame, x: number, y: number): { lat: number; lon: number } => ({
  lat: f.refLat + (f.h / 2 - y) / (M_PER_DEG_LAT * f.scale),
  lon: f.refLon + (x - f.w / 2) / (f.mPerDegLon * f.scale),
});

const STATUS_COLOR: Record<string, string> = { granted: "#7c5cff", refused: "#ff4d6d", released: "#4b5263", expired: "#4b5263" };

export default function AirspaceView() {
  const [state, setState] = useState<State>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Snapshot>(() => snapshotOf(emptyStore()));
  const store = useRef<Store>(emptyStore());
  const connRef = useRef<DbConnection | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [points, setPoints] = useState<{ lat: number; lon: number }[]>([]);
  const [band, setBand] = useState<{ min: number; max: number }>({ min: 30, max: 60 });
  const [width, setWidth] = useState(40);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { uri, db } = airspaceTarget();

  useEffect(() => {
    const s = store.current;
    const bump = () => setData(snapshotOf(s));
    const conn = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .onConnect((c) => {
        c.db.vehicle.onInsert((_ctx, r: Vehicle) => {
          s.vehicles.set(r.id, toVehicle(r));
          bump();
        });
        c.db.vehicle.onUpdate((_ctx, _o: Vehicle, r: Vehicle) => {
          s.vehicles.set(r.id, toVehicle(r));
          bump();
        });
        c.db.vehicle.onDelete((_ctx, r: Vehicle) => {
          s.vehicles.delete(r.id);
          bump();
        });
        c.db.position.onInsert((_ctx, r: Position) => {
          s.positions.set(r.vehicleId, toPosition(r));
          bump();
        });
        c.db.position.onUpdate((_ctx, _o: Position, r: Position) => {
          s.positions.set(r.vehicleId, toPosition(r));
          bump();
        });
        c.db.position.onDelete((_ctx, r: Position) => {
          s.positions.delete(r.vehicleId);
          bump();
        });
        c.db.corridor.onInsert((_ctx, r: Corridor) => {
          s.corridors.set(Number(r.id), toCorridor(r));
          bump();
        });
        c.db.corridor.onUpdate((_ctx, _o: Corridor, r: Corridor) => {
          s.corridors.set(Number(r.id), toCorridor(r));
          bump();
        });
        c.db.corridor.onDelete((_ctx, r: Corridor) => {
          s.corridors.delete(Number(r.id));
          bump();
        });
        c.db.incident.onInsert((_ctx, r: Incident) => {
          s.incidents.set(Number(r.id), toIncident(r));
          bump();
        });
        c.db.missionAssignment.onInsert((_ctx, r: MissionAssignment) => {
          s.missions.set(r.vehicleId, toMission(r));
          bump();
        });
        c.db.missionAssignment.onUpdate((_ctx, _o: MissionAssignment, r: MissionAssignment) => {
          s.missions.set(r.vehicleId, toMission(r));
          bump();
        });
        c.subscriptionBuilder()
          .onApplied(() => {
            setState("live");
            bump();
          })
          .onError((ctx) => {
            setState("error");
            setError(ctx.event instanceof Error ? ctx.event.message : "subscription failed");
          })
          .subscribe([tables.vehicle, tables.position, tables.corridor, tables.incident, tables.missionAssignment]);
      })
      .onConnectError((_ctx, e) => {
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
      })
      .onDisconnect(() => setState("connecting"))
      .build();
    connRef.current = conn;
    return () => {
      conn.disconnect();
      connRef.current = null;
    };
  }, [uri, db]);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const { vehicles, positions, corridors, incidents, missions, byId } = data;

  // The frame: centred on the vehicles (and corridor ends), scaled so everything fits with room to click around.
  const frame = useMemo<Frame | null>(() => {
    const pts: { lat: number; lon: number }[] = positions.map((p) => ({ lat: p.lat, lon: p.lon }));
    for (const c of corridors) if (c.status === "granted" || c.status === "refused") pts.push(c.from, c.to);
    pts.push(...points);
    if (pts.length === 0) return null;
    const refLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    const refLon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
    let span = 150; // metres half-extent at minimum, so a single parked drone still has ground around it
    for (const p of pts) span = Math.max(span, Math.abs((p.lat - refLat) * M_PER_DEG_LAT) * 1.3, Math.abs((p.lon - refLon) * mPerDegLon) * 1.3);
    const scale = Math.min(size.w, size.h) / 2 / span;
    return { refLat, refLon, mPerDegLon, scale, w: size.w, h: size.h };
  }, [positions, corridors, points, size]);

  const onMapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!frame || !selected) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const p = unproject(frame, e.clientX - rect.left, e.clientY - rect.top);
    setPoints((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
  };

  const request = async () => {
    if (!selected || points.length !== 2) return;
    setBusy(true);
    setLast(null);
    try {
      const res = await fetch("/api/airspace/corridor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vehicleId: selected, from: points[0], to: points[1], minAltM: band.min, maxAltM: band.max, widthM: width, ttlS: 600 }),
      });
      const data = (await res.json()) as { corridor?: AirCorridor; error?: string };
      if (data.corridor) setLast(data.corridor.status === "granted" ? `corridor ${data.corridor.id} granted` : `refused: ${data.corridor.reason}`);
      else setLast(data.error ?? "no answer");
      setPoints([]);
    } catch (e) {
      setLast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const release = async (id: number) => {
    await fetch(`/api/airspace/corridor/${id}/release`, { method: "POST" });
  };

  const scaleBarM = frame ? [10, 20, 50, 100, 200, 500, 1000, 2000].find((m) => m * frame.scale >= 60) ?? 2000 : 0;

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", minHeight: 480 }}>
      <div style={{ position: "relative", minHeight: 0 }}>
        <svg ref={svgRef} width={size.w} height={size.h} onClick={onMapClick} style={{ display: "block", background: "#0f1320", cursor: selected ? "crosshair" : "default" }} aria-label="Shared airspace map">
          {frame && (
            <>
              {/* grid every 100 m */}
              {Array.from({ length: 21 }, (_, i) => i - 10).map((i) => {
                const x = frame.w / 2 + i * 100 * frame.scale;
                const y = frame.h / 2 + i * 100 * frame.scale;
                return (
                  <g key={i} stroke="#1c2130" strokeWidth={1}>
                    <line x1={x} y1={0} x2={x} y2={frame.h} />
                    <line x1={0} y1={y} x2={frame.w} y2={y} />
                  </g>
                );
              })}
              {corridors
                .filter((c) => c.status === "granted" || c.status === "refused")
                .map((c) => {
                  const a = project(frame, c.from.lat, c.from.lon);
                  const b = project(frame, c.to.lat, c.to.lon);
                  const color = STATUS_COLOR[c.status] ?? "#9aa3b2";
                  return (
                    <g key={c.id}>
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeOpacity={c.status === "refused" ? 0.5 : 0.35} strokeWidth={Math.max(2, c.widthM * frame.scale)} strokeLinecap="round" strokeDasharray={c.status === "refused" ? "8 6" : undefined} />
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1.5} />
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fill={color} fontSize={11} textAnchor="middle">
                        #{c.id} {c.minAltM.toFixed(0)}–{c.maxAltM.toFixed(0)} m {c.status}
                      </text>
                    </g>
                  );
                })}
              {points.map((p, i) => {
                const q = project(frame, p.lat, p.lon);
                return <circle key={i} cx={q.x} cy={q.y} r={5} fill="#ffd166" />;
              })}
              {points.length === 2 && (
                <line x1={project(frame, points[0].lat, points[0].lon).x} y1={project(frame, points[0].lat, points[0].lon).y} x2={project(frame, points[1].lat, points[1].lon).x} y2={project(frame, points[1].lat, points[1].lon).y} stroke="#ffd166" strokeDasharray="4 4" />
              )}
              {positions.map((p) => {
                const v = byId.get(p.vehicleId);
                const q = project(frame, p.lat, p.lon);
                const heading = p.headingDeg ?? 0;
                const online = v?.presence === "online";
                const color = v?.id === selected ? "#ffd166" : online ? "#2bb7a0" : "#4b5263";
                return (
                  <g key={p.vehicleId} transform={`translate(${q.x}, ${q.y})`} onClick={(e) => { e.stopPropagation(); setSelected(v?.id ?? null); }} style={{ cursor: "pointer" }}>
                    <g transform={`rotate(${heading})`}>
                      <polygon points="0,-12 8,10 0,5 -8,10" fill={color} stroke="#0b0d12" strokeWidth={1} />
                    </g>
                    <text x={14} y={-4} fill="#e6e9ef" fontSize={12} fontWeight={600}>
                      {v?.name ?? p.vehicleId.slice(0, 8)}
                    </text>
                    <text x={14} y={10} fill="#9aa3b2" fontSize={11}>
                      {v?.mode ?? "?"}
                      {v?.armed ? " · armed" : ""}
                      {p.altHomeM !== null ? ` · ${p.altHomeM.toFixed(0)} m` : ""}
                      {p.batteryPct !== null ? ` · ${p.batteryPct.toFixed(0)} %` : ""}
                    </text>
                  </g>
                );
              })}
              <g transform={`translate(16, ${frame.h - 24})`}>
                <line x1={0} y1={0} x2={scaleBarM * frame.scale} y2={0} stroke="#e6e9ef" strokeWidth={2} />
                <text x={0} y={-6} fill="#9aa3b2" fontSize={11}>
                  {scaleBarM} m
                </text>
              </g>
            </>
          )}
        </svg>
        <div style={{ position: "absolute", top: 10, left: 12, fontSize: 12, color: state === "live" ? "#2bb7a0" : state === "error" ? "#ff4d6d" : "#9aa3b2" }}>
          SpacetimeDB · {db} · {state}
          {error ? ` · ${error}` : ""}
          {state === "error" ? " · start it with DroneX_live/scripts/spacetime-start.sh and publish with spacetime-publish.sh" : ""}
        </div>
        {!frame && state === "live" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#9aa3b2", fontSize: 13 }}>No vehicle in the airspace yet. Press Fly in simulation; the mirror publishes it here.</div>
        )}
      </div>
      <aside style={{ borderLeft: "1px solid #1c2130", padding: 12, overflow: "auto", fontSize: 13, display: "flex", flexDirection: "column", gap: 12 }}>
        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#9aa3b2" }}>Vehicles</h3>
          {vehicles.length === 0 && <div style={{ color: "#4b5263" }}>none</div>}
          {vehicles.map((v) => {
            const m = missions.get(v.id);
            return (
              <button key={v.id} type="button" onClick={() => setSelected(v.id === selected ? null : v.id)} style={{ display: "block", width: "100%", textAlign: "left", background: v.id === selected ? "#1c2130" : "transparent", border: "1px solid #1c2130", borderRadius: 8, padding: "6px 8px", marginBottom: 6, color: "#e6e9ef", cursor: "pointer" }}>
                <div style={{ fontWeight: 600 }}>{v.name}</div>
                <div style={{ color: "#9aa3b2", fontSize: 11 }}>
                  {v.presence} · {v.mode}
                  {v.armed ? " · armed" : ""} · {v.operator}
                  {m ? ` · mission ${m.missionId} (${m.status})` : ""}
                </div>
              </button>
            );
          })}
        </section>
        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#9aa3b2" }}>Request corridor</h3>
          <div style={{ color: "#9aa3b2", fontSize: 12, marginBottom: 6 }}>{selected ? (points.length < 2 ? `click ${2 - points.length} point${points.length === 1 ? "" : "s"} on the map` : "ready") : "select a vehicle first"}</div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            band
            <input type="number" value={band.min} onChange={(e) => setBand({ ...band, min: Number(e.target.value) })} style={{ width: 56 }} /> to
            <input type="number" value={band.max} onChange={(e) => setBand({ ...band, max: Number(e.target.value) })} style={{ width: 56 }} /> m
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
            width <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} style={{ width: 56 }} /> m
          </label>
          <button type="button" disabled={!selected || points.length !== 2 || busy} onClick={request} style={{ background: "#7c5cff", color: "#fff", border: 0, borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>
            {busy ? "asking…" : "Ask the airspace"}
          </button>
          {last && <div style={{ marginTop: 6, color: last.startsWith("refused") ? "#ff4d6d" : "#2bb7a0", fontSize: 12 }}>{last}</div>}
        </section>
        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#9aa3b2" }}>Corridors</h3>
          {corridors.length === 0 && <div style={{ color: "#4b5263" }}>none</div>}
          {corridors.slice(-8).reverse().map((c) => (
            <div key={c.id} style={{ borderLeft: `3px solid ${STATUS_COLOR[c.status] ?? "#9aa3b2"}`, paddingLeft: 8, marginBottom: 6 }}>
              <div>
                #{c.id} {byId.get(c.vehicleId)?.name ?? c.vehicleId.slice(0, 8)} · {c.status}
                {c.status === "granted" && (
                  <button type="button" onClick={() => release(c.id)} style={{ marginLeft: 8, fontSize: 11, background: "transparent", color: "#9aa3b2", border: "1px solid #1c2130", borderRadius: 6, cursor: "pointer" }}>
                    release
                  </button>
                )}
              </div>
              <div style={{ color: "#9aa3b2", fontSize: 11 }}>
                {c.minAltM.toFixed(0)}–{c.maxAltM.toFixed(0)} m · {c.widthM.toFixed(0)} m wide{c.reason ? ` · ${c.reason}` : ""}
              </div>
            </div>
          ))}
        </section>
        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#9aa3b2" }}>Incidents</h3>
          {incidents.length === 0 && <div style={{ color: "#4b5263" }}>none</div>}
          {incidents.map((i) => (
            <div key={i.id} style={{ marginBottom: 4, fontSize: 12 }}>
              <span style={{ color: "#ff8a3d" }}>{i.kind}</span> · {byId.get(i.vehicleId)?.name ?? i.vehicleId.slice(0, 8)} · <span style={{ color: "#9aa3b2" }}>{i.detail}</span>
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}
