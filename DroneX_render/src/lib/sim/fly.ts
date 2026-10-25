// Starting a design in the simulation engine: a simulated vehicle of the right ArduPilot class and frame, named
// after the design, drawn by the engine's map from the exported model (a bookmark on the vehicle carries the
// model's address and how to draw it), with the design's battery, hover and speed parameters written once the
// vehicle has its parameters. Server-only; talks to Core over its local socket (core.ts).
import { CoreClient, CoreRpcError, readDaemon, sleep, uiUrlOf } from "./core";

export interface SimParam {
  name: string;
  value: number;
}

export interface SimProfile {
  name: string;
  vehicle: "multicopter" | "plane" | "vtol";
  frame: string;
  base: "multicopter" | "plane" | "vtol";
  spinner: string | null;
  span_m: number;
  params: SimParam[];
  rotors: { ccw: boolean }[];
}

interface Link {
  id: string;
}

interface Vehicle {
  id: string;
  linkId: string;
  presence: "online" | "stale" | "offline";
  name: string;
}

interface Place {
  latitudeDeg: number;
  longitudeDeg: number;
  headingDeg: number;
}

// Where a simulation starts: the simulation UI's own default spot for each vehicle class (Y Combinator, San
// Francisco, the same place its New simulation form starts at), unless DRONEX_SIM_LAT / LON / HEADING say otherwise.
const START: Record<SimProfile["vehicle"], Place> = {
  multicopter: { latitudeDeg: 37.760975, longitudeDeg: -122.386761, headingDeg: 22 },
  plane: { latitudeDeg: 37.76313, longitudeDeg: -122.386503, headingDeg: 22 },
  vtol: { latitudeDeg: 37.762051, longitudeDeg: -122.387062, headingDeg: 22 },
};

// Each drone already on the pad pushes the next one this far east, so two sent one after the other stand side by
// side instead of inside each other. About 4 m at San Francisco's latitude.
const SPACING_DEG = 0.00005;

function startPlace(vehicle: SimProfile["vehicle"], crowd: number): Place {
  const env = (k: string) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) ? v : null;
  };
  const d = START[vehicle];
  return {
    latitudeDeg: env("DRONEX_SIM_LAT") ?? d.latitudeDeg,
    longitudeDeg: (env("DRONEX_SIM_LON") ?? d.longitudeDeg) + crowd * SPACING_DEG,
    headingDeg: env("DRONEX_SIM_HEADING") ?? d.headingDeg,
  };
}

/** The bookmark URL the simulation UI's model loader reads: the model plus how to draw it, in the query. */
export function modelBookmarkUrl(base: string, id: string, profile: SimProfile): string {
  const q = new URLSearchParams({ base: profile.base, span: String(profile.span_m) });
  if (profile.rotors.length) q.set("rotors", profile.rotors.map((r) => (r.ccw ? "1" : "0")).join(""));
  if (profile.spinner) q.set("spinner", profile.spinner);
  return `${base}/api/sim/designs/${id}/model.glb?${q}`;
}

const VEHICLE_WAIT_MS = 90_000;
const PARAM_WAIT_MS = 180_000;
// Starting SITL (spawning ArduPilot, opening its link) takes longer than an ordinary RPC.
const SIM_START_TIMEOUT_MS = 120_000;

export interface FlyResult {
  vehicleId: string;
  linkId: string;
  url: string;
}

/**
 * Starts the simulation and returns once the vehicle exists and carries its name, size and model bookmark, so
 * the UI draws the design the moment it opens. Parameters are written in the background (they need the
 * vehicle's parameter download first, which takes a while) and only logged.
 */
export async function flyDesign(id: string, profile: SimProfile, { modelUrl, openUrl }: { modelUrl: string; openUrl: string }): Promise<FlyResult> {
  const daemon = await readDaemon();
  const client = await CoreClient.connect(daemon.socket);
  let keep = false;
  try {
    const { vehicles: before } = await client.call<{ vehicles: Vehicle[] }>("vehicle/list", {});
    const place = startPlace(profile.vehicle, before.filter((v) => v.presence === "online").length);
    const ground = await groundHeight(client, place);
    const link = await client.call<Link>("sim/start", {
      vehicle: profile.vehicle,
      frame: profile.frame,
      ...place,
      ...(ground !== null ? { altitudeM: ground } : {}),
      name: `${profile.name} (DroneX)`.slice(0, 64),
    }, SIM_START_TIMEOUT_MS);
    const vehicle = await waitForVehicle(client, link.id);
    await client.call("vehicle/save", { id: vehicle.id, name: profile.name });
    await client.call("vehicle/size", { id: vehicle.id, sizeCm: Math.max(1, Math.round(profile.span_m * 100)) });
    await client.call("vehicle/bookmarks", {
      id: vehicle.id,
      bookmarks: [
        { name: "DroneX model", url: modelUrl },
        { name: "Open in DroneX", url: openUrl },
      ],
    });
    keep = true;
    void applyParams(client, vehicle.id, profile.params).finally(() => client.close());
    return { vehicleId: vehicle.id, linkId: link.id, url: `${uiUrlOf(daemon)}?vehicle=${encodeURIComponent(vehicle.id)}` };
  } finally {
    if (!keep) client.close();
  }
}

async function groundHeight(client: CoreClient, place: Place): Promise<number | null> {
  try {
    const r = await client.call<{ heightM?: number }>("terrain/at", { latitudeDeg: place.latitudeDeg, longitudeDeg: place.longitudeDeg });
    return typeof r.heightM === "number" ? r.heightM : null;
  } catch {
    return null; // no terrain here: the simulator starts at sea level
  }
}

async function waitForVehicle(client: CoreClient, linkId: string): Promise<Vehicle> {
  const until = Date.now() + VEHICLE_WAIT_MS;
  while (Date.now() < until) {
    const { vehicles } = await client.call<{ vehicles: Vehicle[] }>("vehicle/list", {});
    const v = vehicles.find((x) => x.linkId === linkId && x.presence === "online");
    if (v) return v;
    await sleep(500);
  }
  throw new Error("the simulated vehicle did not come up in time (is the SITL build installed?)");
}

/** Writes each parameter, retrying while the vehicle's parameters are still downloading. Failures are logged. */
async function applyParams(client: CoreClient, vehicleId: string, params: SimParam[]): Promise<void> {
  const until = Date.now() + PARAM_WAIT_MS;
  for (const p of params) {
    for (;;) {
      try {
        const r = await client.call<{ status: string; detail?: string }>("param/set", { vehicleId, name: p.name, value: p.value, reason: "DroneX design" });
        if (r.status !== "accepted") console.warn(`[dronex sim] ${p.name}=${p.value}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
        break;
      } catch (e) {
        // "has no parameter X (download its parameters first)" while the download runs: try again shortly.
        const downloading = e instanceof CoreRpcError && /download its parameters/i.test(e.message);
        if (downloading && Date.now() < until) {
          await sleep(2000);
          continue;
        }
        console.warn(`[dronex sim] ${p.name}=${p.value}: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
  }
}
