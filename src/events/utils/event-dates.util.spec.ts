import { getEventEndDateTime, getEventStartDateTime } from './event-dates.util';

describe('event-dates.util', () => {
  describe('getEventStartDateTime', () => {
    it('combines eventDate and startTime', () => {
      const result = getEventStartDateTime({ eventDate: '2026-08-10', startTime: '18:00:00' });
      expect(result).toEqual(new Date('2026-08-10T18:00:00'));
    });
  });

  describe('getEventEndDateTime', () => {
    it('defaults to eventDate when eventEndDate is null (legacy/single-day row)', () => {
      const event = { eventDate: '2026-08-10', eventEndDate: null, startTime: '18:00:00', endTime: '21:00:00' };
      const result = getEventEndDateTime(event);
      expect(result).toEqual(new Date('2026-08-10T21:00:00'));
    });

    it('defaults to eventDate when eventEndDate is undefined (legacy/single-day row)', () => {
      const event = { eventDate: '2026-08-10', startTime: '18:00:00', endTime: '21:00:00' };
      const result = getEventEndDateTime(event);
      expect(result).toEqual(new Date('2026-08-10T21:00:00'));
    });

    it('falls back to startTime when endTime is not set', () => {
      const event = { eventDate: '2026-08-10', startTime: '18:00:00', endTime: undefined };
      const result = getEventEndDateTime(event);
      expect(result).toEqual(new Date('2026-08-10T18:00:00'));
    });

    it('uses eventEndDate (the later date) for a multi-day event instead of the start day', () => {
      // A 3-day fest: starts Day 1, actually wraps up on Day 3.
      const event = { eventDate: '2026-08-10', eventEndDate: '2026-08-12', startTime: '09:00:00', endTime: '22:00:00' };
      const result = getEventEndDateTime(event);
      expect(result).toEqual(new Date('2026-08-12T22:00:00'));
      // Regression guard for the exact bug in loophole.md: end must NOT collapse to Day 1.
      expect(result).not.toEqual(new Date('2026-08-10T22:00:00'));
    });
  });

  describe('payout cron T+3 eligibility (loophole.md regression)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const threeDayFest = {
      eventDate: '2026-08-10',
      eventEndDate: '2026-08-12',
      startTime: '09:00:00',
      endTime: '22:00:00',
    };

    it('is NOT eligible at Day1 + 3 days (the old buggy T+3 point)', () => {
      const eligibleAt = new Date(getEventEndDateTime(threeDayFest).getTime() + 3 * DAY_MS);
      const oldBuggyNow = new Date(getEventStartDateTime(threeDayFest).getTime() + 3 * DAY_MS);
      expect(oldBuggyNow.getTime()).toBeLessThan(eligibleAt.getTime());
    });

    it('IS eligible at Day3 + 3 days (the correct, end-anchored T+3 point)', () => {
      const eligibleAt = new Date(getEventEndDateTime(threeDayFest).getTime() + 3 * DAY_MS);
      const correctNow = new Date(getEventEndDateTime(threeDayFest).getTime() + 3 * DAY_MS);
      expect(correctNow.getTime()).toBeGreaterThanOrEqual(eligibleAt.getTime());
    });

    it('single-day event behavior is unchanged: T+3 eligibility is 3 days after eventDate', () => {
      const singleDayEvent = { eventDate: '2026-08-10', startTime: '09:00:00', endTime: '22:00:00' };
      const eligibleAt = new Date(getEventEndDateTime(singleDayEvent).getTime() + 3 * DAY_MS);
      expect(eligibleAt).toEqual(new Date('2026-08-13T22:00:00'));
    });
  });
});
