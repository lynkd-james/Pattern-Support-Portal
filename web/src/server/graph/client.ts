// =============================================================================
// Server-only Microsoft Graph client (app-only / client-credentials).
//
// Centralises Graph access for Stage 6 acknowledgement ingestion: acquires an
// app-only token (cached until near expiry) and reads messages from the shared
// support mailbox. Requires an Entra app registration with the APPLICATION
// permission Mail.Read (admin-consented), ideally restricted to the support
// mailbox via an application access policy.
//
// Retry policy mirrors the ClickUp client: 429 honours Retry-After; 5xx/network
// use bounded exponential backoff with jitter; other 4xx throw immediately.
//
// NOTE (verify on first live run): the exact `/users/{mailbox}/messages` filter
// + $orderby on receivedDateTime and cross-folder coverage are encoded to the
// documented Graph v1.0 contract but were not runnable in this environment.
// IMPORTANT: server-only — never import from client code.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("graph/client.ts is server-only.");
}

import type { Logger } from "../logger";
import type { GraphMessagesResponse, GraphTokenResponse } from "./types";

const LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MESSAGE_SELECT =
  "id,internetMessageId,subject,bodyPreview,from,sentDateTime,receivedDateTime";

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export interface GraphClientOptions {
  maxRetries?: number;
  maxRateLimitWaits?: number;
  logger?: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function backoffMs(attempt: number): number {
  const base = 500;
  const cap = 15_000;
  const exp = Math.min(cap, base * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);
}

export class GraphClient {
  private readonly maxRetries: number;
  private readonly maxRateLimitWaits: number;
  private readonly logger?: Logger;

  private token: string | null = null;
  private tokenExpiresAt = 0; // epoch ms

  constructor(
    private readonly creds: { tenantId: string; clientId: string; clientSecret: string },
    opts: GraphClientOptions = {}
  ) {
    this.maxRetries = opts.maxRetries ?? 4;
    this.maxRateLimitWaits = opts.maxRateLimitWaits ?? 5;
    this.logger = opts.logger;
  }

  private async getToken(): Promise<string> {
    // Reuse the cached token until 60s before expiry.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

    const url = `${LOGIN_BASE}/${this.creds.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new GraphError(res.status, errBody, `Graph token request failed with ${res.status}`);
    }
    const json = (await res.json()) as GraphTokenResponse;
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.token;
  }

  /** GET an absolute Graph URL (used for both first page and @odata.nextLink). */
  async get<T>(url: string): Promise<T> {
    let retries = 0;
    let rateWaits = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = await this.getToken();
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
      } catch (netErr) {
        if (retries < this.maxRetries) {
          const wait = backoffMs(retries++);
          this.logger?.warn("graph_network_retry", {
            attempt: retries,
            waitMs: Math.round(wait),
            reason: netErr instanceof Error ? netErr.message : String(netErr),
          });
          await sleep(wait);
          continue;
        }
        throw new GraphError(0, String(netErr), "Graph network error");
      }

      if (res.ok) return (await res.json()) as T;

      if (res.status === 429 && rateWaits < this.maxRateLimitWaits) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 + 250 : backoffMs(rateWaits + 1);
        this.logger?.warn("graph_rate_limited", { waitMs: Math.round(wait), rateWait: rateWaits + 1 });
        rateWaits += 1;
        await sleep(wait);
        continue;
      }
      if (res.status === 401 && retries < 1) {
        // Token may have been revoked/expired early; force refresh once.
        this.token = null;
        retries += 1;
        continue;
      }
      if (res.status >= 500 && retries < this.maxRetries) {
        const wait = backoffMs(retries++);
        this.logger?.warn("graph_server_retry", { status: res.status, attempt: retries, waitMs: Math.round(wait) });
        await sleep(wait);
        continue;
      }

      const body = await res.json().catch(() => null);
      throw new GraphError(res.status, body, `Graph GET failed with ${res.status}`);
    }
  }

  /**
   * First page of messages in a mailbox, oldest-received first. When `sinceIso`
   * is provided, only messages with receivedDateTime >= sinceIso are returned.
   * Caller follows `@odata.nextLink` via get() for subsequent pages.
   */
  listMessagesFirstPage(
    mailbox: string,
    params: { sinceIso?: string; top?: number }
  ): Promise<GraphMessagesResponse> {
    const u = new URL(`${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages`);
    u.searchParams.set("$select", MESSAGE_SELECT);
    u.searchParams.set("$orderby", "receivedDateTime asc");
    u.searchParams.set("$top", String(params.top ?? 50));
    if (params.sinceIso) {
      u.searchParams.set("$filter", `receivedDateTime ge ${params.sinceIso}`);
    }
    return this.get<GraphMessagesResponse>(u.toString());
  }
}
