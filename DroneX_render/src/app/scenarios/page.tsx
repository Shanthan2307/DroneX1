// The Scenarios page: one runnable story per sponsor technology, each a real mission in the simulator. Composition
// only; the runs are src/lib/scenarios/run.ts behind /api/scenarios.
import Link from "next/link";
import ScenarioRunner from "@/components/scenarios/ScenarioRunner";
import TracksPanel from "@/components/tracks/TracksPanel";
import SimulatorOff from "@/components/SimulatorOff";
import { contactEmail, simulatorEnabled } from "@/lib/mode";

export const metadata = { title: "DroneX Scenarios" };

export default function ScenariosPage() {
  if (!simulatorEnabled()) return <SimulatorOff title="DroneX Scenarios" what="One real mission per sponsor technology, flown in the simulator over San Francisco." email={contactEmail()} />;
  return (
    <main style={{ minHeight: "100vh", background: "#0b0d12", color: "#e6e9ef" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 12px 140px", borderBottom: "1px solid #1c2130" }}>
        <div>
          <strong style={{ fontSize: 16 }}>DroneX Scenarios</strong>
          <span style={{ marginLeft: 12, color: "#9aa3b2", fontSize: 13 }}>each technology doing the job it is best at, in a real mission over San Francisco</span>
        </div>
        <nav style={{ display: "flex", gap: 14, fontSize: 13 }}>
          <Link href="/" style={{ color: "#9aa3b2" }}>
            Configurator
          </Link>
          <Link href="/copilot" style={{ color: "#9aa3b2" }}>
            Copilot
          </Link>
          <Link href="/dispatch" style={{ color: "#9aa3b2" }}>
            Dispatch
          </Link>
          <a href="http://127.0.0.1:45010/" target="_blank" rel="noreferrer" style={{ color: "#9aa3b2" }}>
            Simulator
          </a>
        </nav>
      </header>
      <div style={{ paddingLeft: 120 }}>
        <ScenarioRunner />
      </div>
      <TracksPanel surface="configurator" />
    </main>
  );
}
