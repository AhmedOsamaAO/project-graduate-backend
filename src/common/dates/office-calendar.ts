export const OFFICE_TIME_ZONE = 'Africa/Cairo';

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const OFFICE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: OFFICE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/** Formats an instant as a YYYY-MM-DD calendar date in the fixed office calendar (Africa/Cairo). */
export function getOfficeToday(now: Date = new Date()): string {
  const parts = OFFICE_DATE_FORMATTER.formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('Failed to format Africa/Cairo calendar date');
  }

  return `${year.padStart(4, '0')}-${month}-${day}`;
}

/** Validates a strict YYYY-MM-DD calendar date without timezone conversion, returning UTC midnight. */
export function parseCalendarDate(value: string): Date | null {
  if (typeof value !== 'string' || !CALENDAR_DATE_PATTERN.test(value)) {
    return null;
  }

  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** Formats a UTC calendar Date (e.g., PostgreSQL DATE) as YYYY-MM-DD without local-timezone conversion. */
export function formatCalendarDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Returns true if a valid YYYY-MM-DD calendar date falls after today in Africa/Cairo. */
export function isFutureOfficeDate(calendarDate: string, now?: Date): boolean {
  return calendarDate > getOfficeToday(now);
}

/** Returns the current Gregorian calendar year in the fixed office calendar (Africa/Cairo). */
export function getOfficeCurrentYear(now: Date = new Date()): number {
  return Number(getOfficeToday(now).slice(0, 4));
}
