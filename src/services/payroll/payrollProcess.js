import dayjs from 'dayjs';
import mongoose from 'mongoose';
import { StaffProfile } from '../../models/StaffProfile.js';
import { StaffSalary } from '../../models/StaffSalary.js';
import { StaffTaxConfig } from '../../models/StaffTaxConfig.js';
import { GlobalConfiguration } from '../../models/GlobalConfiguration.js';
import { SalaryAttendance } from '../../models/SalaryAttendance.js';
import { AttendanceLock } from '../../models/AttendanceLock.js';
import { StaffHoliday } from '../../models/StaffHoliday.js';
import { WeekoffCategory } from '../../models/WeekoffCategory.js';
import { MonthlyPayroll } from '../../models/MonthlyPayroll.js';
import { PayrollBackup } from '../../models/PayrollBackup.js';
import { AdvancePaymentBreakup } from '../../models/AdvancePaymentBreakup.js';
import { getCutoffStatus, assertInWindow } from './cutoff.js';
import { seedAttendanceRows, summarizeAttendance } from './weekoffBuilder.js';
import { computeStaffPayroll, applyAdvanceRecovery } from './payrollFormulas.js';

async function revertPayrollAdvances(hotelId, monthYear) {
  const backups = await PayrollBackup.find({ hotelId, monthYear });
  for (const backup of backups) {
    for (const old of backup.oldAdvanceData || []) {
      await AdvancePaymentBreakup.findByIdAndUpdate(old.breakupId, {
        payAmount: old.payAmount,
        balanceAmount: old.balanceAmount,
        isPaid: old.isPaid
      });
    }
  }
}

async function ensurePeriodActive(hotelId, monthYear) {
  let period = await MonthlyPayroll.findOne({
    hotelId,
    monthYear,
    isPeriodConfig: true
  });
  if (!period) {
    // Create period config row using a placeholder staff/user — store on a synthetic doc
    // We use staffId = hotelId as sentinel for period config when no staff yet is awkward.
    // Better: use null staff with sparse — but schema requires staffId.
    // Period status is stored on isPeriodConfig docs; create with first staff or dedicated marker.
    period = await MonthlyPayroll.create({
      hotelId,
      staffId: hotelId, // sentinel ObjectId-compatible hotel id for period config only
      userId: hotelId,
      monthYear,
      isPeriodConfig: true,
      payrollPeriodStatus: 'active',
      netSalary: 0,
      grossSalary: 0
    });
  }
  if (period.payrollPeriodStatus !== 'active') {
    const err = new Error('Payroll period is inactive. Activate the period before running payroll.');
    err.statusCode = 400;
    err.code = 'PERIOD_INACTIVE';
    throw err;
  }
  return period;
}

