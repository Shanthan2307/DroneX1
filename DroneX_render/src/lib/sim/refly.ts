// Server-only: start a design that was already sent to the simulator once (its model, design and profile are in
// the store) as a new simulated vehicle, optionally at a given place. Used by /api/sim/refly/<id> (the Dispatch
// flight agent) and the track scenarios, which start each drone where its story happens.
import { flyDesign, modelBookmarkUrl, type FlyResult, type Place, type SimProfile } from "@/lib/sim/fly";
import { readFlight } from "@/lib/sim/store";

export async function reflyDesign(id: string, origin: string, place: Place | null = null): Promise<(FlyResult & { id: string; name: string }) | null> {
  const flight = await readFlight(id);
  if (!flight) return null;
  const profile = flight.profile as SimProfile;
  const flown = await flyDesign(id, profile, { modelUrl: modelBookmarkUrl(origin, id, profile), openUrl: `${origin}/?sim=${id}`, place });
  const design = flight.design as { name?: string };
  return { id, name: design.name ?? profile.name, ...flown };
}
