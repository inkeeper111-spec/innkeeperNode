import dayjs from 'dayjs';
import { User, StaffProfile, Shift, Attendance, SalaryRecord, Expense, LeaveRequest, SalaryAdvance } from '../models/index.js';

const calcHours = (checkInTime, checkOutTime) => {
  if (!checkInTime || !checkOutTime) return 0;
  const [ih, im] = String(checkInTime).split(':').map(Number);
  const [oh, om] = String(checkOutTime).split(':').map(Number);
  if ([ih, im, oh, om].some((n) => Number.isNaN(n))) return 0;
  return Math.max(0, Math.round((((oh * 60 + om) - (ih * 60 + im)) / 60) * 100) / 100);
};

const nowTime = () => dayjs().format('HH:mm');
import { ROLES } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';

// ─── Staff Directory ───────────────────────────────────────────────────────────
export const getStaff = async (req, res, next) => {
  try {
    const { department, status, search } = req.query;
    const filter = { hotelId: req.hotelId };
    if (department && department !== 'all') filter.department = department;
    if (status && status !== 'all') filter.status = status;

    let staff = await StaffProfile.find(filter)
      .populate('userId', 'name email role phone isActive')
      .sort({ createdAt: -1 });

    if (search) {
      const q = search.toLowerCase();
      staff = staff.filter(
        (s) =>
          s.userId?.name?.toLowerCase().includes(q) ||
          s.userId?.email?.toLowerCase().includes(q) ||
          s.employeeId?.toLowerCase().includes(q)
      );
    }

    res.json({ success: true, data: staff });
  } catch (err) {
    next(err);
  }
};

export const getStaffById = async (req, res, next) => {
  try {
    const profile = await StaffProfile.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('userId', 'name email role phone isActive');
    if (!profile) return res.status(404).json({ success: false, message: 'Staff profile not found.' });

    // Last 3 salary records
    const salaryHistory = await SalaryRecord.find({ staffProfileId: profile._id, hotelId: req.hotelId })
      .sort({ month: -1 })
      .limit(3);

    // Attendance this month
    const monthStart = dayjs().startOf('month').toDate();
    const monthEnd   = dayjs().endOf('month').toDate();
    const thisMonthAttendance = await Attendance.find({
      hotelId: req.hotelId,
      userId:  profile.userId,
      date:    { $gte: monthStart, $lte: monthEnd }
    });

    res.json({ success: true, data: { profile, salaryHistory, thisMonthAttendance } });
  } catch (err) {
    next(err);
  }
};

export const createStaff = async (req, res, next) => {
  try {
    const { name, email, password, role, phone, employeeId, department, designation, salary, joiningDate } = req.body;

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'A user with this email already exists.' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password: password || 'InnKeeper@2026',
      role: role || ROLES.RECEPTIONIST,
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      phone: phone || '',
      isActive: true,
      isEmailVerified: true
    });

    const profile = await StaffProfile.create({
      hotelId: req.hotelId,
      userId: user._id,
      employeeId: employeeId || `EMP-${Date.now().toString().slice(-5)}`,
      department: department || 'front_desk',
      designation: designation || 'Staff Member',
      salary: Number(salary || 0),
      basicSalary: Number(req.body.basicSalary || salary || 0),
      allowances: Number(req.body.allowances || 0),
      fixedDeductions: Number(req.body.fixedDeductions || 0),
      joiningDate: joiningDate || new Date()
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'STAFF_CREATED',
      entity: 'StaffProfile',
      entityId: profile._id,
      details: { name, employeeId: profile.employeeId, department },
      req
    });

    res.status(201).json({
      success: true,
      message: `${name} onboarded successfully.`,
      data: { user: { _id: user._id, name: user.name, email: user.email, role: user.role }, profile }
    });
  } catch (err) {
    next(err);
  }
};

export const updateStaff = async (req, res, next) => {
  try {
    const { name, phone, designation, department, salary, status, basicSalary, allowances, fixedDeductions } = req.body;

    const profile = await StaffProfile.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!profile) return res.status(404).json({ success: false, message: 'Staff profile not found.' });

    if (designation !== undefined) profile.designation = designation;
    if (department  !== undefined) profile.department  = department;
    if (salary      !== undefined) profile.salary      = Number(salary);
    if (basicSalary !== undefined) profile.basicSalary = Number(basicSalary);
    if (allowances  !== undefined) profile.allowances  = Number(allowances);
    if (fixedDeductions !== undefined) profile.fixedDeductions = Number(fixedDeductions);
    if (status      !== undefined) profile.status      = status;
    await profile.save();

    // Update user record too
    if (name !== undefined || phone !== undefined) {
      await User.findByIdAndUpdate(profile.userId, {
        ...(name  !== undefined && { name }),
        ...(phone !== undefined && { phone })
      });
    }

    res.json({ success: true, message: 'Staff profile updated.', data: profile });
  } catch (err) {
    next(err);
  }
};

