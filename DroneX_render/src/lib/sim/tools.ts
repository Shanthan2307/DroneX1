// The copilot's hands: a small, typed set of actions on the simulation engine, each one Core RPC call or a short
// sequence, with the receipt returned as plain words. The voice copilot (Cartesia), the Dispatch flight agent
// (Fetch.ai) and any model-driven intent all go through here, so what a spoken or typed command can do is exactly
// this list, and arming or changing mode never happens without the caller asking for it by name. Server-only.
import { CoreClient, CoreRpcError, readDaemon, sleep } from "./core";

export interface VehicleRow {
  id: string;
  name: string;
  linkId: string;
  vehicleType: string;
  presence: "online" | "stale" | "offline";
  armed: boolean;
  mode: string;
  designId: string | null;
}

export interface Telemetry {
  vehicleId: string;
  latitudeDeg: number | null;
  longitudeDeg: number | null;
  altitudeAboveHomeM: number | null;
  altitudeAmslM: number | null;
  headingDeg: number | null;
  groundSpeedMps: number | null;
  batteryPct: number | null;
  batteryV: number | null;
  gpsSatellites: number | null;
  gpsFix: string | null;
  ekfStatus: string | null;
  mode: string | null;
  armed: boolean | null;
}

export interface Receipt {
  id: string;
  status: "sent" | "accepted" | "rejected" | "timeout" | string;
  detail?: string;
  reason?: string;
}

type RawVehicle = { id: string; name: string; linkId: string; vehicleType: string; presence: VehicleRow["presence"]; armed: boolean; mode: string; bookmarks?: { name: string; url: string }[] };
type RawTelemetry = {
  vehicleId: string;
  positions: { source: string; latitudeDeg: number; longitudeDeg: number; headingDeg?: number | null; groundSpeedMps?: number | null; altitudes: { meters: number; frame: string }[] }[];
  items: { key: string; value?: number | null; text?: string | null }[];
};

