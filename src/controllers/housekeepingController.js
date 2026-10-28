import { HousekeepingTask, Room, MaintenanceTicket, User } from '../models/index.js';
import { HOUSEKEEPING_STATUS, PRIORITY, MAINTENANCE_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyRoles, notifyUsers } from '../services/notificationService.js';
import { notifyJobRejection } from '../services/jobAssignmentService.js';

export const getTasks = async (req, res, next) => {
  try {
    const { status, priority } = req.query;
    const filter = { hotelId: req.hotelId };
    if (req.user.role === 'housekeeping_staff') filter.assignedTo = req.user._id;

    if (status && status !== 'all') filter.status = status;
    if (priority && priority !== 'all') filter.priority = priority;

    const tasks = await HousekeepingTask.find(filter)
      .populate('roomId', 'roomNumber floor roomStatus housekeepingStatus')
      .populate('assignedTo', 'name email')
      .populate('inspectedBy', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: tasks });
  } catch (err) {
    next(err);
  }
};

export const createTask = async (req, res, next) => {
  try {
    const { roomId, assignedTo, priority = PRIORITY.MEDIUM, taskType = 'checkout_cleaning', notes = '' } = req.body;
    if (assignedTo && !['hotel_admin', 'receptionist'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel operations can assign a housekeeping task.' });
    }

    const room = await Room.findOne({ _id: roomId, hotelId: req.hotelId });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    let assignee = null;
    if (assignedTo) {
      assignee = await User.findOne({
        _id: assignedTo,
        hotelId: req.hotelId,
        isActive: true,
        role: 'housekeeping_staff'
      }).select('_id');
      if (!assignee) {
        return res.status(400).json({ success: false, message: 'Choose an active housekeeping employee from this hotel.' });
      }
    }

    const assignedAt = assignee ? new Date() : null;
    const task = await HousekeepingTask.create({
      hotelId: req.hotelId,
      propertyId: room.propertyId,
      roomId: room._id,
      assignedTo: assignee?._id || null,
      assignedBy: assignee ? req.user._id : null,
      assignedAt,
      assignmentStatus: 'pending',
      assignmentHistory: assignee ? [{
        action: 'assigned',
        actorId: req.user._id,
        assignedTo: assignee._id,
        timestamp: assignedAt
      }] : [],
      priority,
      taskType,
      status: HOUSEKEEPING_STATUS.DIRTY,
      notes
    });

    // Sync room housekeeping status
    room.housekeepingStatus = HOUSEKEEPING_STATUS.DIRTY;
    await room.save();

    if (task.assignedTo) {
      await notifyUsers({
        hotelId: req.hotelId,
        userIds: [task.assignedTo],
        roles: ['housekeeping_staff'],
        title: 'Cleaning task assigned',
        message: `A cleaning task for room ${room.roomNumber} has been assigned to you.`,
        module: 'housekeeping',
        eventType: 'housekeeping_task_assigned',
        relatedRecordId: task._id,
        priority: task.priority === PRIORITY.HIGH || task.priority === PRIORITY.CRITICAL ? 'high' : 'medium',
        link: '/housekeeping',
        eventId: `housekeeping-assigned:${task._id}`
      });
      await logAudit({
        hotelId: req.hotelId,
        action: 'ASSIGN_HOUSEKEEPING_TASK',
        entity: 'HousekeepingTask',
        entityId: task._id,
        details: { assignedTo: String(assignee._id), assignedAt },
        req
      });
    }

    res.status(201).json({
      success: true,
      message: 'Housekeeping task scheduled.',
      data: task
    });
  } catch (err) {
    next(err);
  }
};

export const updateTaskStatus = async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const allowedStatuses = [
      HOUSEKEEPING_STATUS.DIRTY,
      HOUSEKEEPING_STATUS.CLEANING_IN_PROGRESS,
      HOUSEKEEPING_STATUS.CLEAN,
      HOUSEKEEPING_STATUS.INSPECTED
    ];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid housekeeping task status.' });
    }
    const task = await HousekeepingTask.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('roomId', 'roomNumber');
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }
    const isManager = ['hotel_admin', 'receptionist'].includes(req.user.role);
    if (!isManager && String(task.assignedTo) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the assigned employee or hotel operations can update this task.' });
    }
    if (task.assignedTo && task.assignmentStatus === 'pending' && status !== HOUSEKEEPING_STATUS.DIRTY) {
      return res.status(409).json({ success: false, message: 'Accept the assigned task before starting work.' });
    }
    if (task.status === HOUSEKEEPING_STATUS.INSPECTED) {
      return res.status(409).json({ success: false, message: 'Completed housekeeping tasks cannot be changed.' });
    }

    const nextStatus = {
      [HOUSEKEEPING_STATUS.DIRTY]: HOUSEKEEPING_STATUS.CLEANING_IN_PROGRESS,
      [HOUSEKEEPING_STATUS.CLEANING_IN_PROGRESS]: HOUSEKEEPING_STATUS.CLEAN,
      [HOUSEKEEPING_STATUS.CLEAN]: HOUSEKEEPING_STATUS.INSPECTED
    };
    if (nextStatus[task.status] !== status) {
      return res.status(409).json({
        success: false,
        message: 'Invalid status transition. Move the room to the next readiness stage only.'
      });
    }

    const previousStatus = task.status;
    const previousStartedAt = task.startedAt;
    const previousCompletedAt = task.completedAt;
    const previousInspectedBy = task.inspectedBy;
    const previousInspectedAt = task.inspectedAt;
    const previousNotes = task.notes;

    task.status = status;
    if (notes) task.notes = notes;

    if (status === HOUSEKEEPING_STATUS.CLEANING_IN_PROGRESS && !task.startedAt) {
      task.startedAt = new Date();
    }
    if (status === HOUSEKEEPING_STATUS.CLEAN && !task.completedAt) {
      task.completedAt = new Date();
    }
    if (status === HOUSEKEEPING_STATUS.INSPECTED) {
      task.inspectedBy = req.user._id;
      task.inspectedAt = new Date();
    }
    await task.save();

    // Sync room housekeeping status. Restore the task if the room cannot be updated,
    // so persistence never leaves task and room states inconsistent.
    const room = await Room.findById(task.roomId);
    if (room) {
      const previousRoomStatus = room.housekeepingStatus;
      room.housekeepingStatus = status;
      try {
        await room.save();
      } catch (error) {
        task.status = previousStatus;
        task.startedAt = previousStartedAt;
        task.completedAt = previousCompletedAt;
        task.inspectedBy = previousInspectedBy;
        task.inspectedAt = previousInspectedAt;
        task.notes = previousNotes;
        await task.save();
        room.housekeepingStatus = previousRoomStatus;
        throw error;
      }
    }

    if (status === HOUSEKEEPING_STATUS.CLEAN || status === HOUSEKEEPING_STATUS.INSPECTED) {
      await notifyRoles({
        hotelId: req.hotelId,
        roles: ['hotel_admin', 'receptionist'],
        title: status === HOUSEKEEPING_STATUS.CLEAN ? 'Room cleaning completed' : 'Room inspection completed',
        message: `Room ${room?.roomNumber || ''} is ${status.replace(/_/g, ' ')}.`,
        module: 'housekeeping',
        eventType: `housekeeping_${status}`,
        relatedRecordId: task._id,
        link: '/housekeeping',
        eventId: `housekeeping-status:${task._id}:${status}`
      });
    }

    res.json({
      success: true,
      message: `Task status updated to ${status}.`,
      data: task
    });
  } catch (err) {
    next(err);
  }
};

