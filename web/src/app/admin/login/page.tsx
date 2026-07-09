// =============================================================================
// /admin/login — staff sign-in (Stage 10b). ONE provider: the separate
// single-tenant admin Entra app (Stage 10a). Deliberately unmistakable as the
// ADMIN entrance (decision D3). Error markers are information-free, matching
// the customer login. Static server render — no client JS.
// =============================================================================

const FONT_STACK = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export default function AdminLoginPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  const failed = Boolean(searchParams?.error);

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[#0A0706] text-[#D9CFBE]"
      style={{ fontFamily: FONT_STACK }}
    >
      <div className="w-full max-w-sm px-6 text-center">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="text-xl font-semibold tracking-tight text-[#F7F2E8]">Pattern</span>
          <span className="rounded bg-[#E8923E] px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-[#0A0706]">
            Admin
          </span>
        </div>
        <h1 className="text-lg font-medium tracking-tight text-[#F7F2E8]">Administration Console</h1>
        <p className="mt-2 text-sm text-[#9C8E78]">
          Pattern staff only. Sign in with your Pattern work account.
        </p>

        {failed && (
          <div className="mt-6 rounded-lg border border-[#E26A60]/40 bg-[rgba(226,106,96,0.16)] px-4 py-3 text-sm text-[#E26A60]">
            Sign-in could not be completed. Please try again.
          </div>
        )}

        <a
          href="/api/admin/auth/login"
          className="mt-8 inline-block w-full rounded-md border border-[#3A2D1F] bg-[#221A11] px-4 py-2.5 text-sm text-[#F7F2E8] transition-colors hover:bg-[#2C2216]"
        >
          Sign in with Microsoft
        </a>
      </div>
    </div>
  );
}