// ─── Shifts ───────────────────────────────────────────────────────────────────
export const getShifts = async (req, res, next) => {
  try {
    const { userId, startDate, endDate } = req.query;
    const filter = { hotelId: req.hotelId };
    if (userId) filter.userId = userId;
    if (startDate && endDate) {
      filter.shiftDate = {
        $gte: dayjs(startDate).startOf('day').toDate(),
        $lte: dayjs(endDate).endOf('day').toDate()
      };
    }

    const shifts = await Shift.find(filter)
      .populate('userId', 'name role')
      .sort({ shiftDate: -1 });

    res.json({ success: true, data: shifts });
  } catch (err) {
    next(err);
  }
};

export const createShift = async (req, res, next) => {
  try {
    const shift = await Shift.create({ ...req.body, hotelId: req.hotelId, propertyId: req.propertyId });
    res.status(201).json({ success: true, data: shift });
  } catch (err) {
    next(err);
  }
};

export const updateShift = async (req, res, next) => {
  try {
    const shift = await Shift.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    );
    if (!shift) return res.status(404).json({ success: false, message: 'Shift not found.' });
    res.json({ success: true, data: shift });
  } catch (err) {
    next(err);
  }
};

// ─── Attendance ───────────────────────────────────────────────────────────────
export const getAttendance = async (req, res, next) => {
  try {
    const { userId, startDate, endDate, status, page = 1, limit = 50 } = req.query;
    const filter = { hotelId: req.hotelId };

    if (userId)  filter.userId = userId;
    if (status && status !== 'all') filter.status = status;
    if (startDate && endDate) {
      filter.date = {
        $gte: dayjs(startDate).startOf('day').toDate(),
        $lte: dayjs(endDate).endOf('day').toDate()
      };
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Attendance.countDocuments(filter);
    const records = await Attendance.find(filter)
      .populate('userId', 'name email role')
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: { attendance: records, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } }
    });
  } catch (err) {
    next(err);
  }
};

