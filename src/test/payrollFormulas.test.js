import { describe, it, expect } from 'vitest';
import {
  computeStaffPayroll,
  applyAdvanceRecovery,
  validateBasicPercent,
  computeProfessionTax,
  buildAdvanceBreakups
} from '../services/payroll/payrollFormulas.js';
import { summarizeAttendance, buildWHMap } from '../services/payroll/weekoffBuilder.js';
import { evaluateCutoffWindow } from '../services/payroll/cutoff.js';
import dayjs from 'dayjs';

describe('payroll formulas', () => {
  const taxConfig = {
    pfPercent: 12,
    pfActive: true,
    esiPercent: 0.75,
    esiActive: true,
    professionTax: { mode: 'FIXED', fixedAmount: 200 }
  };

  it('prorates monthly wages by payable days and keeps custom deductions fixed', () => {
    const result = computeStaffPayroll({
      staffSalary: {
        wages: 'M',
        salary: 30000,
        basic: 18000,
        allowances: 5000,
        earnings: [{ type: 'HRA', amount: 3000 }],
        deductions: [{ type: 'Uniform', amount: 500 }],
        pfEligible: 'Y',
        esiEligible: 'N'
      },
      taxConfig,
      attendanceSummary: {
        payableDays: 28,
        lop: 2,
        daysInMonth: 30,
        present: 20,
        leave: 2,
        weekOff: 4,
        holiday: 2
      }
    });

    expect(result.grossSalary).toBeCloseTo(28000, 1);
    expect(result.basicSalary).toBeCloseTo(16800, 1);
    expect(result.earnings[0].amount).toBeCloseTo(2800, 1);
    expect(result.deductions[0].amount).toBe(500);
    expect(result.leaveDeduction).toBeCloseTo(2000, 1);
    expect(result.pf).toBeCloseTo(16800 * 0.12, 1);
    expect(result.esi).toBe(0);
    expect(result.professionTax).toBe(200);
    // leaveDeduction NOT subtracted again
    const expectedNetBeforeAdvance =
      result.grossSalary - (result.pf + result.esi + result.professionTax + 500);
    expect(result.remainingSalary).toBeCloseTo(expectedNetBeforeAdvance, 1);
  });

  it('uses daily rate as-is for wages D', () => {
    const result = computeStaffPayroll({
      staffSalary: {
        wages: 'D',
        salary: 1000,
        basic: 600,
        allowances: 0,
        earnings: [],
        deductions: [],
        pfEligible: 'N',
        esiEligible: 'N'
      },
      taxConfig: { ...taxConfig, professionTax: { mode: 'FIXED', fixedAmount: 0 } },
      attendanceSummary: {
        payableDays: 20,
        lop: 5,
        daysInMonth: 30,
        present: 20,
        leave: 0,
        weekOff: 0,
        holiday: 0
      }
    });
    expect(result.grossSalary).toBe(20000);
    expect(result.leaveDeduction).toBe(0);
  });

  it('matches PT slab on configured salary not monthly gross', () => {
    const tax = computeProfessionTax(
      {
        professionTax: {
          mode: 'SLAB',
          slabs: [
            { minSalary: 0, maxSalary: 15000, taxAmount: 0 },
            { minSalary: 15001, maxSalary: 50000, taxAmount: 200 }
          ]
        }
      },
      25000
    );
    expect(tax).toBe(200);
  });

  it('validates basicPercent', () => {
    expect(validateBasicPercent({ basicPercent: 40 }, 25000, 10000).ok).toBe(true);
    expect(validateBasicPercent({ basicPercent: 40 }, 25000, 9000).ok).toBe(false);
  });

  it('recovers advances with partial pay', () => {
    const breakups = [
      { _id: '1', payMonth: '2026-01', payAmount: 5000, balanceAmount: 5000, isPaid: 'N' },
      { _id: '2', payMonth: '2026-02', payAmount: 5000, balanceAmount: 5000, isPaid: 'N' }
    ];
    const { advancePayment, netSalary } = applyAdvanceRecovery(breakups, 7000, '2026-02');
    expect(advancePayment).toBe(7000);
    expect(netSalary).toBe(0);
    expect(breakups[0].isPaid).toBe('Y');
    expect(breakups[1].isPaid).toBe('P');
    expect(breakups[1].balanceAmount).toBe(3000);
  });

  it('builds multi-month breakups', () => {
    const rows = buildAdvanceBreakups({
      advanceAmount: 10000,
      payAmount: 4000,
      effectiveMonth: '2026-01',
      hotelId: 'h',
      staffId: 's',
      advancePaymentId: 'a'
    });
    expect(rows).toHaveLength(3);
    expect(rows[2].payAmount).toBe(2000);
    expect(rows[2].payMonth).toBe('2026-03');
  });
});

describe('attendance helpers', () => {
  it('week-off wins over holiday; unmarked becomes LOP in summary', () => {
    const map = buildWHMap({
      monthYear: '2026-01',
      weekOffCategory: {
        weekOff: {
          week1: ['SUNDAY'], week2: ['SUNDAY'], week3: ['SUNDAY'],
          week4: ['SUNDAY'], week5: ['SUNDAY']
        }
      },
      holidays: [{ date: '2026-01-04' }], // Sunday holiday — W wins
      joiningDate: '2026-01-01'
    });
    expect(map['2026-01-04']).toBe('W');

    const summary = summarizeAttendance(
      [{ attendanceDate: '2026-01-02', status: 'P' }],
      '2026-01',
      '2026-01-01'
    );
    expect(summary.present).toBe(1);
    expect(summary.lop).toBeGreaterThan(0);
  });

  it('pre-join days are LOP', () => {
    const summary = summarizeAttendance([], '2026-01', '2026-01-15');
    expect(summary.lop).toBeGreaterThanOrEqual(14);
  });
});

describe('cutoff window', () => {
  it('detects in/before/after window for next-month cut-off', () => {
    const config = { attendanceCutoffDay: 10, payrollCutoffDay: 10 };
    const before = evaluateCutoffWindow(config, '2026-01', 'payrollCutoffDay', dayjs('2026-01-15'));
    expect(before.status).toBe('before_window');
    const inside = evaluateCutoffWindow(config, '2026-01', 'payrollCutoffDay', dayjs('2026-02-05'));
    expect(inside.status).toBe('in_window');
    const after = evaluateCutoffWindow(config, '2026-01', 'payrollCutoffDay', dayjs('2026-02-15'));
    expect(after.status).toBe('after_window');
    const missing = evaluateCutoffWindow(null, '2026-01', 'payrollCutoffDay', dayjs('2026-02-05'));
    expect(missing.status).toBe('config_missing');
  });
});
