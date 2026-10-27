import dayjs from 'dayjs';
import { Hotel, LeaveRequest, StaffProfile } from '../models/index.js';
import { ROLES } from '../config/constants.js';
import { logAudit } from '../services/auditService.js';
import { notifyRoles, notifyUsers } from '../services/notificationService.js';

const isLeaveApprover = (user) => [ROLES.HOTEL_ADMIN, ROLES.SUPER_ADMIN].includes(user.role);

const getActiveLeaveTypes = async (hotelId) => {
  const hotel = await Hotel.findById(hotelId).select('leaveTypes');
  return hotel?.leaveTypes || [];
};

const notifyUser = async ({ hotelId, userId, title, message, link, relatedRecordId, eventType, eventId, priority = 'medium' }) => {
  return notifyUsers({
    hotelId,
    userIds: [userId],
    title,
    message,
    module: 'leave',
    eventType: eventType || title.toLowerCase().replace(/\s+/g, '_'),
    relatedRecordId,
    priority,
    link: link || (userId ? '/my-leave' : '/leave-management'),
    eventId
  });
};

export const getLeaveTypes = async (req, res, next) => {
  try {
    const leaveTypes = await getActiveLeaveTypes(req.hotelId);
    res.json({
      success: true,
      data: isLeaveApprover(req.user)
        ? leaveTypes
        : leaveTypes.filter((leaveType) => leaveType.active)
    });
  } catch (err) {
    next(err);
  }
};

export const updateLeaveTypes = async (req, res, next) => {
  try {
    if (!Array.isArray(req.body.leaveTypes) || req.body.leaveTypes.length === 0) {
      return res.status(400).json({ success: false, message: 'Configure at least one leave type.' });
    }

    const seenKeys = new Set();
    const leaveTypes = [];
    for (const type of req.body.leaveTypes) {
      const key = typeof type.key === 'string' ? type.key.trim().toLowerCase() : '';
      const label = typeof type.label === 'string' ? type.label.trim() : '';
      if (!/^[a-z0-9_-]+$/.test(key) || !label || typeof type.active !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'Each leave type needs a valid key, label, and active setting.'
        });
      }
      if (seenKeys.has(key)) {
        return res.status(400).json({ success: false, message: 'Leave type keys must be unique.' });
      }
      seenKeys.add(key);
      leaveTypes.push({ key, label, active: type.active });
    }

    const hotel = await Hotel.findByIdAndUpdate(
      req.hotelId,
      { $set: { leaveTypes } },
      { new: true, runValidators: true }
    ).select('leaveTypes');
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_LEAVE_TYPES',
      entity: 'Hotel',
      entityId: hotel._id,
      details: { leaveTypes },
      req
    });
    res.json({ success: true, data: hotel.leaveTypes });
  } catch (err) {
    next(err);
  }
};

export const getLeaveRequests = async (req, res, next) => {
  try {
    if (req.user.role === ROLES.GUEST) {
      return res.status(403).json({ success: false, message: 'Only hotel employees can access leave requests.' });
    }
    const filter = { hotelId: req.hotelId };
    if (!isLeaveApprover(req.user) || req.query.mine === 'true') filter.userId = req.user._id;
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;

    const leaves = await LeaveRequest.find(filter)
      .populate('userId', 'name email role')
      .populate('approvedBy', 'name email role')
      .populate('rejectedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .sort({ createdAt: -1 })
      .lean();

    const userIds = [...new Set(leaves.map((leave) => String(leave.userId?._id)).filter(Boolean))];
    const profiles = await StaffProfile.find({
      hotelId: req.hotelId,
      userId: { $in: userIds }
    }).select('userId employeeId department designation').lean();
    const profilesByUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));

    res.json({
      success: true,
      data: leaves.map((leave) => ({
        ...leave,
        employeeId: profilesByUser.get(String(leave.userId?._id))?.employeeId || '',
        department: profilesByUser.get(String(leave.userId?._id))?.department || '',
        designation: profilesByUser.get(String(leave.userId?._id))?.designation || ''
      }))
    });
  } catch (err) {
    next(err);
  }
};

