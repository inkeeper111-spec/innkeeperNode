import { describe, expect, it } from 'vitest';
import { formatCurrency } from '../utils/currency.js';

describe('currency formatting', () => {
  it('formats amounts with the configured currency and locale', () => {
    expect(formatCurrency(123456.78, 'INR')).toBe('₹1,23,456.78');
    expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
  });
});
