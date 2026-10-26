"use client";
// Mounts the DroneX configurator front end (prototype/drone-assembly, vanilla three.js) as the app's main screen.
// `markup` is the front end's own index.html body (read on the server by markup.ts), so the elements always match
// what its main.js looks up. The front end is started once on the client. Without a simulator (the website-only
// deployment, lib/mode.ts) the body says so, and Fly in simulation shows who to email instead (main.js flyInSim).
import { useEffect } from "react";
import "../../../prototype/drone-assembly/src/style.css";

let started = false; // the front end sets up one renderer per page; never start it twice

export default function AssemblyStage({ markup, simulator = true, contact = null }: { markup: string; simulator?: boolean; contact?: string | null }) {
  useEffect(() => {
    if (started) return;
    started = true;
    if (!simulator) {
      document.body.classList.add("no-simulator");
      if (contact) document.body.dataset.simContact = contact;
    }
    void import("../../../prototype/drone-assembly/src/main.js");
  }, [simulator, contact]);

  // display: contents keeps the front end's fixed-position layout exactly as in its own page.
  return <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: markup }} />;
}
