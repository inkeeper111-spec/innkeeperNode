import { describe, expect, it } from 'vitest';
import { combineHotelDateAndTime } from '../utils/reservationDates.js';

describe('hotel-local reservation schedule', () => {
  it('converts configured local times to the correct UTC instant', () => {
    expect(combineHotelDateAndTime('2026-11-02', '12:00', 'America/New_York')?.toISOString())
      .toBe('2026-11-02T17:00:00.000Z');
  });

  it('rejects invalid times and local times skipped by daylight-saving changes', () => {
    expect(combineHotelDateAndTime('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(combineHotelDateAndTime('2026-03-08', '25:30', 'America/New_York')).toBeNull();
  });
});