export const createLeaveRequest = async (req, res, next) => {
  try {
    if (req.user.role === ROLES.GUEST) {
      return res.status(403).json({ success: false, message: 'Only hotel employees can request leave.' });
    }
    const { leaveType, startDate, endDate, reason, supportingDocuments = [] } = req.body;
    if (!startDate || !endDate || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Leave type, start date, end date, and reason are required.'
      });
    }

    const start = dayjs(startDate);
    const end = dayjs(endDate);
    if (!start.isValid() || !end.isValid() || end.isBefore(start, 'day')) {
      return res.status(400).json({
        success: false,
        message: 'End date must be the same as or later than the start date.'
      });
    }
    if (start.startOf('day').isBefore(dayjs().startOf('day'))) {
      return res.status(400).json({ success: false, message: 'Leave requests cannot start in the past.' });
    }
    if (!Array.isArray(supportingDocuments)
      || supportingDocuments.some((document) => typeof document !== 'string' || document.length > 2048)) {
      return res.status(400).json({ success: false, message: 'Supporting documents must be valid document references.' });
    }

    const configuredTypes = await getActiveLeaveTypes(req.hotelId);
    if (!configuredTypes.some((type) => type.key === leaveType && type.active)) {
      return res.status(400).json({ success: false, message: 'Select an active leave type configured by your hotel.' });
    }

    const normalizedStart = start.startOf('day').toDate();
    const normalizedEnd = end.startOf('day').toDate();
    const overlap = await LeaveRequest.exists({
      hotelId: req.hotelId,
      userId: req.user._id,
      status: { $in: ['pending', 'approved'] },
      startDate: { $lte: normalizedEnd },
      endDate: { $gte: normalizedStart }
    });
    if (overlap) {
      return res.status(409).json({
        success: false,
        message: 'This request overlaps another pending or approved leave request.'
      });
    }

    const totalDays = end.startOf('day').diff(start.startOf('day'), 'day') + 1;
    const activeDates = Array.from({ length: totalDays }, (_, index) =>
      start.add(index, 'day').format('YYYY-MM-DD')
    );
    const submittedAt = new Date();
    const leave = await LeaveRequest.create({
      hotelId: req.hotelId,
      userId: req.user._id,
      employeeId: req.user._id,
      leaveType,
      startDate: normalizedStart,
      endDate: normalizedEnd,
      totalDays,
      days: totalDays,
      activeDates,
      activeRequest: true,
      reason: reason.trim(),
      supportingDocuments,
      status: 'pending',
      decisionHistory: [{
        status: 'pending',
        actorId: req.user._id,
        actorRole: req.user.role,
        timestamp: submittedAt
      }]
    });

    await notifyUser({
      hotelId: req.hotelId,
      userId: req.user._id,
      title: 'Leave request submitted',
      message: `Your ${leaveType} leave request for ${totalDays} day(s) was submitted.`,
      relatedRecordId: leave._id,
      eventId: `leave-submitted-employee:${leave._id}`
    });

    await notifyRoles({
      hotelId: req.hotelId,
      roles: [ROLES.HOTEL_ADMIN],
      title: 'Leave request requires review',
      message: `${req.user.name} submitted a ${leaveType} leave request for ${totalDays} day(s).`,
      module: 'leave',
      eventType: 'leave_request_submitted',
      relatedRecordId: leave._id,
      link: '/leave-management',
      eventId: `leave-submitted:${leave._id}`
    });

    await logAudit({
      hotelId: req.hotelId,
      userId: req.user._id,
      userRole: req.user.role,
      action: 'SUBMIT_LEAVE_REQUEST',
      entity: 'LeaveRequest',
      entityId: leave._id,
      details: { leaveType, startDate: normalizedStart, endDate: normalizedEnd, totalDays },
      req
    });
    res.status(201).json({ success: true, message: 'Leave request submitted for approval.', data: leave });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This request overlaps another pending or approved leave request.'
      });
    }
    next(err);
  }
};

