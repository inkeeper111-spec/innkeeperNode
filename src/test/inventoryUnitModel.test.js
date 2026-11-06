import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Unit } from '../models/Unit.js';

describe('inventory unit schema', () => {
  it('requires a hotel, name, symbol, category, and audit users', async () => {
    const unit = new Unit({});
    await expect(unit.validate()).rejects.toMatchObject({
      errors: expect.objectContaining({
        hotelId: expect.any(Object),
        name: expect.any(Object),
        symbol: expect.any(Object),
        category: expect.any(Object),
        createdBy: expect.any(Object),
        updatedBy: expect.any(Object)
      })
    });
  });

  it('normalizes duplicate keys and accepts supported unit categories', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const unit = new Unit({
      hotelId: new mongoose.Types.ObjectId(),
      name: ' Kilogram ',
      symbol: ' KG ',
      category: 'weight',
      createdBy: actorId,
      updatedBy: actorId
    });

    await unit.validate();
    expect(unit.nameKey).toBe('kilogram');
    expect(unit.symbolKey).toBe('kg');
  });
});
