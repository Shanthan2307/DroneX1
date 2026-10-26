// Which parts of DroneX this deployment runs. DRONEX_MODE=configurator is the website-only deployment (e.g. Vercel's
// free plan): the configurator, the physics verdicts and Ask DroneX, without the simulation engine, the live layer or
// the agents. Everything that needs those is hidden in the UI and answers 503 here, with DRONEX_CONTACT_EMAIL for
// anyone who wants to try the simulator. Unset: the whole product (docs/DEPLOY.md). Server-only.

/** Pure: whether `mode` (DRONEX_MODE) includes the simulator and the rest of the stack. */
export const simulatorInMode = (mode: string | undefined): boolean => mode?.trim().toLowerCase() !== "configurator";

export const simulatorEnabled = (): boolean => simulatorInMode(process.env.DRONEX_MODE);

/** Who to write to for a simulator session, when this deployment has no simulator: DRONEX_CONTACT_EMAIL. */
export const contactEmail = (): string | null => process.env.DRONEX_CONTACT_EMAIL?.trim() || null;

/** Pure: the sentence shown wherever the simulator would be. */
export function simulatorOffText(email: string | null): string {
  const ask = email ? `To try the flight simulator, email ${email}.` : "The full DroneX runs locally with ./dev.sh.";
  return `The simulator is not part of this online demo. ${ask}`;
}

/** For routes that need the simulator, the live layer or the agents: null when this deployment has them, else a 503. */
export function requireSimulator(): Response | null {
  return simulatorEnabled() ? null : Response.json({ error: simulatorOffText(contactEmail()) }, { status: 503 });
}
