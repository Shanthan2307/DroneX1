// A sink that prints what the mirror sees: the first thing to run when wiring a new machine.
import type { FlightEvent, Fix, Sink, VehicleInfo } from "./types.js";

export function logSink(): Sink {
  let fixes = 0;
  return {
    name: "log",
    onVehicle: (v: VehicleInfo) => console.log(`[mirror] vehicle ${v.name} (${v.id.slice(0, 8)}) ${v.presence} ${v.mode}${v.armed ? " armed" : ""}${v.designId ? ` design ${v.designId}` : ""}`),
    onFix: () => {
      fixes++;
    },
    onEvent: (e: FlightEvent) => console.log(`[mirror] event ${JSON.stringify(e)}`),
    flush: () => {
      if (fixes) {
        console.log(`[mirror] ${fixes} fixes/s`);
        fixes = 0;
      }
    },
  };
}