const canManageAssignment = (task, user) =>
  String(task.assignedTo?._id || task.assignedTo) === String(user._id)
  || ['hotel_admin', 'receptionist'].includes(user.role);

const assignmentPendingFilter = {
  $or: [{ assignmentStatus: 'pending' }, { assignmentStatus: { $exists: false } }]
};

export const acceptTaskAssignment = async (req, res, next) => {
  try {
    const task = await HousekeepingTask.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!task.assignedTo || !canManageAssignment(task, req.user)) {
      return res.status(403).json({ success: false, message: 'Only the assigned employee or hotel operations can accept this task.' });
    }

    const acceptedAt = new Date();
    const updatedTask = await HousekeepingTask.findOneAndUpdate({
      _id: task._id,
      hotelId: req.hotelId,
      assignedTo: task.assignedTo,
      ...assignmentPendingFilter,
      status: { $nin: [HOUSEKEEPING_STATUS.CLEAN, HOUSEKEEPING_STATUS.INSPECTED, HOUSEKEEPING_STATUS.REJECTED] }
    }, {
      $set: { assignmentStatus: 'accepted', acceptedBy: req.user._id, acceptedAt },
      $push: {
        assignmentHistory: {
          action: 'accepted',
          actorId: req.user._id,
          assignedTo: task.assignedTo,
          timestamp: acceptedAt
        }
      }
    }, { new: true, runValidators: true });

    if (!updatedTask) {
      return res.status(409).json({ success: false, message: 'This task has already been accepted, rejected, or completed.' });
    }
    await logAudit({
      hotelId: req.hotelId,
      action: 'ACCEPT_HOUSEKEEPING_TASK',
      entity: 'HousekeepingTask',
      entityId: updatedTask._id,
      req
    });
    res.json({ success: true, message: 'Task assignment accepted.', data: updatedTask });
  } catch (err) {
    next(err);
  }
};