export const recordAttendance = async (req, res, next) => {
  try {
    const { userId, date, checkInTime, checkOutTime, status, notes } = req.body;
    const attendanceUserId = userId || req.user._id;
    const employee = await User.findOne({ _id: attendanceUserId, hotelId: req.hotelId, role: { $ne: ROLES.GUEST } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found for this hotel.' });
    }

    const attendanceDate = dayjs(date || new Date()).startOf('day').toDate();

    // Upsert — if record for this user+date already exists, update it
    const record = await Attendance.findOneAndUpdate(
      { hotelId: req.hotelId, userId: attendanceUserId, date: attendanceDate },
      {
        hotelId: req.hotelId,
        userId:  attendanceUserId,
        date:    attendanceDate,
        checkInTime:  checkInTime  || '09:00',
        checkOutTime: checkOutTime || '',
        workingHours: calcHours(checkInTime || '09:00', checkOutTime || ''),
        status:  status  || 'present',
        notes:   notes   || ''
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
};

export const updateAttendance = async (req, res, next) => {
  try {
    const record = await Attendance.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    ).populate('userId', 'name email');

    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    res.json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk mark attendance for all staff on a given date
 */
export const bulkMarkAttendance = async (req, res, next) => {
  try {
    const { date, defaultStatus = 'present', records } = req.body;
    // records: [{ userId, status, checkInTime, checkOutTime, notes }]

    const attendanceDate = dayjs(date || new Date()).startOf('day').toDate();

    if (records && records.length > 0) {
      // Upsert each provided record
      const ops = records.map((r) => ({
        updateOne: {
          filter: { hotelId: req.hotelId, userId: r.userId, date: attendanceDate },
          update: {
            $set: {
              hotelId: req.hotelId,
              userId:       r.userId,
              date:         attendanceDate,
              checkInTime:  r.checkInTime  || '09:00',
              checkOutTime: r.checkOutTime || '',
              status:       r.status       || defaultStatus,
              notes:        r.notes        || ''
            }
          },
          upsert: true
        }
      }));
      await Attendance.bulkWrite(ops);
    } else {
      // Mark ALL active staff as defaultStatus for the given date
      const allStaff = await StaffProfile.find({ hotelId: req.hotelId, status: 'active' });
      const ops = allStaff.map((s) => ({
        updateOne: {
          filter: { hotelId: req.hotelId, userId: s.userId, date: attendanceDate },
          update: {
            $set: { hotelId: req.hotelId, userId: s.userId, date: attendanceDate, checkInTime: '09:00', status: defaultStatus }
          },
          upsert: true
        }
      }));
      if (ops.length > 0) await Attendance.bulkWrite(ops);
    }

    res.json({ success: true, message: `Attendance marked for ${dayjs(attendanceDate).format('MMMM D, YYYY')}.` });
  } catch (err) {
    next(err);
  }
};

/**
 * Monthly attendance summary for all staff
 */
export const getAttendanceSummary = async (req, res, next) => {
  try {
    const { month } = req.query; // e.g. "2026-10"
    const targetMonth = month || dayjs().format('YYYY-MM');
    const start = dayjs(targetMonth).startOf('month').toDate();
    const end   = dayjs(targetMonth).endOf('month').toDate();
    const workingDays = dayjs(targetMonth).daysInMonth();

    const allStaff = await StaffProfile.find({ hotelId: req.hotelId })
      .populate('userId', 'name email role');

    const summary = await Promise.all(
      allStaff.map(async (s) => {
        const records = await Attendance.find({
          hotelId: req.hotelId,
          userId:  s.userId._id,
          date:    { $gte: start, $lte: end }
        });

        const present  = records.filter((r) => r.status === 'present').length;
        const absent   = records.filter((r) => r.status === 'absent').length;
        const halfDay  = records.filter((r) => r.status === 'half_day').length;
        const late     = records.filter((r) => r.status === 'late').length;
        const onLeave  = records.filter((r) => r.status === 'on_leave').length;
        const totalHours = records.reduce((sum, r) => sum + (r.workingHours || 0), 0);
        const basic = Number(s.basicSalary || s.salary || 0);
        const allowancesAmt = Number(s.allowances || 0);
        const fixedDeductionAmt = Number(s.fixedDeductions || 0);

        const effectiveDays = present + late + onLeave + halfDay * 0.5;
        const earnedSalary  = workingDays > 0
          ? Math.round((basic / workingDays) * effectiveDays * 100) / 100
          : basic;
        const deduction = Math.round((basic - earnedSalary + fixedDeductionAmt) * 100) / 100;

        // Check if salary already processed for this month
        const salaryRecord = await SalaryRecord.findOne({
          hotelId: req.hotelId,
          userId:  s.userId._id,
          month:   targetMonth
        });

        return {
          staffProfileId: s._id,
          userId:         s.userId._id,
          employeeId:     s.employeeId,
          name:           s.userId.name,
          email:          s.userId.email,
          role:           s.userId.role,
          department:     s.department,
          designation:    s.designation,
          baseSalary:     basic,
          allowances:     allowancesAmt,
          workingDays,
          presentDays:    present,
          absentDays:     absent,
          halfDays:       halfDay,
          lateDays:       late,
          leaveDays:      onLeave,
          totalHours:     Math.round(totalHours * 10) / 10,
          effectiveDays:  Math.round(effectiveDays * 10) / 10,
          earnedSalary:   Math.round((earnedSalary + allowancesAmt) * 100) / 100,
          deductionAmount: deduction,
          salaryStatus:   salaryRecord?.status || 'not_processed',
          salaryRecordId: salaryRecord?._id || null
        };
      })
    );

    res.json({
      success: true,
      data: {
        month: targetMonth,
        workingDays,
        summary,
        totalPayroll: summary.reduce((acc, s) => acc + s.earnedSalary, 0)
      }
    });
  } catch (err) {
    next(err);
  }
};

// ─── Salary Processing ────────────────────────────────────────────────────────
export const getSalaryHistory = async (req, res, next) => {
  try {
    const { month, staffProfileId, page = 1, limit = 30 } = req.query;
    const filter = { hotelId: req.hotelId };
    if (month)          filter.month          = month;
    if (staffProfileId) filter.staffProfileId = staffProfileId;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await SalaryRecord.countDocuments(filter);
    const records = await SalaryRecord.find(filter)
      .populate('userId',         'name email role')
      .populate('staffProfileId', 'employeeId department designation')
      .populate('processedBy',    'name')
      .sort({ month: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: { records, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Process salary for one or all staff for a given month.
 * Creates SalaryRecord + auto-logs Expense with category 'salaries'.
 */
export const processSalary = async (req, res, next) => {
  try {
    const {
      month,              // "2026-10"
      staffProfileIds,    // array — if empty, process ALL staff
      paymentMethod = 'bank_transfer',
      bonuses = {},       // { staffProfileId: bonusAmount }
      notes = ''
    } = req.body;

    if (!month) {
      return res.status(400).json({ success: false, message: 'Month is required (format: YYYY-MM).' });
    }

    const targetMonth = month;
    const start       = dayjs(targetMonth).startOf('month').toDate();
    const end         = dayjs(targetMonth).endOf('month').toDate();
    const workingDays = dayjs(targetMonth).daysInMonth();

    // Determine which staff to process
    const filter = { hotelId: req.hotelId, status: 'active' };
    if (staffProfileIds?.length > 0) filter._id = { $in: staffProfileIds };

    const staffList = await StaffProfile.find(filter)
      .populate('userId', 'name email');

    const processed = [];
    const skipped   = [];

    for (const profile of staffList) {
      // Skip if already processed for this month
      const existing = await SalaryRecord.findOne({
        hotelId: req.hotelId,
        userId:  profile.userId._id,
        month:   targetMonth
      });
      if (existing && existing.status !== 'pending') {
        skipped.push({ name: profile.userId.name, reason: 'Already processed' });
        continue;
      }

      // Compute attendance-based earned salary
      const records = await Attendance.find({
        hotelId: req.hotelId,
        userId:  profile.userId._id,
        date:    { $gte: start, $lte: end }
      });

      const present  = records.filter((r) => r.status === 'present').length;
      const absent   = records.filter((r) => r.status === 'absent').length;
      const halfDay  = records.filter((r) => r.status === 'half_day').length;
      const late     = records.filter((r) => r.status === 'late').length;
      const onLeave  = records.filter((r) => r.status === 'on_leave').length;
      const totalHours = records.reduce((sum, r) => sum + (r.workingHours || 0), 0);

      const basic = Number(profile.basicSalary || profile.salary || 0);
      const allowancesAmt = Number(profile.allowances || 0);
      const fixedDeductionAmt = Number(profile.fixedDeductions || 0);
      const effectiveDays = present + late + onLeave + halfDay * 0.5;
      const earnedSalary  = records.length > 0
        ? Math.round((basic / workingDays) * effectiveDays * 100) / 100
        : basic;

      const attendanceDeduction = Math.round((basic - earnedSalary) * 100) / 100;
      const bonusAmount     = Number(bonuses[profile._id.toString()] || 0);
      const advances = await SalaryAdvance.find({
        hotelId: req.hotelId,
        userId: profile.userId._id,
        month: targetMonth,
        status: { $in: ['approved', 'pending'] }
      });
      const advanceAmount = advances.reduce((sum, a) => sum + a.amount, 0);
      const deductionAmount = Math.round((attendanceDeduction + fixedDeductionAmt + advanceAmount) * 100) / 100;
      const netSalary       = Math.round((earnedSalary + allowancesAmt + bonusAmount - fixedDeductionAmt - advanceAmount) * 100) / 100;

      // Auto-create Expense entry for salary payment
      const expense = await Expense.create({
        hotelId:       req.hotelId,
        propertyId:    req.propertyId || null,
        expenseNumber: generateReference('SAL'),
        category:      'salaries',
        amount:        netSalary,
        date:          dayjs(targetMonth).endOf('month').toDate(),
        description:   `Salary — ${profile.userId.name} (${profile.employeeId}) · ${dayjs(targetMonth).format('MMMM YYYY')}`,
        paymentMethod,
        status:        'approved',
        createdBy:     req.user._id,
        approvedBy:    req.user._id
      });

      // Create or update SalaryRecord
      const salaryRecord = await SalaryRecord.findOneAndUpdate(
        { hotelId: req.hotelId, userId: profile.userId._id, month: targetMonth },
        {
          hotelId:        req.hotelId,
          staffProfileId: profile._id,
          userId:         profile.userId._id,
          month:          targetMonth,
          baseSalary:     basic,
          workingDays,
          presentDays:    present,
          absentDays:     absent,
          halfDays:       halfDay,
          leaveDays:      onLeave,
          earnedSalary,
          deductionAmount,
          bonusAmount,
          allowances:     allowancesAmt,
          fixedDeductions: fixedDeductionAmt,
          advanceAmount,
          netSalary,
          paymentMethod,
          status:         'paid',
          expenseId:      expense._id,
          notes,
          processedBy:    req.user._id,
          processedAt:    new Date()
        },
        { upsert: true, new: true }
      );

      if (advances.length) {
        await SalaryAdvance.updateMany(
          { _id: { $in: advances.map((a) => a._id) } },
          { status: 'deducted' }
        );
      }

      processed.push({
        name:        profile.userId.name,
        employeeId:  profile.employeeId,
        netSalary,
        expenseRef:  expense.expenseNumber,
        salaryRecord
      });
    }

    await logAudit({
      hotelId: req.hotelId,
      action:  'SALARY_PROCESSED',
      entity:  'SalaryRecord',
      entityId: req.hotelId,
      details:  { month: targetMonth, processedCount: processed.length, skippedCount: skipped.length },
      req
    });

    res.json({
      success: true,
      message: `Salary processed for ${processed.length} staff member(s). ${skipped.length} skipped.`,
      data: { processed, skipped, totalPaid: processed.reduce((s, p) => s + p.netSalary, 0) }
    });
  } catch (err) {
    next(err);
  }
};

export const checkIn = async (req, res, next) => {
  try {
    if (req.user.role === ROLES.GUEST) {
      return res.status(403).json({ success: false, message: 'Guests cannot record employee attendance.' });
    }

    const timestamp = new Date();
    const attendanceDate = dayjs(timestamp).startOf('day').toDate();
    const time = dayjs(timestamp).format('HH:mm');
    const late = dayjs(`${dayjs().format('YYYY-MM-DD')} ${time}`).isAfter(dayjs(`${dayjs().format('YYYY-MM-DD')} 09:15`));
    const existing = await Attendance.findOne({ hotelId: req.hotelId, userId: req.user._id, date: attendanceDate });
    if (existing?.checkInTime) {
      return res.status(409).json({ success: false, message: 'Already checked in today.', data: existing });
    }

    const record = await Attendance.create({
      hotelId: req.hotelId,
      userId: req.user._id,
      date: attendanceDate,
      checkInAt: timestamp,
      checkInTime: time,
      status: late ? 'late' : 'present'
    });
    res.json({ success: true, message: `Checked in at ${record.checkInTime}.`, data: record });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Already checked in today.' });
    }
    next(err);
  }
};

export const checkOut = async (req, res, next) => {
  try {
    if (req.user.role === ROLES.GUEST) {
      return res.status(403).json({ success: false, message: 'Guests cannot record employee attendance.' });
    }

    const timestamp = new Date();
    const attendanceDate = dayjs(timestamp).startOf('day').toDate();
    const time = dayjs(timestamp).format('HH:mm');
    const record = await Attendance.findOne({ hotelId: req.hotelId, userId: req.user._id, date: attendanceDate });
    if (!record?.checkInTime) {
      return res.status(400).json({ success: false, message: 'Check in before checking out.' });
    }
    if (record.checkOutTime) {
      return res.status(409).json({ success: false, message: 'Already checked out today.', data: record });
    }

    record.checkOutAt = timestamp;
    record.checkOutTime = time;
    record.workingHours = record.checkInAt
      ? Math.max(0, Math.round(((timestamp - record.checkInAt) / 3600000) * 100) / 100)
      : calcHours(record.checkInTime, time);
    if (record.workingHours > 0 && record.workingHours < 5 && record.status === 'present') {
      record.status = 'half_day';
    }
    await record.save();
    res.json({ success: true, message: `Checked out at ${time}. ${record.workingHours} hours recorded.`, data: record });
  } catch (err) {
    next(err);
  }
};

export const getMyAttendance = async (req, res, next) => {
  try {
    const { month } = req.query;
    const targetMonth = month || dayjs().format('YYYY-MM');
    const start = dayjs(targetMonth).startOf('month').toDate();
    const end = dayjs(targetMonth).endOf('month').toDate();
    const records = await Attendance.find({
      hotelId: req.hotelId,
      userId: req.user._id,
      date: { $gte: start, $lte: end }
    }).sort({ date: -1 });
    const today = await Attendance.findOne({
      hotelId: req.hotelId,
      userId: req.user._id,
      date: dayjs().startOf('day').toDate()
    });
    res.json({
      success: true,
      data: {
        month: targetMonth,
        today,
        records,
        totals: {
          present: records.filter((r) => r.status === 'present').length,
          late: records.filter((r) => r.status === 'late').length,
          leave: records.filter((r) => r.status === 'on_leave').length,
          hours: records.reduce((sum, r) => sum + (r.workingHours || 0), 0)
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getLeaves = async (req, res, next) => {
  try {
    const filter = { hotelId: req.hotelId };
    if (req.user.role !== ROLES.HOTEL_ADMIN && req.user.role !== ROLES.SUPER_ADMIN) {
      filter.userId = req.user._id;
    }
    const leaves = await LeaveRequest.find(filter).populate('userId', 'name email role').sort({ createdAt: -1 });
    res.json({ success: true, data: leaves });
  } catch (err) {
    next(err);
  }
};

export const createLeave = async (req, res, next) => {
  try {
    const { startDate, endDate, leaveType = 'casual', reason = '' } = req.body;
    const start = dayjs(startDate).startOf('day');
    const end = dayjs(endDate).startOf('day');
    const days = Math.max(0.5, end.diff(start, 'day') + 1);
    const leave = await LeaveRequest.create({
      hotelId: req.hotelId,
      userId: req.user._id,
      leaveType,
      startDate: start.toDate(),
      endDate: end.toDate(),
      days,
      reason
    });
    res.status(201).json({ success: true, data: leave });
  } catch (err) {
    next(err);
  }
};

export const reviewLeave = async (req, res, next) => {
  try {
    const { status, reviewNotes = '' } = req.body;
    const leave = await LeaveRequest.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found.' });
    leave.status = status;
    leave.reviewNotes = reviewNotes;
    leave.reviewedBy = req.user._id;
    await leave.save();
    if (status === 'approved') {
      let cursor = dayjs(leave.startDate);
      const end = dayjs(leave.endDate);
      while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
        await Attendance.findOneAndUpdate(
          { hotelId: req.hotelId, userId: leave.userId, date: cursor.startOf('day').toDate() },
          {
            hotelId: req.hotelId,
            userId: leave.userId,
            date: cursor.startOf('day').toDate(),
            checkInTime: '',
            status: 'on_leave',
            notes: leave.leaveType
          },
          { upsert: true, new: true }
        );
        cursor = cursor.add(1, 'day');
      }
    }
    res.json({ success: true, data: leave });
  } catch (err) {
    next(err);
  }
};

export const getAdvances = async (req, res, next) => {
  try {
    const { month } = req.query;
    const filter = { hotelId: req.hotelId };
    if (month) filter.month = month;
    const advances = await SalaryAdvance.find(filter)
      .populate('userId', 'name email')
      .populate('staffProfileId', 'employeeId designation')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: advances });
  } catch (err) {
    next(err);
  }
};

export const createAdvance = async (req, res, next) => {
  try {
    const { staffProfileId, amount, month, notes = '' } = req.body;
    const profile = await StaffProfile.findOne({ _id: staffProfileId, hotelId: req.hotelId });
    if (!profile) return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    const advance = await SalaryAdvance.create({
      hotelId: req.hotelId,
      staffProfileId: profile._id,
      userId: profile.userId,
      amount: Number(amount),
      month: month || dayjs().format('YYYY-MM'),
      notes,
      status: 'approved',
      createdBy: req.user._id
    });
    res.status(201).json({ success: true, data: advance });
  } catch (err) {
    next(err);
  }
};

export const exportSalaryCsv = async (req, res, next) => {
  try {
    const { month } = req.query;
    const filter = { hotelId: req.hotelId };
    if (month) filter.month = month;
    const records = await SalaryRecord.find(filter)
      .populate('userId', 'name email')
      .populate('staffProfileId', 'employeeId department designation');

    const header = ['Employee', 'Email', 'Employee ID', 'Month', 'Basic', 'Allowances', 'Attendance Deduction', 'Advances', 'Bonus', 'Net Salary', 'Status', 'Payment Method'];
    const rows = records.map((r) => [
      r.userId?.name,
      r.userId?.email,
      r.staffProfileId?.employeeId,
      r.month,
      r.baseSalary,
      r.allowances,
      r.deductionAmount,
      r.advanceAmount,
      r.bonusAmount,
      r.netSalary,
      r.status,
      r.paymentMethod
    ].join(','));
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${month || 'all'}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};
