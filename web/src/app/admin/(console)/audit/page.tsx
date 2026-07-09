// /admin/audit — chronological audit viewer. Thin mount; Suspense for
// useSearchParams (URL-driven filters, R3).
import { Suspense } from "react";
import AuditPage from "../../../../components/admin/AuditPage";
import { LoadingRows } from "../../../../components/admin/ui";

export default function Page() {
  return (
    <Suspense fallback={<LoadingRows rows={10} />}>
      <AuditPage />
    </Suspense>
  );
}
