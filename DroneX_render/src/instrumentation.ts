// Runs once when the Next server starts. In production: refuse to start without the deployment settings
// (lib/deployEnv.ts), then start the simulator reaper and the design-store reaper (lib/sim/sims.ts), whose first
// round rebuilds the sim registry from Core. During `next build` only warn, so a build without them still
// finishes (but its prerendered pages would carry the laptop addresses).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;
  const { deployProblems, deployWarnings } = await import("./lib/deployEnv");
  const problems = deployProblems(process.env);
  if (process.env.NEXT_PHASE === "phase-production-build") {
    for (const p of problems) console.warn(`[dronex] ${p}: the prerendered pages will not carry the public addresses`);
    return;
  }
  if (problems.length) throw new Error(`DroneX cannot start in production:\n- ${problems.join("\n- ")}`);
  for (const w of deployWarnings(process.env)) console.warn(`[dronex] ${w}`);
  const { startReapers } = await import("./lib/sim/sims");
  startReapers();
}
