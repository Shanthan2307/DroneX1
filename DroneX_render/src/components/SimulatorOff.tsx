// What a simulator-only page (/copilot, /dispatch, /scenarios) shows in the website-only deployment (lib/mode.ts):
// what the page would do, that the simulator is not part of this demo, and who to email for a session.
import Link from "next/link";

export default function SimulatorOff({ title, what, email }: { title: string; what: string; email: string | null }) {
  return (
    <main style={{ minHeight: "100vh", background: "#0b0d12", color: "#e6e9ef", display: "grid", placeItems: "center", padding: 24 }}>
      <section style={{ maxWidth: 560, lineHeight: 1.6 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>{title}</h1>
        <p style={{ color: "#9aa3b2", margin: "0 0 16px" }}>{what}</p>
        <p style={{ margin: "0 0 20px" }}>
          The flight simulator is not part of this online demo.{" "}
          {email ? (
            <>
              To try it, email <a href={`mailto:${email}?subject=DroneX%20simulator`} style={{ color: "#4ea3ff" }}>{email}</a>.
            </>
          ) : (
            "The full DroneX runs locally with ./dev.sh."
          )}
        </p>
        <Link href="/" style={{ color: "#4ea3ff" }}>
          Back to the configurator
        </Link>
      </section>
    </main>
  );
}
