// Composition only, no logic.
import AssemblyStage from "@/components/assembly/AssemblyStage";
import { assemblyMarkup } from "@/components/assembly/markup";

export default function Home() {
  return <AssemblyStage markup={assemblyMarkup()} />;
}
