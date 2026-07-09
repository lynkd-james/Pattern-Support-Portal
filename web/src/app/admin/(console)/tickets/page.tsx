// /admin/tickets — ticket explorer. Thin mount; Suspense is required by
// Next 14 around useSearchParams (the URL is the filter state, R3).
import { Suspense } from "react";
import TicketsPage from "../../../../components/admin/TicketsPage";
import { LoadingRows } from "../../../../components/admin/ui";

export default function Page() {
  return (
    <Suspense fallback={<LoadingRows rows={10} />}>
      <TicketsPage />
    </Suspense>
  );
}