export const rejectTaskAssignment = async (req, res, next) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ success: false, message: 'A rejection reason is required.' });

    const task = await HousekeepingTask.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('roomId', 'roomNumber')
      .populate('assignedTo', 'name');
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!task.assignedTo || !canManageAssignment(task, req.user)) {
      return res.status(403).json({ success: false, message: 'Only the assigned employee or hotel operations can reject this task.' });
    }

    const rejectedAt = new Date();
    const updatedTask = await HousekeepingTask.findOneAndUpdate({
      _id: task._id,
      hotelId: req.hotelId,
      assignedTo: task.assignedTo._id,
      ...assignmentPendingFilter,
      status: { $nin: [HOUSEKEEPING_STATUS.CLEAN, HOUSEKEEPING_STATUS.INSPECTED, HOUSEKEEPING_STATUS.REJECTED] }
    }, {
      $set: {
        status: HOUSEKEEPING_STATUS.REJECTED,
        assignmentStatus: 'rejected',
        rejectionReason: reason,
        rejectedBy: req.user._id,
        rejectedAt
      },
      $push: {
        assignmentHistory: {
          action: 'rejected',
          actorId: req.user._id,
          assignedTo: task.assignedTo._id,
          timestamp: rejectedAt,
          reason
        }
      }
    }, { new: true, runValidators: true });
    if (!updatedTask) {
      return res.status(409).json({ success: false, message: 'Only pending, unfinished assignments can be rejected.' });
    }

    const roomNumber = task.roomId?.roomNumber || 'Room';
    const jobTitle = `Cleaning task for Room ${roomNumber}`;
    await notifyJobRejection({
      hotelId: req.hotelId,
      jobId: task._id,
      jobReference: `#${String(task._id).slice(-6).toUpperCase()}`,
      jobTitle,
      assignedTo: task.assignedTo._id,
      assignedBy: task.assignedBy,
      assigneeName: task.assignedTo.name,
      actorId: req.user._id,
      reason,
      rejectedAt,
      module: 'housekeeping',
      eventType: 'housekeeping_task_rejected',
      link: '/housekeeping'
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'REJECT_HOUSEKEEPING_TASK',
      entity: 'HousekeepingTask',
      entityId: task._id,
      details: { reason, assignedTo: String(task.assignedTo._id), rejectedAt },
      req
    });
    res.json({ success: true, message: 'Task rejected and the assigned team has been notified.', data: updatedTask });
  } catch (err) {
    next(err);
  }
};

