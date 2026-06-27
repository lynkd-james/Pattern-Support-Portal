// Next.js App Router entry for the dashboard route (/dashboard).
// Thin wrapper around the feature component so routing stays separate from UI.
import DashboardPage from "../../components/dashboard/DashboardPage";

export default function Page() {
  return <DashboardPage />;
}
