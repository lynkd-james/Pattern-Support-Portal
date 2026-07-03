// =============================================================================
// Business-hours calendar math (pure, timezone-aware, no DB).
//
// A BusinessCalendar defines working windows per ISO weekday (1=Mon … 7=Sun) in
// a named IANA timezone, plus holiday dates (YYYY-MM-DD in that timezone). All
// SLA time arithmetic runs on business hours only (per Stage 7). A null calendar
// is treated as 24x7 wall-clock.
//
// Timezone handling uses Intl (full ICU in Node) to derive the zone offset at an
// instant; correct for fixed-offset zones like Africa/Johannesburg (UTC+2, no DST).
// =============================================================================

export interface BusinessWindow {
  day: number; // ISO weekday: 1=Mon … 7=Sun
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface BusinessCalendar {
  timezone: string;
  windows: BusinessWindow[];
  holidays: ReadonlySet<string>; // "YYYY-MM-DD" in the calendar timezone
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 3660; // ~10 years safety bound for iteration

function parseHhMm(s: string): { h: number; m: number } {
  const [h, m] = s.split(":").map((n) => Number(n));
  return { h: h || 0, m: m || 0 };
}

/** Offset (ms) of `tz` at a given UTC instant: (zoned wall clock) - (utc). */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const g: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") g[p.type] = Number(p.value);
  const asUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second);
  return asUtc - utcMs;
}

interface ZonedDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  isoDow: number; // 1=Mon … 7=Sun
  dateKey: string; // YYYY-MM-DD
}

function zonedDate(utcMs: number, tz: string): ZonedDate {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const g: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") g[p.type] = p.value;
  const year = Number(g.year);
  const month = Number(g.month);
  const day = Number(g.day);
  const dowMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const isoDow = dowMap[g.weekday] ?? 1;
  const dateKey = `${g.year}-${g.month}-${g.day}`;
  return { year, month, day, isoDow, dateKey };
}

/** UTC instant for a zoned wall-clock (exact for fixed-offset zones). */
function zonedWallToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  return guess - tzOffsetMs(guess, tz);
}

/** Business window [startMs, endMs) for a given zoned date, or null if non-working. */
function windowForDate(zd: ZonedDate, cal: BusinessCalendar): { startMs: number; endMs: number } | null {
  if (cal.holidays.has(zd.dateKey)) return null;
  const w = cal.windows.find((x) => x.day === zd.isoDow);
  if (!w) return null;
  const s = parseHhMm(w.start);
  const e = parseHhMm(w.end);
  const startMs = zonedWallToUtcMs(zd.year, zd.month, zd.day, s.h, s.m, cal.timezone);
  const endMs = zonedWallToUtcMs(zd.year, zd.month, zd.day, e.h, e.m, cal.timezone);
  return endMs > startMs ? { startMs, endMs } : null;
}

/** Elapsed BUSINESS minutes in [startMs, endMs). Null calendar => 24x7 wall-clock. */
export function businessMinutesBetween(
  startMs: number,
  endMs: number,
  cal: BusinessCalendar | null
): number {
  if (endMs <= startMs) return 0;
  if (!cal) return (endMs - startMs) / 60_000;

  let total = 0;
  // Start iterating from the calendar-local midnight of the start date.
  let cursor = startMs;
  for (let i = 0; i < MAX_DAYS; i += 1) {
    const zd = zonedDate(cursor, cal.timezone);
    const win = windowForDate(zd, cal);
    if (win) {
      const lo = Math.max(startMs, win.startMs);
      const hi = Math.min(endMs, win.endMs);
      if (hi > lo) total += (hi - lo) / 60_000;
    }
    // Advance to the next calendar day (noon-anchored to avoid DST edge drift).
    const nextNoon = zonedWallToUtcMs(zd.year, zd.month, zd.day, 12, 0, cal.timezone) + DAY_MS;
    cursor = nextNoon;
    if (cursor > endMs + DAY_MS) break;
  }
  return total;
}

/** Instant reached by adding `minutes` of BUSINESS time to startMs. Null cal => 24x7. */
export function addBusinessMinutes(
  startMs: number,
  minutes: number,
  cal: BusinessCalendar | null
): number {
  if (minutes <= 0) return startMs;
  if (!cal) return startMs + minutes * 60_000;

  let remainingMs = minutes * 60_000;
  let pos = startMs; // constrains only the first (partial) day
  let anchor = startMs; // used solely to derive the current calendar date
  for (let i = 0; i < MAX_DAYS; i += 1) {
    const zd = zonedDate(anchor, cal.timezone);
    const win = windowForDate(zd, cal);
    if (win) {
      const segStart = Math.max(pos, win.startMs);
      if (segStart < win.endMs) {
        const avail = win.endMs - segStart;
        if (remainingMs <= avail) return segStart + remainingMs;
        remainingMs -= avail;
      }
    }
    // Step to the next calendar day (noon-anchored to avoid DST edge drift);
    // subsequent days are unconstrained, so they begin at their window open.
    anchor = zonedWallToUtcMs(zd.year, zd.month, zd.day, 12, 0, cal.timezone) + DAY_MS;
    pos = Number.NEGATIVE_INFINITY;
  }
  // Exhausted the safety bound; should not happen for sane targets.
  return anchor;
}
