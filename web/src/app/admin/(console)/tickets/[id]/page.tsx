// /admin/tickets/[id] — full internal detail. Thin mount only.
import TicketDetailPage from "../../../../../components/admin/TicketDetailPage";

export default function Page({ params }: { params: { id: string } }) {
  return <TicketDetailPage id={params.id} />;
}
