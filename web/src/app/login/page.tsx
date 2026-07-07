// =============================================================================
// /login — minimal sign-in screen (Stage 8c: two explicit provider buttons —
// approved temporary UX; email-first provider discovery deferred).
//
// Each button starts its provider's flow. Error markers from the callbacks are
// deliberately information-free (?error=auth => generic retry message);
// identity denials never reach this page (uniform 403 instead).
// =============================================================================

const FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  const failed = searchParams?.error === "auth";

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[#0A0706] text-[#D9CFBE]"
      style={{ fontFamily: FONT_STACK }}
    >
      <div className="w-full max-w-sm px-6 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/pattern-logo.svg"
          alt="Pattern"
          className="mx-auto mb-6 h-10 w-auto"
        />
        <h1 className="text-xl font-medium tracking-tight text-[#F7F2E8]">
          Support Portal
        </h1>
        <p className="mt-2 text-sm text-[#9C8E78]">
          Sign in with your organisation&apos;s work account.
        </p>

        {failed && (
          <div className="mt-6 rounded-lg border border-[#E26A60]/40 bg-[rgba(226,106,96,0.16)] px-4 py-3 text-sm text-[#E26A60]">
            Sign-in could not be completed. Please try again.
          </div>
        )}

        <a
          href="/api/auth/login"
          className="mt-8 inline-block w-full rounded-md border border-[#3A2D1F] bg-[#221A11] px-4 py-2.5 text-sm text-[#F7F2E8] transition-colors hover:bg-[#2C2216]"
        >
          Sign in with Microsoft
        </a>
        <a
          href="/api/auth/google/login"
          className="mt-3 inline-block w-full rounded-md border border-[#3A2D1F] bg-[#221A11] px-4 py-2.5 text-sm text-[#F7F2E8] transition-colors hover:bg-[#2C2216]"
        >
          Sign in with Google
        </a>
      </div>
    </div>
  );
}
