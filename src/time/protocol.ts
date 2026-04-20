import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { withDefaultTimezone } from "../config.js";

export type TimeResolution = {
  ok: boolean;
  isoUtc?: string;
  timezoneUsed?: string;
  confidence: "high" | "medium" | "low";
  needsClarification: boolean;
  reason?: string;
  parsedText?: string;
};

export type DayRange = {
  ok: boolean;
  day?: string;
  timezoneUsed?: string;
  fromUtcIso?: string;
  toUtcIso?: string;
  reason?: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function isIsoDateTime(value: string): boolean {
  if (!value || !value.includes("T")) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function formatDisplayDateTime(iso: string, timezone?: string): string {
  const zone = withDefaultTimezone(timezone);
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(zone);
  if (!dt.isValid) return iso;
  return dt.toFormat("MMM d, yyyy h:mm a ZZZZ");
}

export function resolveDayRange(input: { day?: string; timezone?: string }): DayRange {
  const zone = withDefaultTimezone(input.timezone);
  const day = (input.day ?? DateTime.utc().setZone(zone).toFormat("yyyy-MM-dd")).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, reason: "day must be in YYYY-MM-DD format" };
  }

  const localStart = DateTime.fromFormat(day, "yyyy-MM-dd", { zone }).startOf("day");
  const localEnd = localStart.endOf("day");
  if (!localStart.isValid || !localEnd.isValid) {
    return { ok: false, reason: "Invalid day or timezone" };
  }

  const fromUtcIso = localStart.toUTC().toISO();
  const toUtcIso = localEnd.toUTC().toISO();
  if (!fromUtcIso || !toUtcIso) {
    return { ok: false, reason: "Could not resolve day range" };
  }

  return {
    ok: true,
    day,
    timezoneUsed: zone,
    fromUtcIso,
    toUtcIso,
  };
}

export function resolveTimeExpression(input: {
  expression: string;
  timezone?: string;
  requireTime?: boolean;
  referenceIso?: string;
}): TimeResolution {
  const zone = withDefaultTimezone(input.timezone);
  const reference = input.referenceIso ? new Date(input.referenceIso) : new Date();
  if (Number.isNaN(reference.getTime())) {
    return {
      ok: false,
      confidence: "low",
      needsClarification: true,
      reason: "Invalid reference time",
    };
  }

  const results = chrono.parse(input.expression, reference, { forwardDate: true });
  if (results.length === 0) {
    return {
      ok: false,
      confidence: "low",
      needsClarification: true,
      reason: "Could not parse time expression",
    };
  }

  const best = results[0];
  const start = best.start;

  const dt = start.isCertain("timezoneOffset")
    ? DateTime.fromJSDate(start.date(), { zone: "utc" })
    : DateTime.fromObject(
      {
        year: start.get("year") ?? undefined,
        month: start.get("month") ?? undefined,
        day: start.get("day") ?? undefined,
        hour: start.get("hour") ?? undefined,
        minute: start.get("minute") ?? undefined,
        second: start.get("second") ?? undefined,
        millisecond: start.get("millisecond") ?? undefined,
      },
      { zone },
    );

  if (!dt.isValid) {
    return {
      ok: false,
      confidence: "low",
      needsClarification: true,
      reason: `Parsed date is invalid (${dt.invalidExplanation ?? "unknown reason"})`,
    };
  }

  const hasCertainHour = start.isCertain("hour");
  const requireTime = input.requireTime ?? true;
  const multipleCandidates = results.length > 1;

  const needsClarification = (requireTime && !hasCertainHour) || multipleCandidates;
  const confidence: TimeResolution["confidence"] = needsClarification
    ? "medium"
    : hasCertainHour
      ? "high"
      : "medium";

  return {
    ok: true,
    isoUtc: dt.toUTC().toISO() ?? undefined,
    timezoneUsed: zone,
    confidence,
    needsClarification,
    reason: needsClarification
      ? multipleCandidates
        ? "Expression matched multiple possible dates"
        : "Time was not explicit"
      : undefined,
    parsedText: best.text,
  };
}
