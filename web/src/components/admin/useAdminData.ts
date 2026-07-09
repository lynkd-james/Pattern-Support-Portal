"use client";

// =============================================================================
// useAdminData (Stage 10b, refinement R4) — the single fetch wrapper behind
// every admin page, guaranteeing the four specified UI states everywhere:
// loading / empty / error(+retry) / populated. No page invents its own variant.
// =============================================================================

import { useCallback, useEffect, useState } from "react";

export interface AdminDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAdminData<T>(fetcher: () => Promise<T>, deps: unknown[]): AdminDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "Request failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}
