import dayjs from 'dayjs';
import {
  User, StaffProfile, Shift, Attendance, AttendanceLocationAudit,
  SalaryRecord, Expense, LeaveRequest, SalaryAdvance, Hotel
} from '../models/index.js';
import { getLeaveAttendanceForDate } from './leaveController.js';
import { ROLES } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyHotelOperations } from '../services/notificationService.js';
import { validateAttendanceLocation } from '../services/attendanceGeofenceService.js';

const calcHours = (checkInTime, checkOutTime) => {
  if (!checkInTime || !checkOutTime) return 0;
  const [ih, im] = String(checkInTime).split(':').map(Number);
  const [oh, om] = String(checkOutTime).split(':').map(Number);
  if ([ih, im, oh, om].some((n) => Number.isNaN(n))) return 0;
  return Math.max(0, Math.round((((oh * 60 + om) - (ih * 60 + im)) / 60) * 100) / 100);
};

const nowTime = () => dayjs().format('HH:mm');

const getLeaveAdjustedAttendanceCounts = async (hotelId, userId, records, start, end) => {
  let absent = records.filter((record) => record.status === 'absent').length;
  let onLeave = records.filter((record) => record.status === 'on_leave').length;
  const recordsByDate = new Map(records.map((record) => [dayjs(record.date).format('YYYY-MM-DD'), record]));
  const leaveRequests = await LeaveRequest.find({
    hotelId,
    userId,
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start }
  }).select('startDate endDate').lean();
  const approvedDates = new Set();

  for (const leave of leaveRequests) {
    let date = dayjs(leave.startDate).isBefore(start, 'day') ? dayjs(start) : dayjs(leave.startDate);
    const lastDate = dayjs(leave.endDate).isAfter(end, 'day') ? dayjs(end) : dayjs(leave.endDate);
    while (!date.isAfter(lastDate, 'day')) {
      approvedDates.add(date.format('YYYY-MM-DD'));
      date = date.add(1, 'day');
    }
  }

  for (const date of approvedDates) {
    const record = recordsByDate.get(date);
    if (record && ['present', 'late', 'half_day'].includes(record.status)) continue;
    if (record?.status === 'on_leave') continue;
    if (record?.status === 'absent') absent -= 1;
    onLeave += 1;
  }

  return { absent, onLeave };
};

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
    await notifyHotelOperations({
      hotelId: req.hotelId,
      title: 'Employee onboarded',
      message: 'A new employee was added to the hotel team.',
      module: 'staff',
      eventType: 'employee_created',
      relatedRecordId: profile._id,
      link: '/staff',
      eventId: `employee-created:${profile._id}`
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
    if (status && status !== 'all' && status !== 'on_leave') filter.status = status;
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
    const rangeStart = startDate || records.at(-1)?.date || new Date();
    const rangeEnd = endDate || records[0]?.date || rangeStart;
    const leaveFilter = {
      hotelId: req.hotelId,
      status: 'approved',
      startDate: { $lte: dayjs(rangeEnd).endOf('day').toDate() },
      endDate: { $gte: dayjs(rangeStart).startOf('day').toDate() }
    };
    if (userId) leaveFilter.userId = userId;
    const approvedLeaves = await LeaveRequest.find(leaveFilter)
      .populate('userId', 'name email role')
      .lean();
    const attendanceByDate = new Map(records.map((record) => [
      `${String(record.userId?._id || record.userId)}:${dayjs(record.date).format('YYYY-MM-DD')}`,
      record
    ]));
    for (const leave of approvedLeaves) {
      let date = dayjs(leave.startDate).isBefore(rangeStart, 'day') ? dayjs(rangeStart) : dayjs(leave.startDate);
      const lastDate = dayjs(leave.endDate).isAfter(rangeEnd, 'day') ? dayjs(rangeEnd) : dayjs(leave.endDate);
      while (!date.isAfter(lastDate, 'day')) {
        const key = `${String(leave.userId?._id)}:${date.format('YYYY-MM-DD')}`;
        const existing = attendanceByDate.get(key);
        if (existing && !['absent', 'on_leave'].includes(existing.status)) {
          date = date.add(1, 'day');
          continue;
        }
        attendanceByDate.set(key, {
          ...(existing?.toObject ? existing.toObject() : existing || {}),
          _id: existing?._id || `leave-${key}`,
          userId: leave.userId,
          date: date.toDate(),
          checkInTime: '',
          checkOutTime: '',
          workingHours: 0,
          status: 'on_leave',
          notes: `Approved leave: ${leave.leaveType}`
        });
        date = date.add(1, 'day');
      }
    }
    const attendanceWithLeave = [...attendanceByDate.values()]
      .filter((record) => !status || status === 'all' || record.status === status)
      .sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());

    res.json({
      success: true,
      data: {
        attendance: attendanceWithLeave,
        pagination: {
          total: status === 'on_leave' ? attendanceWithLeave.length : total,
          page: parseInt(page),
          pages: Math.ceil((status === 'on_leave' ? attendanceWithLeave.length : total) / parseInt(limit))
        }
      }
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
    const approvedLeave = await getLeaveAttendanceForDate(req.hotelId, [attendanceUserId], attendanceDate);
    const leaveType = approvedLeave.get(String(attendanceUserId));
    if (leaveType) {
      return res.status(200).json({
        success: true,
        message: 'Attendance is represented as approved leave for this date.',
        data: {
          userId: attendanceUserId,
          date: attendanceDate,
          checkInTime: '',
          checkOutTime: '',
          workingHours: 0,
          status: 'on_leave',
          notes: `Approved leave: ${leaveType}`
        }
      });
    }
    const attendanceStatus = status || 'present';

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
        status:  attendanceStatus,
        notes:   notes || ''
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await logAudit({
      hotelId: req.hotelId,
      action: 'RECORD_ATTENDANCE',
      entity: 'Attendance',
      entityId: record._id,
      details: { userId: String(attendanceUserId), date: attendanceDate, status: attendanceStatus },
      req
    });
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
};

export const updateAttendance = async (req, res, next) => {
  try {
    const existing = await Attendance.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!existing) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    const approvedLeave = await getLeaveAttendanceForDate(req.hotelId, [existing.userId], existing.date);
    const leaveType = approvedLeave.get(String(existing.userId));
    if (leaveType) {
      return res.status(409).json({
        success: false,
        message: 'Attendance cannot be edited while approved leave covers this date.'
      });
    }
    const updates = { ...req.body };

    const record = await Attendance.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('userId', 'name email');

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_ATTENDANCE',
      entity: 'Attendance',
      entityId: record._id,
      details: { changes: updates },
      req
    });
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
      const approvedLeave = await getLeaveAttendanceForDate(
        req.hotelId,
        records.map((record) => record.userId),
        attendanceDate
      );
      // Upsert each provided record
      const ops = records.map((r) => {
        const leaveType = approvedLeave.get(String(r.userId));
        if (leaveType) return null;
        return {
        updateOne: {
          filter: { hotelId: req.hotelId, userId: r.userId, date: attendanceDate },
          update: {
            $set: {
              hotelId: req.hotelId,
              userId:       r.userId,
              date:         attendanceDate,
              checkInTime:  r.checkInTime  || '09:00',
              checkOutTime: r.checkOutTime || '',
              status:       r.status || defaultStatus,
              notes:        r.notes || ''
            }
          },
          upsert: true
        }
      };
      }).filter(Boolean);
      if (ops.length) await Attendance.bulkWrite(ops);
    } else {
      // Mark ALL active staff as defaultStatus for the given date
      const allStaff = await StaffProfile.find({ hotelId: req.hotelId, status: 'active' });
      const approvedLeave = await getLeaveAttendanceForDate(
        req.hotelId,
        allStaff.map((staff) => staff.userId),
        attendanceDate
      );
      const ops = allStaff.map((s) => {
        const leaveType = approvedLeave.get(String(s.userId));
        if (leaveType) return null;
        return {
        updateOne: {
          filter: { hotelId: req.hotelId, userId: s.userId, date: attendanceDate },
          update: {
            $set: {
              hotelId: req.hotelId,
              userId: s.userId,
              date: attendanceDate,
              checkInTime: '09:00',
              status: defaultStatus,
              notes: ''
            }
          },
          upsert: true
        }
      };
      }).filter(Boolean);
      if (ops.length > 0) await Attendance.bulkWrite(ops);
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'BULK_MARK_ATTENDANCE',
      entity: 'Attendance',
      details: { date: attendanceDate, count: records?.length || 0, defaultStatus },
      req
    });
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
        const { absent, onLeave } = await getLeaveAdjustedAttendanceCounts(
          req.hotelId,
          s.userId._id,
          records,
          start,
          end
        );
        const halfDay  = records.filter((r) => r.status === 'half_day').length;
        const late     = records.filter((r) => r.status === 'late').length;
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
      const { absent, onLeave } = await getLeaveAdjustedAttendanceCounts(
        req.hotelId,
        profile.userId._id,
        records,
        start,
        end
      );
      const halfDay  = records.filter((r) => r.status === 'half_day').length;
      const late     = records.filter((r) => r.status === 'late').length;
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
    if (processed.length > 0) {
      await notifyHotelOperations({
        hotelId: req.hotelId,
        title: 'Payroll processed',
        message: `Payroll was processed for ${processed.length} employee(s).`,
        module: 'payroll',
        eventType: 'payroll_processed',
        relatedRecordId: req.hotelId,
        link: '/staff',
        eventId: `payroll-processed:${targetMonth}:${req.hotelId}`
      });
    }

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
  let locationAudit;
  try {
    if (
      req.user.role === ROLES.GUEST
      || !req.user.hotelId
      || String(req.user.hotelId) !== String(req.hotelId)
    ) {
      return res.status(403).json({ success: false, message: 'Only employees can mark attendance for their assigned hotel.' });
    }

    const { latitude, longitude, accuracyMeters } = req.body;
    const locationValidation = await validateAttendanceLocation({
      hotelId: req.hotelId,
      latitude,
      longitude,
      accuracyMeters
    });
    locationAudit = await AttendanceLocationAudit.create({
      hotelId: req.hotelId,
      userId: req.user._id,
      action: 'check_in',
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : null,
      distanceMeters: locationValidation.distanceMeters,
      radiusMeters: locationValidation.radiusMeters,
      maxAccuracyMeters: locationValidation.maxAccuracyMeters,
      validationResult: locationValidation.valid ? 'valid' : 'invalid',
      attendanceResult: locationValidation.valid ? 'pending' : 'rejected',
      failureReason: locationValidation.failureReason
    });

    const reject = async (status, message) => {
      if (locationAudit.attendanceResult !== 'rejected' || locationAudit.failureReason !== message) {
        locationAudit.attendanceResult = 'rejected';
        locationAudit.failureReason = message;
        await locationAudit.save();
      }
      return res.status(status).json({
        success: false,
        message,
        data: {
          distanceMeters: locationValidation.distanceMeters,
          radiusMeters: locationValidation.radiusMeters,
          accuracyMeters: locationAudit.accuracyMeters,
          maxAccuracyMeters: locationValidation.maxAccuracyMeters
        }
      });
    };

    if (!locationValidation.valid) {
      const status = locationValidation.failureReason.includes('outside the permitted') ? 403 : 400;
      return reject(status, locationValidation.failureReason);
    }

    const timestamp = new Date();
    const attendanceDate = dayjs(timestamp).startOf('day').toDate();
    const time = dayjs(timestamp).format('HH:mm');
    const late = dayjs(`${dayjs().format('YYYY-MM-DD')} ${time}`).isAfter(dayjs(`${dayjs().format('YYYY-MM-DD')} 09:15`));
    const existing = await Attendance.findOne({ hotelId: req.hotelId, userId: req.user._id, date: attendanceDate });
    if (existing?.checkInTime) {
      return reject(409, 'Already checked in today.');
    }

    const record = await Attendance.create({
      hotelId: req.hotelId,
      userId: req.user._id,
      date: attendanceDate,
      checkInAt: timestamp,
      checkInTime: time,
      status: late ? 'late' : 'present'
    });
    locationAudit.attendanceResult = 'recorded';
    await locationAudit.save();
    res.json({ success: true, message: `Checked in at ${record.checkInTime}.`, data: record });
  } catch (err) {
    if (err.code === 11000) {
      if (locationAudit) {
        locationAudit.attendanceResult = 'rejected';
        locationAudit.failureReason = 'Already checked in today.';
        await locationAudit.save();
      }
      return res.status(409).json({ success: false, message: 'Already checked in today.' });
    }
    next(err);
  }
};

