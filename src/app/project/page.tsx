import type { Metadata } from "next";
import { LocalProjectPreview } from "../../components/ProjectPage";

export const metadata: Metadata = {
  title: "Project preview",
  robots: { index: false, follow: false },
};

export default function LegacyProjectPage() {
  return <LocalProjectPreview />;
}
