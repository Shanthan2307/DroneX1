// The Dispatch page: DroneX Dispatch (Fetch.ai uAgents, reached from ASI:One) beside the two other engines, with
// the "Built with" sidebar. Composition only; the status comes from /api/dispatch.
import Link from "next/link";
import DispatchPanel from "@/components/dispatch/DispatchPanel";
import TracksPanel from "@/components/tracks/TracksPanel";

export const metadata = { title: "DroneX Dispatch" };

export default function DispatchPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#0b0d12", color: "#e6e9ef" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 12px 140px", borderBottom: "1px solid #1c2130" }}>
        <div>
          <strong style={{ fontSize: 16 }}>DroneX Dispatch</strong>
          <span style={{ marginLeft: 12, color: "#9aa3b2", fontSize: 13 }}>a sentence in ASI:One becomes a verified, flying vehicle</span>
        </div>
        <nav style={{ display: "flex", gap: 14, fontSize: 13 }}>
          <Link href="/" style={{ color: "#9aa3b2" }}>
            Configurator
          </Link>
          <Link href="/copilot" style={{ color: "#9aa3b2" }}>
            Copilot
          </Link>
          <Link href="/scenarios" style={{ color: "#9aa3b2" }}>
            Scenarios
          </Link>
          <a href="http://127.0.0.1:45010/" target="_blank" rel="noreferrer" style={{ color: "#9aa3b2" }}>
            Simulator
          </a>
        </nav>
      </header>
      <div style={{ paddingLeft: 120 }}>
        <DispatchPanel />
      </div>
      <TracksPanel surface="configurator" />
    </main>
  );
}