export const checkOut = async (req, res, next) => {
  let locationAudit;
  try {
    if (
      req.user.role === ROLES.GUEST
      || !req.user.hotelId
      || String(req.user.hotelId) !== String(req.hotelId)
    ) {
      return res.status(403).json({ success: false, message: 'Only employees can mark attendance for their assigned hotel.' });
    }

    const { latitude, longitude, accuracyMeters } = req.body;
    const locationValidation = await validateAttendanceLocation({
      hotelId: req.hotelId,
      latitude,
      longitude,
      accuracyMeters
    });
    locationAudit = await AttendanceLocationAudit.create({
      hotelId: req.hotelId,
      userId: req.user._id,
      action: 'check_out',
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : null,
      distanceMeters: locationValidation.distanceMeters,
      radiusMeters: locationValidation.radiusMeters,
      maxAccuracyMeters: locationValidation.maxAccuracyMeters,
      validationResult: locationValidation.valid ? 'valid' : 'invalid',
      attendanceResult: locationValidation.valid ? 'pending' : 'rejected',
      failureReason: locationValidation.failureReason
    });

    const reject = async (status, message) => {
      if (locationAudit.attendanceResult !== 'rejected' || locationAudit.failureReason !== message) {
        locationAudit.attendanceResult = 'rejected';
        locationAudit.failureReason = message;
        await locationAudit.save();
      }
      return res.status(status).json({
        success: false,
        message,
        data: {
          distanceMeters: locationValidation.distanceMeters,
          radiusMeters: locationValidation.radiusMeters,
          accuracyMeters: locationAudit.accuracyMeters,
          maxAccuracyMeters: locationValidation.maxAccuracyMeters
        }
      });
    };

    if (!locationValidation.valid) {
      const status = locationValidation.failureReason.includes('outside the permitted') ? 403 : 400;
      return reject(status, locationValidation.failureReason);
    }

    const timestamp = new Date();
    const attendanceDate = dayjs(timestamp).startOf('day').toDate();
    const time = dayjs(timestamp).format('HH:mm');
    const record = await Attendance.findOne({ hotelId: req.hotelId, userId: req.user._id, date: attendanceDate });
    if (!record?.checkInTime) {
      return reject(400, 'Check in before checking out.');
    }
    if (record.checkOutTime) {
      return reject(409, 'Already checked out today.');
    }

    const workingHours = record.checkInAt
      ? Math.max(0, Math.round(((timestamp - record.checkInAt) / 3600000) * 100) / 100)
      : calcHours(record.checkInTime, time);
    const updates = {
      checkOutAt: timestamp,
      checkOutTime: time,
      workingHours
    };
    if (workingHours > 0 && workingHours < 5 && record.status === 'present') {
      updates.status = 'half_day';
    }
    const updatedRecord = await Attendance.findOneAndUpdate(
      { _id: record._id, checkOutAt: null },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updatedRecord) {
      return reject(409, 'Already checked out today.');
    }
    locationAudit.attendanceResult = 'recorded';
    await locationAudit.save();
    res.json({ success: true, message: `Checked out at ${time}. ${updatedRecord.workingHours} hours recorded.`, data: updatedRecord });
  } catch (err) {
    if (locationAudit && err.name === 'VersionError') {
      locationAudit.attendanceResult = 'rejected';
      locationAudit.failureReason = 'Attendance changed while this request was being processed. Retry the request.';
      await locationAudit.save();
      return res.status(409).json({ success: false, message: locationAudit.failureReason });
    }
    next(err);
  }
};

