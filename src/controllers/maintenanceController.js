import { MaintenanceTicket, Room, Expense } from '../models/index.js';
import { MAINTENANCE_STATUS, PRIORITY, ROOM_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';

export const getTickets = async (req, res, next) => {
  try {
    const { status, priority } = req.query;
    const filter = { hotelId: req.hotelId };

    if (status && status !== 'all') filter.status = status;
    if (priority && priority !== 'all') filter.priority = priority;

    const tickets = await MaintenanceTicket.find(filter)
      .populate('roomId', 'roomNumber floor roomStatus')
      .populate('reportedBy', 'name')
      .populate('assignedTechnician', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: tickets });
  } catch (err) {
    next(err);
  }
};

export const createTicket = async (req, res, next) => {
  try {
    const {
      roomId,
      equipmentName,
      category,
      issueDescription,
      priority = PRIORITY.MEDIUM,
      assignedTechnician,
      estimatedCost = 0,
      takesRoomOutOfService = false
    } = req.body;

    let roomNumber = '';
    if (roomId) {
      const room = await Room.findById(roomId);
      if (room) {
        roomNumber = room.roomNumber;
        if (takesRoomOutOfService || priority === PRIORITY.CRITICAL) {
          room.roomStatus = ROOM_STATUS.OUT_OF_SERVICE;
          room.maintenanceStatus = 'out_of_order';
          await room.save();
        }
      }
    }

    const ticketNumber = generateReference('MNT');
    const ticket = await MaintenanceTicket.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      ticketNumber,
      roomId: roomId || null,
      roomNumber,
      equipmentName: equipmentName || '',
      category,
      issueDescription,
      priority,
      status: MAINTENANCE_STATUS.OPEN,
      reportedBy: req.user._id,
      assignedTechnician: assignedTechnician || null,
      estimatedCost: Number(estimatedCost),
      takesRoomOutOfService: Boolean(takesRoomOutOfService || priority === PRIORITY.CRITICAL)
    });

    res.status(201).json({
      success: true,
      message: 'Maintenance ticket created.',
      data: ticket
    });
  } catch (err) {
    next(err);
  }
};

export const updateTicket = async (req, res, next) => {
  try {
    const { status, assignedTechnician, actualCost, materialsUsed, resolutionNotes } = req.body;
    const ticket = await MaintenanceTicket.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    if (status) ticket.status = status;
    if (assignedTechnician) ticket.assignedTechnician = assignedTechnician;
    if (actualCost !== undefined) ticket.actualCost = Number(actualCost);
    if (materialsUsed) ticket.materialsUsed = materialsUsed;
    if (resolutionNotes) ticket.resolutionNotes = resolutionNotes;

    if (status === MAINTENANCE_STATUS.RESOLVED && !ticket.resolvedAt) {
      ticket.resolvedAt = new Date();
    }

    if (status === MAINTENANCE_STATUS.CLOSED) {
      ticket.closedAt = new Date();
      // If room was out of service, restore it back to clean / available
      if (ticket.roomId && ticket.takesRoomOutOfService) {
        const room = await Room.findById(ticket.roomId);
        if (room && room.roomStatus === ROOM_STATUS.OUT_OF_SERVICE) {
          room.roomStatus = ROOM_STATUS.AVAILABLE;
          room.maintenanceStatus = 'normal';
          await room.save();
        }
      }
    }

    await ticket.save();

    res.json({
      success: true,
      message: `Ticket updated. Status: ${ticket.status}.`,
      data: ticket
    });
  } catch (err) {
    next(err);
  }
};

