"use client";
// Mounts the DroneX configurator front end (prototype/drone-assembly, vanilla three.js) as the app's main screen.
// `markup` is the front end's own index.html body (read on the server by markup.ts), so the elements always match
// what its main.js looks up. The front end is started once on the client.
import { useEffect } from "react";
import "../../../prototype/drone-assembly/src/style.css";

let started = false; // the front end sets up one renderer per page; never start it twice

export default function AssemblyStage({ markup }: { markup: string }) {
  useEffect(() => {
    if (started) return;
    started = true;
    void import("../../../prototype/drone-assembly/src/main.js");
  }, []);

  // display: contents keeps the front end's fixed-position layout exactly as in its own page.
  return <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: markup }} />;
}
