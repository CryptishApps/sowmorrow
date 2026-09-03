import { Hero } from "@/components/hero";
import { getAppDeployment } from "@/lib/contracts/config";

export default function Home() {
  return <Hero deployment={getAppDeployment()} />;
}
