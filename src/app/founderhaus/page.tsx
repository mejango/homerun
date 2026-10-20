import type { Metadata } from "next";
import { DemoProjectPage } from "../../components/ProjectPage";
import '../project.css'

export const metadata: Metadata = {
  title: "Founder Haus investment simulator",
  description:
    "Explore asset fundraising, income and sale with the Founder Haus example. All demo figures and actions are illustrative.",
  alternates: { canonical: "/founderhaus" },
};

export default function FounderHausPage() {
  return <DemoProjectPage />;
}