export const reviewLeaveRequest = async (req, res, next) => {
  try {
    const { status, rejectionReason = '' } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approve or reject.' });
    }
    const reason = typeof rejectionReason === 'string' ? rejectionReason.trim() : '';
    if (status === 'rejected' && !reason) {
      return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
    }

    const leave = await LeaveRequest.findOneAndUpdate({
      _id: req.params.id,
      hotelId: req.hotelId,
      status: 'pending'
    }, {
      $set: status === 'approved'
        ? { status, approvedBy: req.user._id, approvedAt: new Date(), reviewedBy: req.user._id, reviewNotes: '' }
        : {
          status,
          activeRequest: false,
          rejectedBy: req.user._id,
          rejectedAt: new Date(),
          rejectionReason: reason,
          reviewedBy: req.user._id,
          reviewNotes: reason
        },
      $push: {
        decisionHistory: {
          status,
          actorId: req.user._id,
          actorRole: req.user.role,
          timestamp: new Date(),
          reason: status === 'rejected' ? reason : ''
        }
      }
    }, { new: true, runValidators: true });

    if (!leave) {
      const exists = await LeaveRequest.exists({ _id: req.params.id, hotelId: req.hotelId });
      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists ? 'Only pending requests can be approved or rejected.' : 'Leave request not found.'
      });
    }

    await logAudit({
      hotelId: req.hotelId,
      action: status === 'approved' ? 'APPROVE_LEAVE_REQUEST' : 'REJECT_LEAVE_REQUEST',
      entity: 'LeaveRequest',
      entityId: leave._id,
      details: { status, rejectionReason: status === 'rejected' ? reason : '' },
      req
    });
    await notifyUser({
      hotelId: req.hotelId,
      userId: leave.userId,
      title: `Leave request ${status}`,
      message: status === 'approved'
        ? `Your leave request for ${dayjs(leave.startDate).format('MMM D')}–${dayjs(leave.endDate).format('MMM D, YYYY')} was approved.`
        : `Your leave request was rejected. Reason: ${reason}`,
      relatedRecordId: leave._id,
      eventType: `leave_request_${status}`,
      eventId: `leave-${status}:${leave._id}`,
      priority: status === 'rejected' ? 'high' : 'medium'
    });

    res.json({ success: true, message: `Leave request ${status}.`, data: leave });
  } catch (err) {
    next(err);
  }
};

export const cancelLeaveRequest = async (req, res, next) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const filter = { _id: req.params.id, hotelId: req.hotelId };
    if (!isLeaveApprover(req.user)) filter.userId = req.user._id;
    if (isLeaveApprover(req.user) && req.body.status === 'cancelled') {
      filter.status = 'approved';
      if (!reason) {
        return res.status(400).json({ success: false, message: 'A reason is required to cancel approved leave.' });
      }
    } else {
      filter.status = 'pending';
    }

    const leave = await LeaveRequest.findOneAndUpdate(filter, {
      $set: {
        status: 'cancelled',
        activeRequest: false,
        cancelledBy: req.user._id,
        cancelledAt: new Date(),
        cancellationReason: reason || 'Cancelled by employee'
      },
      $push: {
        decisionHistory: {
          status: 'cancelled',
          actorId: req.user._id,
          actorRole: req.user.role,
          timestamp: new Date(),
          reason: reason || 'Cancelled by employee'
        }
      }
    }, { new: true, runValidators: true });

    if (!leave) {
      const exists = await LeaveRequest.exists({ _id: req.params.id, hotelId: req.hotelId });
      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists
          ? 'Employees can cancel pending requests. Only an administrator can cancel approved leave with a reason.'
          : 'Leave request not found.'
      });
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'CANCEL_LEAVE_REQUEST',
      entity: 'LeaveRequest',
      entityId: leave._id,
      details: { previousStatus: isLeaveApprover(req.user) ? 'approved' : 'pending', reason },
      req
    });
    await notifyUser({
      hotelId: req.hotelId,
      userId: leave.userId,
      title: 'Leave request cancelled',
      message: `Your leave request was cancelled${reason ? `: ${reason}` : '.'}`,
      relatedRecordId: leave._id,
      eventId: `leave-cancelled:${leave._id}`
    });
    res.json({ success: true, message: 'Leave request cancelled.', data: leave });
  } catch (err) {
    next(err);
  }
};

export const getLeaveAttendanceForRange = async (hotelId, userIds, startDate, endDate = startDate) => {
  const start = dayjs(startDate).startOf('day').toDate();
  const end = dayjs(endDate).startOf('day').toDate();
  const leaves = await LeaveRequest.find({
    hotelId,
    userId: { $in: userIds },
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start }
  }).select('userId leaveType').lean();
  return new Map(leaves.map((leave) => [String(leave.userId), leave.leaveType]));
};

export const getLeaveAttendanceForDate = async (hotelId, userIds, date) =>
  getLeaveAttendanceForRange(hotelId, userIds, date);
