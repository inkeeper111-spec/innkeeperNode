/**
 * Exact Resilink payroll formulas (no TDS, no wage ceiling, no employer share).
 */

export function dailyRate(amount, wages, daysInMonth) {
  const n = Number(amount) || 0;
  if (wages === 'D') return n;
  return daysInMonth > 0 ? n / daysInMonth : 0;
}

export function computeProfessionTax(taxConfig, configuredSalary) {
  const pt = taxConfig?.professionTax || {};
  if (pt.mode === 'SLAB') {
    const salary = Number(configuredSalary) || 0;
    const slab = (pt.slabs || []).find(
      (s) => salary >= Number(s.minSalary) && salary <= Number(s.maxSalary)
    );
    return slab ? Number(slab.taxAmount) || 0 : 0;
  }
  return Number(pt.fixedAmount) || 0;
}

export function validateBasicPercent(taxConfig, salary, basic) {
  const pct = Number(taxConfig?.basicPercent) || 0;
  if (pct <= 0) return { ok: true };
  const expected = Math.round(((Number(salary) || 0) * pct) / 100);
  const actual = Math.round(Number(basic) || 0);
  if (expected !== actual) {
    return {
      ok: false,
      message: `Basic must equal salary × basicPercent / 100 (${expected}). Got ${actual}.`
    };
  }
  return { ok: true, expected };
}

/**
 * Compute one staff month payroll amounts (before advance recovery).
 */
export function computeStaffPayroll({
  staffSalary,
  taxConfig,
  attendanceSummary
}) {
  const wages = staffSalary.wages || 'M';
  const { payableDays, lop, daysInMonth, present, leave, weekOff, holiday } = attendanceSummary;

  const oneDaySalary = dailyRate(staffSalary.salary, wages, daysInMonth);
  const oneDayBasic = dailyRate(staffSalary.basic, wages, daysInMonth);
  const oneDayAllowance = dailyRate(staffSalary.allowances, wages, daysInMonth);

  const grossSalary = round2(oneDaySalary * payableDays);
  const basicSalary = round2(oneDayBasic * payableDays);
  const allowanceSalary = round2(oneDayAllowance * payableDays);

  const earnings = (staffSalary.earnings || []).map((e) => ({
    type: e.type,
    amount: round2(dailyRate(e.amount, wages, daysInMonth) * payableDays)
  }));

  // Custom deductions: fixed monthly (NOT prorated)
  const deductions = (staffSalary.deductions || []).map((d) => ({
    type: d.type,
    amount: round2(Number(d.amount) || 0)
  }));

  const leaveDeduction = wages === 'M' ? round2(lop * oneDaySalary) : 0;

  const pfEligible = staffSalary.pfEligible === 'Y' && taxConfig?.pfActive !== false;
  const esiEligible = staffSalary.esiEligible === 'Y' && taxConfig?.esiActive !== false;

  const pf = pfEligible ? round2(basicSalary * (Number(taxConfig.pfPercent) || 0) / 100) : 0;
  const esi = esiEligible ? round2(basicSalary * (Number(taxConfig.esiPercent) || 0) / 100) : 0;
  const professionTax = round2(computeProfessionTax(taxConfig, staffSalary.salary));

  const customDeductionTotal = deductions.reduce((s, d) => s + d.amount, 0);

  // leaveDeduction is informational only — LOP already reduced payableDays
  let remainingSalary = round2(
    grossSalary - (pf + esi + professionTax + customDeductionTotal)
  );

  return {
    present,
    leave,
    lop,
    weekOff,
    holiday,
    grossSalary,
    basicSalary,
    allowanceSalary,
    earnings,
    deductions,
    leaveDeduction,
    pf,
    esi,
    professionTax,
    remainingSalary,
    netBeforeAdvance: remainingSalary
  };
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Apply advance recovery on oldest unpaid/partial breakups where payMonth <= monthYear.
 * Mutates breakup docs in memory; caller persists.
 * Returns { advancePayment, netSalary, snapshots }
 */
export function applyAdvanceRecovery(breakups, remainingSalary, monthYear) {
  const snapshots = [];
  let remaining = remainingSalary;
  let advancePayment = 0;

  const eligible = (breakups || [])
    .filter((b) => ['N', 'P'].includes(b.isPaid) && String(b.payMonth) <= String(monthYear))
    .sort((a, b) => String(a.payMonth).localeCompare(String(b.payMonth)));

  for (const b of eligible) {
    snapshots.push({
      breakupId: b._id,
      payMonth: b.payMonth,
      payAmount: b.payAmount,
      balanceAmount: b.balanceAmount,
      isPaid: b.isPaid
    });

    const pending = b.isPaid === 'P'
      ? (Number(b.balanceAmount) || Number(b.payAmount) || 0)
      : (Number(b.payAmount) || 0);

    if (pending <= 0) continue;

    if (remaining >= pending) {
      advancePayment += pending;
      remaining = round2(remaining - pending);
      b.isPaid = 'Y';
      b.balanceAmount = 0;
    } else if (remaining > 0) {
      advancePayment += remaining;
      b.isPaid = 'P';
      b.balanceAmount = round2(pending - remaining);
      remaining = 0;
    }
  }

  return {
    advancePayment: round2(advancePayment),
    netSalary: Math.max(round2(remaining), 0),
    snapshots
  };
}

/**
 * Build multi-month breakups for an advance.
 */
export function buildAdvanceBreakups({ advanceAmount, payAmount, effectiveMonth, hotelId, staffId, advancePaymentId }) {
  const rows = [];
  let remaining = Number(advanceAmount);
  let month = effectiveMonth;
  const installment = Number(payAmount);

  while (remaining > 0.001) {
    const thisPay = Math.min(installment, remaining);
    rows.push({
      hotelId,
      advancePaymentId,
      staffId,
      payMonth: month,
      payAmount: round2(thisPay),
      balanceAmount: round2(thisPay),
      isPaid: 'N'
    });
    remaining = round2(remaining - thisPay);
    month = nextMonthYear(month);
  }
  return rows;
}

export function nextMonthYear(monthYear) {
  const [y, m] = monthYear.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
