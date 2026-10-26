// Composition only, no logic.
import BuildAssistant from "@/components/assistant/BuildAssistant";
import AssemblyStage from "@/components/assembly/AssemblyStage";
import { assemblyMarkup } from "@/components/assembly/markup";
import TracksPanel from "@/components/tracks/TracksPanel";
import { contactEmail, simulatorEnabled } from "@/lib/mode";

export default function Home() {
  return (
    <>
      <AssemblyStage markup={assemblyMarkup()} simulator={simulatorEnabled()} contact={contactEmail()} />
      <BuildAssistant />
      <TracksPanel surface="configurator" />
    </>
  );
}
