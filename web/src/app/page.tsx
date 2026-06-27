import { redirect } from "next/navigation";

// Root route: the only V1 screen is the dashboard. Redirect "/" so the site
// root does not 404. No new screen or behaviour beyond routing.
export default function Home() {
  redirect("/dashboard");
}