export const getMyAttendance = async (req, res, next) => {
  try {
    const { month } = req.query;
    const targetMonth = month || dayjs().format('YYYY-MM');
    const start = dayjs(targetMonth).startOf('month').toDate();
    const end = dayjs(targetMonth).endOf('month').toDate();
    const storedRecords = await Attendance.find({
      hotelId: req.hotelId,
      userId: req.user._id,
      date: { $gte: start, $lte: end }
    }).sort({ date: -1 });
    const storedToday = await Attendance.findOne({
      hotelId: req.hotelId,
      userId: req.user._id,
      date: dayjs().startOf('day').toDate()
    });
    const leaveDays = new Map();
    const leaveRequests = await LeaveRequest.find({
      hotelId: req.hotelId,
      userId: req.user._id,
      status: 'approved',
      startDate: { $lte: end },
      endDate: { $gte: start }
    }).select('startDate endDate leaveType').lean();
    for (const leave of leaveRequests) {
      let current = dayjs(leave.startDate).isBefore(start, 'day') ? dayjs(start) : dayjs(leave.startDate);
      const leaveEnd = dayjs(leave.endDate).isAfter(end, 'day') ? dayjs(end) : dayjs(leave.endDate);
      while (!current.isAfter(leaveEnd, 'day')) {
        leaveDays.set(current.format('YYYY-MM-DD'), leave.leaveType);
        current = current.add(1, 'day');
      }
    }
    const recordsByDate = new Map(storedRecords.map((record) => [dayjs(record.date).format('YYYY-MM-DD'), record]));
    for (const [date, leaveType] of leaveDays) {
      const existing = recordsByDate.get(date);
      if (existing) {
        if (!['absent', 'on_leave'].includes(existing.status)) continue;
        const data = existing.toObject();
        data.status = 'on_leave';
        data.notes = `Approved leave: ${leaveType}`;
        recordsByDate.set(date, data);
      } else {
        recordsByDate.set(date, {
          _id: `leave-${date}`,
          userId: req.user._id,
          date: dayjs(date).toDate(),
          checkInTime: '',
          checkOutTime: '',
          workingHours: 0,
          status: 'on_leave',
          notes: `Approved leave: ${leaveType}`
        });
      }
    }
    const records = [...recordsByDate.values()].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());
    const today = records.find((record) => dayjs(record.date).isSame(dayjs(), 'day')) || storedToday;
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