export const reassignRejectedTask = async (req, res, next) => {
  try {
    if (!['hotel_admin', 'receptionist'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel operations can reassign tasks.' });
    }
    const { assignedTo } = req.body;
    const assignee = await User.findOne({
      _id: assignedTo,
      hotelId: req.hotelId,
      isActive: true,
      role: 'housekeeping_staff'
    }).select('_id name');
    if (!assignee) {
      return res.status(400).json({ success: false, message: 'Choose an active housekeeping employee from this hotel.' });
    }

    const task = await HousekeepingTask.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('roomId', 'roomNumber');
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (task.status !== HOUSEKEEPING_STATUS.REJECTED) {
      return res.status(409).json({ success: false, message: 'Only rejected tasks can be reassigned through this workflow.' });
    }

    const assignedAt = new Date();
    const updatedTask = await HousekeepingTask.findOneAndUpdate({
      _id: task._id,
      hotelId: req.hotelId,
      status: HOUSEKEEPING_STATUS.REJECTED
    }, {
      $set: {
        assignedTo: assignee._id,
        assignedBy: req.user._id,
        assignedAt,
        assignmentStatus: 'pending',
        status: HOUSEKEEPING_STATUS.DIRTY,
        acceptedBy: null,
        acceptedAt: null
      },
      $push: {
        assignmentHistory: {
          action: 'reassigned',
          actorId: req.user._id,
          assignedTo: assignee._id,
          previousAssignee: task.assignedTo,
          timestamp: assignedAt,
          reason: task.rejectionReason
        }
      }
    }, { new: true, runValidators: true });
    if (!updatedTask) {
      return res.status(409).json({ success: false, message: 'This task has already been reassigned.' });
    }

    await notifyUsers({
      hotelId: req.hotelId,
      userIds: [assignee._id],
      roles: ['housekeeping_staff'],
      title: 'Cleaning task reassigned to you',
      message: `A cleaning task for room ${task.roomId?.roomNumber || ''} has been reassigned to you.`,
      module: 'housekeeping',
      eventType: 'housekeeping_task_assigned',
      relatedRecordId: task._id,
      priority: 'medium',
      link: '/housekeeping',
      eventId: `housekeeping-reassigned:${task._id}:${assignedAt.getTime()}`
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'REASSIGN_HOUSEKEEPING_TASK',
      entity: 'HousekeepingTask',
      entityId: task._id,
      details: {
        previousAssignee: task.assignedTo ? String(task.assignedTo) : '',
        assignedTo: String(assignee._id),
        assignedAt
      },
      req
    });
    res.json({ success: true, message: 'Task reassigned and the new assignee has been notified.', data: updatedTask });
  } catch (err) {
    next(err);
  }
};

export const reportDamage = async (req, res, next) => {
  try {
    const { damageDescription, createMaintenanceTicket, priority = PRIORITY.HIGH } = req.body;
    const task = await HousekeepingTask.findOne({ _id: req.params.id, hotelId: req.hotelId }).populate('roomId');
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    task.damageReported = true;
    task.damageDescription = damageDescription;
    await task.save();

    let ticket = null;
    if (createMaintenanceTicket && task.roomId) {
      const ticketNumber = generateReference('MNT');
      ticket = await MaintenanceTicket.create({
        hotelId: req.hotelId,
        propertyId: task.propertyId,
        ticketNumber,
        roomId: task.roomId._id,
        roomNumber: task.roomId.roomNumber,
        issueDescription: damageDescription,
        priority,
        status: MAINTENANCE_STATUS.OPEN,
        reportedBy: req.user._id,
        takesRoomOutOfService: priority === PRIORITY.CRITICAL
      });

      if (priority === PRIORITY.CRITICAL) {
        task.roomId.roomStatus = 'out_of_service';
        await task.roomId.save();
      }
    }

    res.json({
      success: true,
      message: 'Damage reported successfully and logged to maintenance.',
      data: {
        task,
        ticket
      }
    });
  } catch (err) {
    next(err);
  }
};
