// =============================================================================
// Console layout (Stage 10b) — mounts AdminShell around every console page.
// /admin/login sits OUTSIDE this route group, so the shell (and its session
// fetch) never wraps the sign-in screen. Thin mount only (invariant 10b-2).
// =============================================================================

import type { ReactNode } from "react";
import AdminShell from "../../../components/admin/AdminShell";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
