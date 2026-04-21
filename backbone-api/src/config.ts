const UTC_TIMEZONE = "UTC";

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function resolveDefaultTimezone(): string {
  const configured = process.env.DEFAULT_TIMEZONE?.trim();
  if (!configured) return UTC_TIMEZONE;
  return isValidTimezone(configured) ? configured : UTC_TIMEZONE;
}

export const DEFAULT_TIMEZONE = resolveDefaultTimezone();

export function withDefaultTimezone(timezone?: string | null): string {
  const candidate = timezone?.trim();
  if (!candidate) return DEFAULT_TIMEZONE;
  return isValidTimezone(candidate) ? candidate : DEFAULT_TIMEZONE;
}