export async function runMonthlyPayroll({ hotelId, monthYear, userId }) {
  if (!/^\d{4}-\d{2}$/.test(monthYear)) {
    const err = new Error('monthYear must be YYYY-MM');
    err.statusCode = 400;
    throw err;
  }

  await ensurePeriodActive(hotelId, monthYear);

  const config = await GlobalConfiguration.findOne({ hotelId });
  if (!config) {
    const err = new Error('Global Configuration is required before running payroll.');
    err.statusCode = 400;
    err.code = 'CONFIG_MISSING';
    throw err;
  }

  const cutoff = await getCutoffStatus(hotelId, monthYear, 'payroll');
  assertInWindow(cutoff);

  const taxConfig = await StaffTaxConfig.findOne({ hotelId }).lean();
  if (!taxConfig) {
    const err = new Error('Staff Tax / Statutory configuration is required.');
    err.statusCode = 400;
    err.code = 'TAX_CONFIG_MISSING';
    throw err;
  }

  const monthEnd = dayjs(`${monthYear}-01`).endOf('month').toDate();
  const profiles = await StaffProfile.find({
    hotelId,
    status: { $ne: 'terminated' },
    joiningDate: { $lte: monthEnd }
  }).lean();

  if (!profiles.length) {
    const err = new Error('No eligible staff found for this period.');
    err.statusCode = 400;
    throw err;
  }

  const staffIds = profiles.map((p) => p._id);
  const salaries = await StaffSalary.find({
    hotelId,
    staffId: { $in: staffIds },
    isActive: true
  }).lean();
  const salaryByStaff = new Map(salaries.map((s) => [String(s.staffId), s]));

  const missingSalary = profiles.filter((p) => !salaryByStaff.has(String(p._id)));
  if (missingSalary.length) {
    const err = new Error(
      `Staff salary setup missing for ${missingSalary.length} staff: ${missingSalary
        .map((p) => p.employeeId)
        .join(', ')}`
    );
    err.statusCode = 400;
    err.code = 'SALARY_MISSING';
    throw err;
  }

  const locks = await AttendanceLock.find({
    hotelId,
    staffId: { $in: staffIds },
    monthYear,
    status: 'A'
  }).lean();
  const locked = new Set(locks.map((l) => String(l.staffId)));
  const missingLocks = profiles.filter((p) => !locked.has(String(p._id)));
  if (missingLocks.length) {
    const err = new Error(
      `Attendance not locked/approved for ${missingLocks.length} staff. Save attendance for all staff first.`
    );
    err.statusCode = 400;
    err.code = 'ATTENDANCE_LOCK_MISSING';
    throw err;
  }

  // Revert prior advances from backup, then delete non-config payroll rows
  await revertPayrollAdvances(hotelId, monthYear);
  await MonthlyPayroll.deleteMany({ hotelId, monthYear, isPeriodConfig: false });
  await PayrollBackup.deleteMany({ hotelId, monthYear });

  const holidays = await StaffHoliday.find({
    hotelId,
    isActive: { $ne: false },
    date: {
      $gte: dayjs(`${monthYear}-01`).startOf('month').toDate(),
      $lte: dayjs(`${monthYear}-01`).endOf('month').toDate()
    }
  }).lean();

  const weekOffIds = [...new Set(salaries.map((s) => s.weekOff).filter(Boolean))];
  const weekOffs = await WeekoffCategory.find({ _id: { $in: weekOffIds } }).lean();
  const weekOffById = new Map(weekOffs.map((w) => [String(w._id), w]));

  const results = [];

  for (const profile of profiles) {
    const staffSalary = salaryByStaff.get(String(profile._id));
    const weekOffCategory = staffSalary.weekOff
      ? weekOffById.get(String(staffSalary.weekOff))
      : null;

    let attendanceRows = await SalaryAttendance.find({
      hotelId,
      staffId: profile._id,
      attendanceDate: {
        $gte: dayjs(`${monthYear}-01`).startOf('month').toDate(),
        $lte: dayjs(`${monthYear}-01`).endOf('month').toDate()
      }
    });

    if (!attendanceRows.length) {
      const seeds = seedAttendanceRows({
        monthYear,
        staffId: profile._id,
        userId: profile.userId,
        hotelId,
        weekOffCategory,
        holidays,
        joiningDate: profile.joiningDate
      });
      if (seeds.length) {
        await SalaryAttendance.insertMany(seeds, { ordered: false }).catch(() => {});
        attendanceRows = await SalaryAttendance.find({
          hotelId,
          staffId: profile._id,
          attendanceDate: {
            $gte: dayjs(`${monthYear}-01`).startOf('month').toDate(),
            $lte: dayjs(`${monthYear}-01`).endOf('month').toDate()
          }
        });
      }
    }

    const summary = summarizeAttendance(
      attendanceRows,
      monthYear,
      profile.joiningDate
    );
    const computed = computeStaffPayroll({
      staffSalary,
      taxConfig,
      attendanceSummary: summary
    });

    const breakups = await AdvancePaymentBreakup.find({
      hotelId,
      staffId: profile._id,
      isPaid: { $in: ['N', 'P'] },
      payMonth: { $lte: monthYear }
    });

    const { advancePayment, netSalary, snapshots } = applyAdvanceRecovery(
      breakups,
      computed.remainingSalary,
      monthYear
    );

    await PayrollBackup.findOneAndUpdate(
      { hotelId, staffId: profile._id, monthYear },
      { hotelId, staffId: profile._id, monthYear, oldAdvanceData: snapshots },
      { upsert: true }
    );

    for (const b of breakups) {
      await b.save();
    }

    const row = await MonthlyPayroll.create({
      hotelId,
      staffId: profile._id,
      userId: profile.userId,
      monthYear,
      present: computed.present,
      leave: computed.leave,
      lop: computed.lop,
      weekOff: computed.weekOff,
      holiday: computed.holiday,
      grossSalary: computed.grossSalary,
      basicSalary: computed.basicSalary,
      allowanceSalary: computed.allowanceSalary,
      earnings: computed.earnings,
      deductions: computed.deductions,
      leaveDeduction: computed.leaveDeduction,
      pf: computed.pf,
      esi: computed.esi,
      professionTax: computed.professionTax,
      advancePayment,
      netSalary,
      isPeriodConfig: false,
      payrollPeriodStatus: 'active'
    });

    results.push(row);
  }

  return {
    monthYear,
    processed: results.length,
    totalNet: results.reduce((s, r) => s + (r.netSalary || 0), 0),
    totalGross: results.reduce((s, r) => s + (r.grossSalary || 0), 0),
    records: results,
    processedBy: userId
  };
}

export async function getPreviousSixMonthData(hotelId) {
  const months = [];
  let cursor = dayjs().subtract(1, 'month').startOf('month');
  for (let i = 0; i < 6; i += 1) {
    months.unshift(cursor.format('YYYY-MM'));
    cursor = cursor.subtract(1, 'month');
  }

  const rows = await MonthlyPayroll.aggregate([
    {
      $match: {
        hotelId: mongoose.Types.ObjectId.isValid(hotelId)
          ? new mongoose.Types.ObjectId(hotelId)
          : hotelId,
        monthYear: { $in: months },
        isPeriodConfig: false
      }
    },
    {
      $group: {
        _id: '$monthYear',
        totalExpense: { $sum: '$netSalary' },
        totalGross: { $sum: '$grossSalary' },
        staffCount: { $sum: 1 }
      }
    }
  ]);

  const byMonth = new Map(rows.map((r) => [r._id, r]));
  return months.map((m) => ({
    monthYear: m,
    totalExpense: byMonth.get(m)?.totalExpense || 0,
    totalGross: byMonth.get(m)?.totalGross || 0,
    staffCount: byMonth.get(m)?.staffCount || 0
  }));
}
