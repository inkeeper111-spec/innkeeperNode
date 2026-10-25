import { HousekeepingTask, Room, MaintenanceTicket } from '../models/index.js';
import { HOUSEKEEPING_STATUS, PRIORITY, MAINTENANCE_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';

export const getTasks = async (req, res, next) => {
  try {
    const { status, priority } = req.query;
    const filter = { hotelId: req.hotelId };

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

    const room = await Room.findOne({ _id: roomId, hotelId: req.hotelId });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    const task = await HousekeepingTask.create({
      hotelId: req.hotelId,
      propertyId: room.propertyId,
      roomId: room._id,
      assignedTo: assignedTo || null,
      priority,
      taskType,
      status: HOUSEKEEPING_STATUS.DIRTY,
      notes
    });

    // Sync room housekeeping status
    room.housekeepingStatus = HOUSEKEEPING_STATUS.DIRTY;
    await room.save();

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
    const task = await HousekeepingTask.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

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

    // Sync room housekeeping status
    const room = await Room.findById(task.roomId);
    if (room) {
      room.housekeepingStatus = status;
      await room.save();
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

