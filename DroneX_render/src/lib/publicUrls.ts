// Where a visitor's browser reaches the two engines. On a laptop these are the loopback addresses; deployed behind a
// proxy, DRONEX_PUBLIC_URL (this configurator) and DRONEX_SIM_UI_URL (the simulation UI) say the public ones, since
// a proxied request's own URL names the loopback port it arrived on. Server-only.

const trimmed = (value: string | undefined): string | null => value?.trim().replace(/\/+$/, "") || null;

/** The configurator's public origin: DRONEX_PUBLIC_URL, else the origin the request arrived at. */
export const configuratorOrigin = (request: Request): string => trimmed(process.env.DRONEX_PUBLIC_URL) ?? new URL(request.url).origin;

/** The simulation UI's public address with a trailing slash: DRONEX_SIM_UI_URL, else `fallback` (the daemon's own). */
export const simulatorUrl = (fallback = "http://127.0.0.1:45010"): string => (trimmed(process.env.DRONEX_SIM_UI_URL) ?? trimmed(fallback) ?? fallback) + "/";
