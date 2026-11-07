import { describe, expect, it } from 'vitest';
import {
  convertQuantityToBase, getItemUnitConfiguration, getUnitConversionFactor
} from '../config/inventoryUnits.js';

describe('inventory unit conversions', () => {
  it('converts standard units into the configured base unit', () => {
    expect(convertQuantityToBase({ name: 'Rice', baseUnit: 'g' }, 25, 'kg').quantity).toBe(25000);
    expect(convertQuantityToBase({ name: 'Oil', baseUnit: 'ml' }, 15, 'L').quantity).toBe(15000);
    expect(convertQuantityToBase({ name: 'Eggs', baseUnit: 'pcs' }, 2, 'dozen').quantity).toBe(24);
  });

  it('uses explicit package factors and retains multiple package options', () => {
    const configuration = getItemUnitConfiguration({
      baseUnit: 'g',
      purchaseUnit: 'bag',
      purchaseConversionFactor: 25010,
      packagingOptions: [{ unit: 'carton', conversionFactor: 50100 }]
    });
    const item = { name: 'Rice', ...configuration };

    expect(configuration.packagingOptions).toHaveLength(2);
    expect(convertQuantityToBase(item, 3, 'bag').quantity).toBe(75030);
    expect(convertQuantityToBase(item, 1, 'carton').quantity).toBe(50100);
  });

  it('does not allow cross-category conversion without an explicit product factor', () => {
    const oil = { name: 'Oil', baseUnit: 'ml' };
    expect(() => getUnitConversionFactor(oil, 'kg')).toThrow(/not configured/);
    expect(convertQuantityToBase({
      ...oil,
      unitConversions: { kg: 900 }
    }, 1, 'kg').quantity).toBe(900);
  });

  it('rejects invalid and mismatched factors', () => {
    expect(() => getItemUnitConfiguration({
      baseUnit: 'g', purchaseUnit: 'bag', purchaseConversionFactor: 0
    })).toThrow(/product-specific conversion factor/);
    expect(() => getItemUnitConfiguration({
      baseUnit: 'g',
      purchaseUnit: 'kg',
      purchaseConversionFactor: 1
    })).toThrow(/standard unit conversion/);
  });
});
