// What a production server must have before it takes requests (docs/DEPLOY.md item 16). The public URLs and the
// browser's SpacetimeDB address are baked into the prerendered pages at build time, so they must also be set
// during `next build`. Pure: takes the environment, returns the problems.

export function deployProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const set = (k: string) => Boolean(env[k]?.trim());
  if (!set("DRONEX_PUBLIC_URL")) problems.push("DRONEX_PUBLIC_URL is not set (the configurator's public https origin)");
  if (!set("DRONEX_SIM_UI_URL")) problems.push("DRONEX_SIM_UI_URL is not set (the simulator's public https origin)");
  if (!env.NEXT_PUBLIC_SPACETIME_URI?.trim().startsWith("wss://")) problems.push("NEXT_PUBLIC_SPACETIME_URI must start with wss://");
  if (!set("DRONEX_COOKIE_SECRET")) problems.push("DRONEX_COOKIE_SECRET is not set (signs the vehicle-ownership cookie)");
  return problems;
}

/** Worth a warning but not a refusal to start. */
export function deployWarnings(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  if (!env.DRONEX_AGENT_TOKEN?.trim()) out.push("DRONEX_AGENT_TOKEN is not set: the agent-only routes refuse everyone");
  if (!env.SPACETIME_TOKEN?.trim() && !env.SPACETIME_TOKEN_FILE?.trim()) out.push("neither SPACETIME_TOKEN nor SPACETIME_TOKEN_FILE is set: airspace writes use a fresh identity each time");
  return out;
}
