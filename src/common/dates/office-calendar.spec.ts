import {
  OFFICE_TIME_ZONE,
  formatCalendarDate,
  getOfficeCurrentYear,
  getOfficeToday,
  isFutureOfficeDate,
  parseCalendarDate,
} from './office-calendar';

describe('office-calendar', () => {
  it('uses Africa/Cairo as the fixed office time zone', () => {
    expect(OFFICE_TIME_ZONE).toBe('Africa/Cairo');
  });

  describe('getOfficeToday', () => {
    it('computes today in Africa/Cairo during winter standard time (UTC+2)', () => {
      // 2026-01-15 21:59:59 UTC is 2026-01-15 23:59:59 in Cairo (UTC+2)
      expect(getOfficeToday(new Date('2026-01-15T21:59:59.999Z'))).toBe(
        '2026-01-15',
      );
      // 2026-01-15 22:00:00 UTC is 2026-01-16 00:00:00 in Cairo (UTC+2)
      expect(getOfficeToday(new Date('2026-01-15T22:00:00.000Z'))).toBe(
        '2026-01-16',
      );
    });

    it('computes today in Africa/Cairo during summer daylight saving time (UTC+3)', () => {
      // Egypt observes DST (UTC+3) from last Friday of April to last Thursday of October
      // 2026-07-10 20:59:59 UTC is 2026-07-10 23:59:59 in Cairo (UTC+3)
      expect(getOfficeToday(new Date('2026-07-10T20:59:59.999Z'))).toBe(
        '2026-07-10',
      );
      // 2026-07-10 21:00:00 UTC is 2026-07-11 00:00:00 in Cairo (UTC+3)
      expect(getOfficeToday(new Date('2026-07-10T21:00:00.000Z'))).toBe(
        '2026-07-11',
      );
    });
  });

  describe('parseCalendarDate and formatCalendarDate', () => {
    it('parses valid YYYY-MM-DD calendar dates to UTC midnight without shifting', () => {
      const parsed = parseCalendarDate('2001-09-05');
      expect(parsed).toBeInstanceOf(Date);
      expect(parsed?.toISOString()).toBe('2001-09-05T00:00:00.000Z');
      expect(formatCalendarDate(parsed!)).toBe('2001-09-05');
    });

    it('validates leap years strictly (2000 and 2024 valid; 1900 and 2023 invalid)', () => {
      expect(formatCalendarDate(parseCalendarDate('2000-02-29')!)).toBe(
        '2000-02-29',
      );
      expect(formatCalendarDate(parseCalendarDate('2024-02-29')!)).toBe(
        '2024-02-29',
      );
      expect(parseCalendarDate('1900-02-29')).toBeNull();
      expect(parseCalendarDate('2023-02-29')).toBeNull();
    });

    it('rejects impossible calendar days, months, and non-YYYY-MM-DD formats', () => {
      for (const invalid of [
        '2024-04-31',
        '2024-06-31',
        '2024-13-01',
        '2024-00-10',
        '2024-01-00',
        '0000-01-01',
        '2024-1-1',
        '2024/01/01',
        '2024-01-01T00:00:00Z',
        ' 2024-01-01 ',
        'not-a-date',
        '',
      ]) {
        expect(parseCalendarDate(invalid)).toBeNull();
      }
    });
  });

  describe('isFutureOfficeDate', () => {
    it('compares calendar dates against the current Africa/Cairo office date', () => {
      // 2026-01-15T22:00:00Z -> Cairo date is 2026-01-16
      const now = new Date('2026-01-15T22:00:00.000Z');
      expect(isFutureOfficeDate('2026-01-15', now)).toBe(false);
      expect(isFutureOfficeDate('2026-01-16', now)).toBe(false);
      expect(isFutureOfficeDate('2026-01-17', now)).toBe(true);
    });
  });

  describe('getOfficeCurrentYear', () => {
    it('returns the current Gregorian year in Africa/Cairo across UTC year boundaries', () => {
      // 2026-12-31 21:59:59.999 UTC is 2026-12-31 23:59:59.999 in Cairo (UTC+2)
      expect(getOfficeCurrentYear(new Date('2026-12-31T21:59:59.999Z'))).toBe(
        2026,
      );
      // 2026-12-31 22:00:00.000 UTC is 2027-01-01 00:00:00.000 in Cairo (UTC+2)
      expect(getOfficeCurrentYear(new Date('2026-12-31T22:00:00.000Z'))).toBe(
        2027,
      );
    });
  });
});
