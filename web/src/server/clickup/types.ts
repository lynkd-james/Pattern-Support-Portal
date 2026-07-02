// =============================================================================
// Typed shapes for the subset of the ClickUp v2 REST API we consume.
// Only the fields the ingestion subsystem reads are modelled; ClickUp returns
// much more. All optional fields are treated defensively at the call site.
// =============================================================================

export interface ClickUpStatus {
  status: string; // e.g. "to do", "in progress" (lower-cased by ClickUp)
  type?: string; // "open" | "custom" | "closed" | "done"
  orderindex?: number;
}

export interface ClickUpFieldOption {
  id: string;
  /** Label fields use `label`; drop-downs use `name`. */
  label?: string;
  name?: string;
  orderindex?: number;
}

export interface ClickUpTypeConfig {
  options?: ClickUpFieldOption[];
}

export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string; // "labels" | "drop_down" | "short_text" | ...
  type_config?: ClickUpTypeConfig;
  /** For label fields: array of selected option ids. */
  value?: unknown;
}

export interface ClickUpTaskList {
  id: string;
  name?: string;
}

export interface ClickUpTask {
  id: string;
  custom_id?: string | null; // e.g. "PAT3-3910" — our ticket_number
  name: string;
  description?: string | null;
  text_content?: string | null;
  status: ClickUpStatus;
  date_created?: string | null; // epoch ms as string
  date_updated?: string | null; // epoch ms as string
  date_closed?: string | null; // epoch ms as string
  custom_fields?: ClickUpCustomField[];
  list?: ClickUpTaskList;
}

export interface ClickUpList {
  id: string;
  name: string;
  archived?: boolean;
}

export interface FolderListsResponse {
  lists: ClickUpList[];
}

export interface FilteredTasksResponse {
  tasks: ClickUpTask[];
  last_page?: boolean;
}
