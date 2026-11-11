import dayjs from 'dayjs';
import { SalaryAttendance } from '../../models/SalaryAttendance.js';
import { AttendanceLock } from '../../models/AttendanceLock.js';
import { StaffProfile } from '../../models/StaffProfile.js';
import { StaffSalary } from '../../models/StaffSalary.js';
import { StaffHoliday } from '../../models/StaffHoliday.js';
import { WeekoffCategory } from '../../models/WeekoffCategory.js';
import { StaffLeaveConfig } from '../../models/StaffLeaveConfig.js';
import { StaffLeave } from '../../models/StaffLeave.js';
import { getCutoffStatus, assertInWindow } from '../../services/payroll/cutoff.js';
import {
  seedAttendanceRows,
  summarizeAttendance,
  countLeaveByType,
  buildWHMap
} from '../../services/payroll/weekoffBuilder.js';

const PAID_LEAVE = ['EL', 'PL', 'SL', 'CL'];

export const getAttendanceData = async (req, res, next) => {
  try {
    const { staffId, monthYear } = { ...req.query, ...req.body };
    if (!staffId || !monthYear) {
      return res.status(400).json({ success: false, message: 'staffId and monthYear are required.' });
    }

    const start = dayjs(`${monthYear}-01`).startOf('month');
    const end = start.endOf('month');
    const rows = await SalaryAttendance.find({
      hotelId: req.hotelId,
      staffId,
      attendanceDate: { $gte: start.toDate(), $lte: end.toDate() }
    }).sort({ attendanceDate: 1 });

    const lock = await AttendanceLock.findOne({ hotelId: req.hotelId, staffId, monthYear });
    const cutoff = await getCutoffStatus(req.hotelId, monthYear, 'attendance');
    const profile = await StaffProfile.findById(staffId);
    const summary = summarizeAttendance(rows, monthYear, profile?.joiningDate);

    res.json({
      success: true,
      data: {
        rows,
        lock,
        cutoff,
        summary,
        joiningDate: profile?.joiningDate
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getAttendanceList = async (req, res, next) => {
  try {
    const { monthYear } = req.query;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear is required.' });
    }
    const profiles = await StaffProfile.find({
      hotelId: req.hotelId,
      status: { $ne: 'terminated' }
    }).populate('userId', 'name email');

    const locks = await AttendanceLock.find({ hotelId: req.hotelId, monthYear });
    const lockSet = new Set(locks.map((l) => String(l.staffId)));
    const cutoff = await getCutoffStatus(req.hotelId, monthYear, 'attendance');

    const start = dayjs(`${monthYear}-01`).startOf('month');
    const end = start.endOf('month');

    const data = [];
    for (const p of profiles) {
      const rows = await SalaryAttendance.find({
        hotelId: req.hotelId,
        staffId: p._id,
        attendanceDate: { $gte: start.toDate(), $lte: end.toDate() }
      });
      data.push({
        staffId: p._id,
        employeeId: p.employeeId,
        name: p.userId?.name,
        joiningDate: p.joiningDate,
        locked: lockSet.has(String(p._id)),
        summary: summarizeAttendance(rows, monthYear, p.joiningDate)
      });
    }

    res.json({ success: true, data, cutoff });
  } catch (err) {
    next(err);
  }
};

async function enforceLeaveQuotas(hotelId, staffId, monthYear, newCounts) {
  const year = Number(monthYear.slice(0, 4));
  const config = await StaffLeaveConfig.findOne({ hotelId, year });
  if (!config) return;

  const prior = await StaffLeave.find({
    hotelId,
    staffId,
    year,
    monthYear: { $ne: monthYear }
  });
  const used = { PL: 0, SL: 0, EL: 0, CL: 0 };
  for (const m of prior) {
    used.PL += m.PL || 0;
    used.SL += m.SL || 0;
    used.EL += m.EL || 0;
    used.CL += m.CL || 0;
  }

  for (const key of ['PL', 'SL', 'EL', 'CL']) {
    const quota = Number(config[key]) || 0;
    const total = used[key] + (newCounts[key] || 0);
    if (quota > 0 && total > quota) {
      const err = new Error(
        `${key} quota exceeded: annual ${quota}, YTD+month would be ${total}.`
      );
      err.statusCode = 400;
      err.code = 'LEAVE_QUOTA_EXCEEDED';
      throw err;
    }
  }
}

export const updateAttendanceData = async (req, res, next) => {
  try {
    const { staffId, monthYear, days } = req.body;
    if (!staffId || !monthYear || !Array.isArray(days)) {
      return res.status(400).json({
        success: false,
        message: 'staffId, monthYear, and days[] are required.'
      });
    }

    const cutoff = await getCutoffStatus(req.hotelId, monthYear, 'attendance');
    assertInWindow(cutoff);

    const profile = await StaffProfile.findOne({ _id: staffId, hotelId: req.hotelId });
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Staff not found.' });
    }

    const leaveCounts = { PL: 0, SL: 0, EL: 0, CL: 0 };
    for (const d of days) {
      if (PAID_LEAVE.includes(d.status)) leaveCounts[d.status] += 1;
    }
    await enforceLeaveQuotas(req.hotelId, staffId, monthYear, leaveCounts);

    const upserted = [];
    for (const d of days) {
      const date = dayjs(d.date || d.attendanceDate);
      if (!date.isValid() || date.format('YYYY-MM') !== monthYear) continue;

      // Days before joining → force LOP
      let status = d.status;
      if (profile.joiningDate && date.isBefore(dayjs(profile.joiningDate), 'day')) {
        status = 'L';
      }

      const row = await SalaryAttendance.findOneAndUpdate(
        {
          hotelId: req.hotelId,
          staffId,
          attendanceDate: date.startOf('day').toDate()
        },
        {
          hotelId: req.hotelId,
          staffId,
          userId: profile.userId,
          attendanceDate: date.startOf('day').toDate(),
          status,
          notes: d.notes || ''
        },
        { upsert: true, new: true }
      );
      upserted.push(row);
    }

    await StaffLeave.findOneAndUpdate(
      { hotelId: req.hotelId, staffId, monthYear },
      {
        hotelId: req.hotelId,
        staffId,
        year: Number(monthYear.slice(0, 4)),
        monthYear,
        ...leaveCounts
      },
      { upsert: true }
    );

    const lock = await AttendanceLock.findOneAndUpdate(
      { hotelId: req.hotelId, staffId, monthYear },
      { hotelId: req.hotelId, staffId, monthYear, status: 'A' },
      { upsert: true, new: true }
    );

    const start = dayjs(`${monthYear}-01`).startOf('month');
    const allRows = await SalaryAttendance.find({
      hotelId: req.hotelId,
      staffId,
      attendanceDate: { $gte: start.toDate(), $lte: start.endOf('month').toDate() }
    });

    res.json({
      success: true,
      message: 'Attendance saved and locked for payroll.',
      data: {
        rows: upserted,
        lock,
        summary: summarizeAttendance(allRows, monthYear, profile.joiningDate),
        leaveCounts
      }
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code
      });
    }
    next(err);
  }
};

/**
 * Backfill W/H into attendance from week-off category + holidays.
 * Week-off wins over holiday. Does not overwrite P/leave/LOP unless force.
 */
export const weekoffUpdation = async (req, res, next) => {
  try {
    const { monthYear, staffIds, force = false } = req.body;
    if (!monthYear) {
      return res.status(400).json({ success: false, message: 'monthYear is required.' });
    }

    const cutoff = await getCutoffStatus(req.hotelId, monthYear, 'attendance');
    assertInWindow(cutoff);

    const start = dayjs(`${monthYear}-01`).startOf('month');
    const end = start.endOf('month');
    const holidays = await StaffHoliday.find({
      hotelId: req.hotelId,
      date: { $gte: start.toDate(), $lte: end.toDate() }
    }).lean();

    const filter = {
      hotelId: req.hotelId,
      status: { $ne: 'terminated' },
      joiningDate: { $lte: end.toDate() }
    };
    if (staffIds?.length) filter._id = { $in: staffIds };

    const profiles = await StaffProfile.find(filter);
    let updated = 0;

    for (const profile of profiles) {
      const salary = await StaffSalary.findOne({ hotelId: req.hotelId, staffId: profile._id });
      const weekOffCategory = salary?.weekOff
        ? await WeekoffCategory.findById(salary.weekOff).lean()
        : null;

      const map = buildWHMap({
        monthYear,
        weekOffCategory,
        holidays,
        joiningDate: profile.joiningDate
      });

      for (const [dateStr, status] of Object.entries(map)) {
        if (!['W', 'H', 'L'].includes(status)) continue;
        const existing = await SalaryAttendance.findOne({
          hotelId: req.hotelId,
          staffId: profile._id,
          attendanceDate: dayjs(dateStr).startOf('day').toDate()
        });
        if (existing && !force && !['W', 'H'].includes(existing.status) && status !== 'L') {
          continue;
        }
        if (existing && !force && existing.status === status) continue;

        await SalaryAttendance.findOneAndUpdate(
          {
            hotelId: req.hotelId,
            staffId: profile._id,
            attendanceDate: dayjs(dateStr).startOf('day').toDate()
          },
          {
            hotelId: req.hotelId,
            staffId: profile._id,
            userId: profile.userId,
            attendanceDate: dayjs(dateStr).startOf('day').toDate(),
            status
          },
          { upsert: true }
        );
        updated += 1;
      }
    }

    res.json({
      success: true,
      message: `Week-off/holiday backfill applied (${updated} day rows).`,
      data: { updated }
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
    }
    next(err);
  }
};
