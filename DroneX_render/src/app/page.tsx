// Composition only, no logic.
import BuildAssistant from "@/components/assistant/BuildAssistant";
import AssemblyStage from "@/components/assembly/AssemblyStage";
import { assemblyMarkup } from "@/components/assembly/markup";
import TracksPanel from "@/components/tracks/TracksPanel";

export default function Home() {
  return (
    <>
      <AssemblyStage markup={assemblyMarkup()} />
      <BuildAssistant />
      <TracksPanel surface="configurator" />
    </>
  );
}
