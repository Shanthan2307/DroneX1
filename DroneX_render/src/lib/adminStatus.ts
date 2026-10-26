// What the admin dashboard shows for each technology: whether it is configured, its daily budget in this app and
// today's use (counted by this server process, rateLimit.ts), and, where the provider has an API for it, the
// provider's own numbers. Cartesia reports credit usage to an admin key (CARTESIA_ADMIN_KEY); ASI:One has no usage
// API, so its line links to its dashboard. Server-only.
import { budgetSnapshot, type BudgetLine } from "./rateLimit";
import { contactEmail, simulatorEnabled } from "./mode";

export interface TechStatus {
  name: string;
  role: string;
  configured: boolean;
  budgets: BudgetLine[];
  provider?: { ok: boolean; data?: unknown; error?: string };
  dashboard: string;
  note?: string;
}

export interface AdminStatus {
  checkedAt: string;
  uptimeS: number;
  mode: "configurator" | "full";
  contact: string | null;
  techs: TechStatus[];
}

const set = (k: string): boolean => Boolean(process.env[k]?.trim());

/** Cartesia's credit usage, when an admin key is configured (its usage routes refuse standard keys). */
async function cartesiaUsage(): Promise<TechStatus["provider"]> {
  const key = process.env.CARTESIA_ADMIN_KEY?.trim();
  if (!key) return undefined;
  try {
    const r = await fetch("https://api.cartesia.ai/usage/credits", {
      headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": "2026-03-01" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const data: unknown = await r.json().catch(() => null);
    return r.ok ? { ok: true, data } : { ok: false, error: `Cartesia answered ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function adminStatus(): Promise<AdminStatus> {
  const budgets = budgetSnapshot();
  const pick = (...ps: BudgetLine["provider"][]) => budgets.filter((b) => ps.includes(b.provider));
  const full = simulatorEnabled();
  const techs: TechStatus[] = [
    {
      name: "ASI:One",
      role: `Ask DroneX's model (${process.env.INTENT_MODEL?.trim() || "default model"})`,
      configured: set("INTENT_API_KEY"),
      budgets: pick("llm"),
      dashboard: "https://asi1.ai/dashboard",
      note: "ASI:One has no usage API: see credits on its dashboard.",
    },
    {
      name: "Cartesia",
      role: "Ask DroneX's voice: Sonic speaks, Ink listens",
      configured: set("CARTESIA_API_KEY"),
      budgets: pick("cartesia", "cartesiaToken"),
      provider: await cartesiaUsage(),
      dashboard: "https://play.cartesia.ai",
      note: set("CARTESIA_ADMIN_KEY") ? undefined : "Add CARTESIA_ADMIN_KEY (Playground → Keys → Admin) to see Cartesia's own credit usage here.",
    },
    {
      name: "Vercel",
      role: "Hosting: pages and API functions",
      configured: true,
      budgets: [],
      dashboard: "https://vercel.com/dashboard",
      note: "Free (Hobby) plan: function time, bandwidth and invocations are on Vercel's Usage page.",
    },
  ];
  if (!full) {
    techs.push({
      name: "Simulator, SpacetimeDB, Elastic, Fetch.ai agents",
      role: "The flight simulator and everything around it",
      configured: false,
      budgets: [],
      dashboard: "https://github.com/Shanthan2307/DroneX1#run-it",
      note: "Not part of this online demo; visitors are pointed to the contact email.",
    });
  }
  return {
    checkedAt: new Date().toISOString(),
    uptimeS: Math.round(process.uptime()),
    mode: full ? "full" : "configurator",
    contact: contactEmail(),
    techs,
  };
}