const designIdOf = (v: RawVehicle): string | null => {
  const b = (v.bookmarks ?? []).find((x) => x.name === "DroneX model");
  const m = b?.url.match(/designs\/(s-[a-f0-9]{12})\//);
  return m ? m[1] : null;
};

export const toVehicleRow = (v: RawVehicle): VehicleRow => ({ id: v.id, name: v.name, linkId: v.linkId, vehicleType: v.vehicleType, presence: v.presence, armed: v.armed, mode: v.mode, designId: designIdOf(v) });

/** One connection per request; the daemon is local and connecting is cheap. */
export async function withCore<T>(fn: (c: CoreClient) => Promise<T>): Promise<T> {
  const daemon = await readDaemon();
  const client = await CoreClient.connect(daemon.socket);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/** Which vehicles a caller may see and command: `null` means all (the agents, a laptop). */
export type AllowedIds = readonly string[] | null;

/** Every vehicle, or only the allowed ones. */
export async function listVehicles(c: CoreClient, allowed: AllowedIds = null): Promise<VehicleRow[]> {
  const { vehicles } = await c.call<{ vehicles: RawVehicle[] }>("vehicle/list", {});
  const rows = vehicles.map(toVehicleRow);
  return allowed ? rows.filter((v) => allowed.includes(v.id)) : rows;
}

/**
 * The vehicle a command is for, among the allowed ones: the one named, else the only online one, else an error
 * naming the choices.
 */
export async function pickVehicle(c: CoreClient, nameOrId?: string | null, allowed: AllowedIds = null): Promise<VehicleRow> {
  const all = await listVehicles(c, allowed);
  const online = all.filter((v) => v.presence === "online");
  if (allowed && all.length === 0) throw new Error("you have no drone in the simulator yet; build one and press Fly in simulation");
  if (nameOrId) {
    const q = nameOrId.toLowerCase();
    const hit = all.find((v) => v.id === nameOrId) ?? online.find((v) => v.name.toLowerCase().includes(q)) ?? all.find((v) => v.name.toLowerCase().includes(q));
    if (hit) return hit;
    throw new Error(`no vehicle called "${nameOrId}"; online: ${online.map((v) => v.name).join(", ") || "none"}`);
  }
  if (online.length === 1) return online[0];
  if (online.length === 0) throw new Error("no vehicle is online; press Fly in simulation first");
  throw new Error(`several vehicles are online, say which: ${online.map((v) => v.name).join(", ")}`);
}

export function summarizeTelemetry(t: RawTelemetry, v?: VehicleRow): Telemetry {
  const pos = t.positions.find((p) => p.source === "fused") ?? t.positions[0];
  const alt = (frame: string) => pos?.altitudes.find((a) => a.frame === frame)?.meters ?? null;
  const item = (key: string) => t.items.find((i) => i.key === key);
  const num = (key: string) => item(key)?.value ?? null;
  return {
    vehicleId: t.vehicleId,
    latitudeDeg: pos?.latitudeDeg ?? null,
    longitudeDeg: pos?.longitudeDeg ?? null,
    altitudeAboveHomeM: alt("above-home"),
    altitudeAmslM: alt("amsl"),
    headingDeg: pos?.headingDeg ?? null,
    groundSpeedMps: pos?.groundSpeedMps ?? null,
    batteryPct: num("battery.remaining_pct") ?? num("battery.percent") ?? num("battery.remaining"),
    batteryV: num("battery.voltage_v") ?? num("battery.voltage"),
    gpsSatellites: num("gps.satellites"),
    gpsFix: item("gps.fix")?.text ?? null,
    ekfStatus: item("ekf.status")?.text ?? null,
    mode: v?.mode ?? null,
    armed: v?.armed ?? null,
  };
}

export async function telemetry(c: CoreClient, vehicle: VehicleRow): Promise<Telemetry> {
  const raw = await c.call<RawTelemetry>("telemetry/get", { id: vehicle.id });
  return summarizeTelemetry(raw, vehicle);
}

type Command =
  | { type: "arm" }
  | { type: "disarm" }
  | { type: "set-mode"; mode: string }
  | { type: "rtl" }
  | { type: "land" }
  | { type: "go-to"; latitudeDeg: number; longitudeDeg: number; altitudeM: number; altitudeFrame: "above-home" | "amsl" | "above-ground"; heading?: { mode: "face-destination" } }
  | { type: "long"; command: number; params: number[] };

async function send(c: CoreClient, vehicle: VehicleRow, command: Command, force = false): Promise<Receipt> {
  try {
    return await c.call<Receipt>("command/send", { vehicleId: vehicle.id, command, ...(force ? { force: true } : {}) });
  } catch (e) {
    if (e instanceof CoreRpcError) return { id: "", status: "rejected", detail: e.rpc.message };
    throw e;
  }
}

const said = (what: string, r: Receipt): string => (r.status === "accepted" || r.status === "sent" ? `${what}: ${r.status}` : `${what} refused${r.detail ? `: ${r.detail}` : r.reason ? ` (${r.reason})` : ""}`);

export async function setMode(c: CoreClient, v: VehicleRow, mode: string): Promise<string> {
  return said(`mode ${mode.toUpperCase()}`, await send(c, v, { type: "set-mode", mode: mode.toUpperCase() }));
}

export async function arm(c: CoreClient, v: VehicleRow): Promise<string> {
  return said("arm", await send(c, v, { type: "arm" }));
}

export async function disarm(c: CoreClient, v: VehicleRow): Promise<string> {
  return said("disarm", await send(c, v, { type: "disarm" }));
}

export async function rtl(c: CoreClient, v: VehicleRow): Promise<string> {
  return said("return to launch", await send(c, v, { type: "rtl" }));
}

export async function land(c: CoreClient, v: VehicleRow): Promise<string> {
  return said("land", await send(c, v, { type: "land" }));
}

const MAV_CMD_NAV_TAKEOFF = 22;

/** Guided mode, arm, then the takeoff command to the height asked for (ArduPilot copters and VTOLs). */
export async function takeoff(c: CoreClient, v: VehicleRow, altitudeM: number): Promise<string> {
  const alt = Math.min(Math.max(altitudeM, 2), 120);
  const steps: string[] = [];
  steps.push(await setMode(c, v, "GUIDED"));
  await sleep(400);
  if (!v.armed) {
    steps.push(await arm(c, v));
    await sleep(1500);
  }
  steps.push(said(`take off to ${alt} m`, await send(c, v, { type: "long", command: MAV_CMD_NAV_TAKEOFF, params: [0, 0, 0, 0, 0, 0, alt] })));
  return steps.join("; ");
}

export async function goTo(c: CoreClient, v: VehicleRow, latitudeDeg: number, longitudeDeg: number, altitudeM: number): Promise<string> {
  const r = await send(c, v, { type: "go-to", latitudeDeg, longitudeDeg, altitudeM, altitudeFrame: "above-home" });
  return said(`go to ${latitudeDeg.toFixed(5)}, ${longitudeDeg.toFixed(5)} at ${altitudeM} m`, r);
}

export interface Place {
  name: string;
  detail: string;
  latitudeDeg: number;
  longitudeDeg: number;
}

/** A town, landmark or address, through the engine's hosted place search (first hit, located). */
export async function findPlace(c: CoreClient, query: string, near?: { latitudeDeg: number; longitudeDeg: number } | null): Promise<Place | null> {
  const { suggestions } = await c.call<{ suggestions?: { key: string; text: string }[] }>("place/search", { query, limit: 3, ...(near ? { near } : {}) });
  const hit = suggestions?.[0];
  if (!hit) return null;
  const { place } = await c.call<{ place: Place }>("place/locate", { key: hit.key, text: hit.text, ...(near ? { near } : {}) });
  return place;
}

/** Go to a place by name: searched near the vehicle, then a guided go-to at the height asked for. */
export async function goToPlace(c: CoreClient, v: VehicleRow, query: string, altitudeM: number): Promise<string> {
  const t = await telemetry(c, v);
  const near = t.latitudeDeg !== null && t.longitudeDeg !== null ? { latitudeDeg: t.latitudeDeg, longitudeDeg: t.longitudeDeg } : null;
  const place = await findPlace(c, query, near);
  if (!place) return `I could not find a place called "${query}"`;
  if (v.mode.toUpperCase() !== "GUIDED") await setMode(c, v, "GUIDED");
  const r = await goTo(c, v, place.latitudeDeg, place.longitudeDeg, altitudeM);
  return `${place.name}: ${r}`;
}

export const describe = (t: Telemetry, v: VehicleRow): string => {
  const parts = [`${v.name} is ${v.presence}`, `mode ${v.mode}`, v.armed ? "armed" : "disarmed"];
  if (t.altitudeAboveHomeM !== null) parts.push(`${t.altitudeAboveHomeM.toFixed(0)} metres above home`);
  if (t.groundSpeedMps !== null) parts.push(`${t.groundSpeedMps.toFixed(1)} metres per second`);
  if (t.batteryPct !== null) parts.push(`battery ${t.batteryPct.toFixed(0)} percent`);
  if (t.gpsSatellites !== null) parts.push(`${t.gpsSatellites.toFixed(0)} satellites${t.gpsFix ? ` (${t.gpsFix})` : ""}`);
  if (t.ekfStatus) parts.push(`EKF ${t.ekfStatus}`);
  return parts.join(", ");
};
