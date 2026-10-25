// The Copilot page: the voice copilot (Cartesia) beside the shared airspace (SpacetimeDB), with the "Built with"
// sidebar saying which sponsor technology does what on this screen. Composition only.
import Link from "next/link";
import AirspaceView from "@/components/airspace/AirspaceView";
import VoiceCopilot from "@/components/copilot/VoiceCopilot";
import TracksPanel from "@/components/tracks/TracksPanel";

export const metadata = { title: "DroneX Copilot" };

export default function CopilotPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#0b0d12", color: "#e6e9ef", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 420px", gridTemplateRows: "auto minmax(0, 1fr)" }}>
      <header style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 12px 140px", borderBottom: "1px solid #1c2130" }}>
        <div>
          <strong style={{ fontSize: 16 }}>DroneX Copilot</strong>
          <span style={{ marginLeft: 12, color: "#9aa3b2", fontSize: 13 }}>speak to fly · the airspace is shared · every number is live</span>
        </div>
        <nav style={{ display: "flex", gap: 14, fontSize: 13 }}>
          <Link href="/" style={{ color: "#9aa3b2" }}>
            Configurator
          </Link>
          <Link href="/scenarios" style={{ color: "#9aa3b2" }}>
            Scenarios
          </Link>
          <a href="http://127.0.0.1:45010/" target="_blank" rel="noreferrer" style={{ color: "#9aa3b2" }}>
            Simulator
          </a>
        </nav>
      </header>
      <section aria-label="Shared airspace" style={{ minHeight: 0, paddingLeft: 120 }}>
        <AirspaceView />
      </section>
      <aside aria-label="Voice copilot" style={{ minHeight: 0, borderLeft: "1px solid #1c2130", overflow: "auto" }}>
        <VoiceCopilot />
      </aside>
      <TracksPanel surface="configurator" />
    </main>
  );
}
