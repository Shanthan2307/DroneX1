// Composition only, no logic.
import AssemblyStage from "@/components/assembly/AssemblyStage";
import { assemblyMarkup } from "@/components/assembly/markup";
import TracksPanel from "@/components/tracks/TracksPanel";

export default function Home() {
  return (
    <>
      <AssemblyStage markup={assemblyMarkup()} />
      <TracksPanel surface="configurator" />
    </>
  );
}
