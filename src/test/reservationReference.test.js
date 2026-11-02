import { describe, expect, it, vi } from 'vitest';
import {
  createReservationWithUniqueReference,
  generateHotelReservationReference
} from '../utils/reservationReference.js';

describe('hotel reservation references', () => {
  it('uses 3 or 4 hotel-name letters, hotel-local date/time, and a random suffix', () => {
    const reference = generateHotelReservationReference(
      'Grand Regal Hotel',
      'America/New_York',
      new Date('2026-11-02T21:26:38.000Z')
    );
    const [, prefix, timestamp, suffix] = reference.match(/^([A-Z]{3,4})-(\d{8}-\d{6})-([A-F0-9]{8})$/) || [];

    expect(prefix).toBeTruthy();
    expect([...prefix].every((letter) => 'GRANDREGALHOTEL'.includes(letter))).toBe(true);
    expect(timestamp).toBe('20261102-162638');
    expect(suffix).toHaveLength(8);
  });

  it('retries duplicate reference collisions before creating the reservation', async () => {
    const duplicateError = Object.assign(new Error('Duplicate reservation reference'), {
      code: 11000,
      keyPattern: { bookingReference: 1 }
    });
    const reservation = { _id: 'reservation-1' };
    const ReservationModel = {
      exists: vi.fn().mockResolvedValue(false),
      create: vi.fn()
        .mockRejectedValueOnce(duplicateError)
        .mockResolvedValueOnce(reservation)
    };

    const created = await createReservationWithUniqueReference(
      ReservationModel,
      { guestName: 'Test Guest' },
      { name: 'Grand Regal Hotel', timezone: 'UTC' }
    );

    expect(created).toBe(reservation);
    expect(ReservationModel.create).toHaveBeenCalledTimes(2);
    expect(ReservationModel.create.mock.calls[0][0].bookingReference)
      .not.toBe(ReservationModel.create.mock.calls[1][0].bookingReference);
  });
});
