// =============================================================================
// Server-only ClickUp API client.
//
// Centralises ALL ClickUp access: auth, retries, and rate-limit handling. The
// token is sent RAW in the Authorization header (ClickUp v2 does NOT use a
// "Bearer" prefix — a Bearer prefix returns 401).
//
// Retry policy:
//   * 429  -> wait for X-RateLimit-Reset / Retry-After, then retry.
//   * 5xx / network -> bounded exponential backoff with jitter.
//   * other 4xx -> throw immediately (non-retryable).
//
// IMPORTANT: server-only — never import from client code.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("clickup/client.ts is server-only.");
}

import type { Logger } from "../logger";
import type {
  ClickUpList,
  FilteredTasksResponse,
  FolderListsResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://api.clickup.com/api/v2";

export class ClickUpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = "ClickUpError";
  }
}

type QueryValue = string | number | boolean | ReadonlyArray<string | number>;
type Query = Record<string, QueryValue | undefined>;

export interface ClickUpClientOptions {
  baseUrl?: string;
  maxRetries?: number; // for 5xx / network
  maxRateLimitWaits?: number; // for 429
  logger?: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  const base = 500;
  const cap = 15_000;
  const exp = Math.min(cap, base * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2); // full-ish jitter
}

export class ClickUpClient {
  private readonly base: string;
  private readonly maxRetries: number;
  private readonly maxRateLimitWaits: number;
  private readonly logger?: Logger;

  constructor(private readonly token: string, opts: ClickUpClientOptions = {}) {
    this.base = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.maxRetries = opts.maxRetries ?? 4;
    this.maxRateLimitWaits = opts.maxRateLimitWaits ?? 5;
    this.logger = opts.logger;
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.base + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private rateLimitWaitMs(res: Response): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000) + 250;
    }
    const reset = res.headers.get("x-ratelimit-reset");
    if (reset) {
      const resetSecs = Number(reset);
      if (Number.isFinite(resetSecs)) {
        return Math.max(0, resetSecs * 1000 - Date.now()) + 250;
      }
    }
    return 2000;
  }

  async request<T>(path: string, query?: Query): Promise<T> {
    const url = this.buildUrl(path, query);
    let retries = 0;
    let rateWaits = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.token,
            "Content-Type": "application/json",
          },
        });
      } catch (netErr) {
        if (retries < this.maxRetries) {
          const wait = backoffMs(retries++);
          this.logger?.warn("clickup_network_retry", {
            path,
            attempt: retries,
            waitMs: Math.round(wait),
            reason: netErr instanceof Error ? netErr.message : String(netErr),
          });
          await sleep(wait);
          continue;
        }
        throw new ClickUpError(0, String(netErr), `ClickUp network error on ${path}`);
      }

      if (res.ok) {
        return (await res.json()) as T;
      }

      if (res.status === 429 && rateWaits < this.maxRateLimitWaits) {
        const wait = this.rateLimitWaitMs(res);
        this.logger?.warn("clickup_rate_limited", {
          path,
          waitMs: Math.round(wait),
          rateWait: rateWaits + 1,
        });
        rateWaits += 1;
        await sleep(wait);
        continue;
      }

      if (res.status >= 500 && retries < this.maxRetries) {
        const wait = backoffMs(retries++);
        this.logger?.warn("clickup_server_retry", {
          path,
          status: res.status,
          attempt: retries,
          waitMs: Math.round(wait),
        });
        await sleep(wait);
        continue;
      }

      const body = await res.json().catch(() => null);
      throw new ClickUpError(
        res.status,
        body,
        `ClickUp GET ${path} failed with ${res.status}`
      );
    }
  }

  /**
   * Lists inside a folder — BOTH active and archived. The `archived` query param
   * is a per-request toggle (ClickUp docs: Get Lists), so both are fetched and
   * merged; otherwise archived weekly lists (past sprints) would be invisible.
   */
  async getFolderLists(
    folderId: string,
    includeArchived = true
  ): Promise<FolderListsResponse> {
    const requests = [
      this.request<FolderListsResponse>(`/folder/${folderId}/list`, { archived: "false" }),
    ];
    if (includeArchived) {
      requests.push(
        this.request<FolderListsResponse>(`/folder/${folderId}/list`, { archived: "true" })
      );
    }
    const responses = await Promise.all(requests);
    const byId = new Map<string, ClickUpList>();
    for (const r of responses) for (const l of r.lists ?? []) byId.set(l.id, l);
    return { lists: [...byId.values()] };
  }

  /**
   * Filtered workspace tasks. We page by `date_updated_gt` ascending so the
   * watermark can advance safely. Caller paginates via `page`.
   */
  getFilteredTeamTasks(
    teamId: string,
    params: {
      listIds: ReadonlyArray<string>;
      dateUpdatedGt: number;
      page: number;
      includeClosed?: boolean;
    }
  ): Promise<FilteredTasksResponse> {
    return this.request<FilteredTasksResponse>(`/team/${teamId}/task`, {
      page: params.page,
      order_by: "updated",
      reverse: "true", // ascending (oldest-updated first)
      include_closed: params.includeClosed === false ? "false" : "true",
      subtasks: "false",
      date_updated_gt: params.dateUpdatedGt,
      "list_ids[]": params.listIds as string[],
    });
  }

  /**
   * Tasks in a single list. Unlike the team-filtered endpoint, this endpoint
   * supports the `archived` param (ClickUp docs: Get Tasks), so it is used to
   * retrieve archived tasks that the team endpoint cannot return.
   */
  getListTasks(
    listId: string,
    params: {
      dateUpdatedGt: number;
      page: number;
      archived: boolean;
      includeClosed?: boolean;
    }
  ): Promise<FilteredTasksResponse> {
    return this.request<FilteredTasksResponse>(`/list/${listId}/task`, {
      page: params.page,
      order_by: "updated",
      reverse: "true",
      include_closed: params.includeClosed === false ? "false" : "true",
      subtasks: "false",
      archived: params.archived ? "true" : "false",
      date_updated_gt: params.dateUpdatedGt,
    });
  }
}
