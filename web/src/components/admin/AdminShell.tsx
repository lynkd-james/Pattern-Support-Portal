"use client";

// =============================================================================
// AdminShell (Stage 10b) — the console chrome: top bar with the ADMIN badge
// (unmistakably administrative, decision D3), nav, signed-in identity, logout.
// Identity comes from /api/admin/session; logout POSTs the admin logout (which
// clears ONLY pattern_admin_session — the customer realm is untouched).
// =============================================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { fetchAdminSession, postAdminLogout } from "../../lib/admin/api";
import { useAdminData } from "./useAdminData";

const FONT_STACK = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const NAV: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/tickets", label: "Tickets" },
  { href: "/admin/quarantine", label: "Quarantine" },
  { href: "/admin/sync-runs", label: "Sync Runs" },
  { href: "/admin/audit", label: "Audit" },
];

export default function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const session = useAdminData(() => fetchAdminSession(), []);

  async function logout() {
    await postAdminLogout();
    window.location.assign("/admin/login");
  }

  return (
    <div className="min-h-screen bg-[#0A0706] text-[#D9CFBE]" style={{ fontFamily: FONT_STACK }}>
      <header className="border-b border-[#2A2017] bg-[#120D08]">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold tracking-tight text-[#F7F2E8]">Pattern</span>
            <span className="rounded bg-[#E8923E] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#0A0706]">
              Admin
            </span>
          </div>
          <nav className="flex flex-1 items-center gap-1">
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded px-2.5 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-white/[0.06] text-[#F7F2E8]"
                      : "text-[#9C8E78] hover:bg-white/[0.03] hover:text-[#D9CFBE]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-3 text-xs text-[#9C8E78]">
            <span title={session.data?.role ? `role: ${session.data.role}` : undefined}>
              {session.data?.email ?? ""}
            </span>
            <button
              type="button"
              onClick={logout}
              className="rounded border border-[#3A2D1F] px-2.5 py-1 text-xs text-[#D9CFBE] transition-colors hover:bg-white/[0.04]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
