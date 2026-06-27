// =============================================================================
// FilterBar — drives the list query (search, business unit, stage, priority).
// Changing any filter triggers a single /api/tickets fetch upstream; the summary
// cards then recompute from that response. Business units come from the session.
// =============================================================================

import type {
  BusinessUnitRef,
  PortalStage,
  PriorityLevel,
} from "../../lib/types";
import { PRIORITY_LABELS, STAGE_LABELS } from "../../lib/display";

export interface DashboardFilters {
  search: string;
  businessUnitId: string | null;
  stage: PortalStage | null;
  priority: PriorityLevel | null;
}

interface Props {
  filters: DashboardFilters;
  businessUnits: BusinessUnitRef[];
  onChange: (next: DashboardFilters) => void;
}

const STAGES = Object.keys(STAGE_LABELS) as PortalStage[];
const PRIORITIES = Object.keys(PRIORITY_LABELS) as PriorityLevel[];

const selectClass =
  "h-9 rounded-md border border-[#3A2D1F] bg-[#1B140D] px-3 text-sm text-[#D9CFBE] " +
  "placeholder:text-[#5C5142] focus:border-[#E8923E]/60 focus:outline-none " +
  "focus:ring-2 focus:ring-[rgba(232,146,62,0.34)]";

export default function FilterBar({ filters, businessUnits, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        type="search"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        placeholder="Search title or ticket #"
        className={`${selectClass} w-64`}
        aria-label="Search tickets"
      />

      <select
        className={selectClass}
        value={filters.businessUnitId ?? ""}
        onChange={(e) =>
          onChange({ ...filters, businessUnitId: e.target.value || null })
        }
        aria-label="Filter by business unit"
      >
        <option value="">All business units</option>
        {businessUnits.map((bu) => (
          <option key={bu.id} value={bu.id}>
            {bu.name}
          </option>
        ))}
      </select>

      <select
        className={selectClass}
        value={filters.stage ?? ""}
        onChange={(e) =>
          onChange({
            ...filters,
            stage: (e.target.value || null) as PortalStage | null,
          })
        }
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>

      <select
        className={selectClass}
        value={filters.priority ?? ""}
        onChange={(e) =>
          onChange({
            ...filters,
            priority: (e.target.value || null) as PriorityLevel | null,
          })
        }
        aria-label="Filter by priority"
      >
        <option value="">All priorities</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </option>
        ))}
      </select>
    </div>
  );
}
