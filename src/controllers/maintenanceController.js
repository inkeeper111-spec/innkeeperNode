import { MaintenanceTicket, Room, Expense, User } from '../models/index.js';
import { MAINTENANCE_STATUS, PRIORITY, ROOM_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { notifyRoles, notifyUsers } from '../services/notificationService.js';
import { logAudit } from '../services/auditService.js';
import { notifyJobRejection } from '../services/jobAssignmentService.js';

export const getTickets = async (req, res, next) => {
  try {
    const { status, priority } = req.query;
    const filter = { hotelId: req.hotelId };
    if (req.user.role === 'maintenance_staff') filter.assignedTechnician = req.user._id;

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
    if (assignedTechnician && !['hotel_admin', 'receptionist'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel operations can assign a maintenance ticket.' });
    }

    let roomNumber = '';
    if (roomId) {
      const room = await Room.findOne({ _id: roomId, hotelId: req.hotelId });
      if (room) {
        roomNumber = room.roomNumber;
        if (takesRoomOutOfService || priority === PRIORITY.CRITICAL) {
          room.roomStatus = ROOM_STATUS.OUT_OF_SERVICE;
          room.maintenanceStatus = 'out_of_order';
          await room.save();
        }
      } else {
        return res.status(404).json({ success: false, message: 'Room not found in this hotel.' });
      }
    }

    let technician = null;
    if (assignedTechnician) {
      technician = await User.findOne({
        _id: assignedTechnician,
        hotelId: req.hotelId,
        isActive: true,
        role: 'maintenance_staff'
      }).select('_id');
      if (!technician) {
        return res.status(400).json({ success: false, message: 'Choose an active maintenance employee from this hotel.' });
      }
    }

    const ticketNumber = generateReference('MNT');
    const assignedAt = technician ? new Date() : null;
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
      status: technician ? MAINTENANCE_STATUS.ASSIGNED : MAINTENANCE_STATUS.OPEN,
      reportedBy: req.user._id,
      assignedTechnician: technician?._id || null,
      assignedBy: technician ? req.user._id : null,
      assignedAt,
      assignmentStatus: 'pending',
      assignmentHistory: technician ? [{
        action: 'assigned',
        actorId: req.user._id,
        assignedTo: technician._id,
        timestamp: assignedAt
      }] : [],
      estimatedCost: Number(estimatedCost),
      takesRoomOutOfService: Boolean(takesRoomOutOfService || priority === PRIORITY.CRITICAL)
    });

    await notifyRoles({
      hotelId: req.hotelId,
      roles: ['hotel_admin'],
      title: priority === PRIORITY.CRITICAL ? 'Urgent maintenance request' : 'Maintenance request created',
      message: `${priority === PRIORITY.CRITICAL ? 'Urgent ' : ''}maintenance ticket ${ticket.ticketNumber} requires attention.`,
      module: 'maintenance',
      eventType: 'maintenance_ticket_created',
      relatedRecordId: ticket._id,
      priority: priority === PRIORITY.CRITICAL ? 'critical' : priority === PRIORITY.HIGH ? 'high' : 'medium',
      link: '/maintenance',
      eventId: `maintenance-created-admin:${ticket._id}`
    });
    if (ticket.assignedTechnician) {
      await notifyUsers({
        hotelId: req.hotelId,
        userIds: [ticket.assignedTechnician],
        roles: ['maintenance_staff'],
        title: 'Maintenance request assigned',
        message: `Maintenance ticket ${ticket.ticketNumber} has been assigned to you.`,
        module: 'maintenance',
        eventType: 'maintenance_ticket_assigned',
        relatedRecordId: ticket._id,
        priority: priority === PRIORITY.CRITICAL ? 'critical' : priority === PRIORITY.HIGH ? 'high' : 'medium',
        link: '/maintenance',
        eventId: `maintenance-assigned:${ticket._id}`
      });
      await logAudit({
        hotelId: req.hotelId,
        action: 'ASSIGN_MAINTENANCE_TICKET',
        entity: 'MaintenanceTicket',
        entityId: ticket._id,
        details: { assignedTo: String(technician._id), assignedAt },
        req
      });
    }

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

    const isManager = ['hotel_admin', 'receptionist'].includes(req.user.role);
    if (!isManager && String(ticket.assignedTechnician) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the assigned technician or hotel operations can update this ticket.' });
    }
    if (assignedTechnician && !isManager) {
      return res.status(403).json({ success: false, message: 'Only hotel operations can assign or reassign a technician.' });
    }
    if (status && !Object.values(MAINTENANCE_STATUS).includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid maintenance ticket status.' });
    }
    if (status === MAINTENANCE_STATUS.IN_PROGRESS && !isManager
      && ticket.assignmentStatus !== 'accepted') {
      return res.status(409).json({ success: false, message: 'Accept the assigned ticket before starting work.' });
    }
    const previousTechnician = ticket.assignedTechnician ? String(ticket.assignedTechnician) : '';
    const isReassignmentOfRejectedTicket = ticket.status === MAINTENANCE_STATUS.REJECTED
      && isManager
      && assignedTechnician
      && String(assignedTechnician) !== previousTechnician;
    if ([MAINTENANCE_STATUS.RESOLVED, MAINTENANCE_STATUS.CLOSED].includes(ticket.status)
      || (ticket.status === MAINTENANCE_STATUS.REJECTED && !isReassignmentOfRejectedTicket)) {
      return res.status(409).json({ success: false, message: 'Finalized maintenance tickets cannot be changed.' });
    }

    let technician = null;
    if (assignedTechnician && String(assignedTechnician) !== previousTechnician) {
      technician = await User.findOne({
        _id: assignedTechnician,
        hotelId: req.hotelId,
        isActive: true,
        role: 'maintenance_staff'
      }).select('_id');
      if (!technician) {
        return res.status(400).json({ success: false, message: 'Choose an active maintenance employee from this hotel.' });
      }
      const assignedAt = new Date();
      ticket.assignmentHistory.push({
        action: previousTechnician ? 'reassigned' : 'assigned',
        actorId: req.user._id,
        assignedTo: technician._id,
        previousAssignee: ticket.assignedTechnician || null,
        timestamp: assignedAt
      });
      ticket.assignedTechnician = technician._id;
      ticket.assignedBy = req.user._id;
      ticket.assignedAt = assignedAt;
      ticket.assignmentStatus = 'pending';
      ticket.acceptedBy = undefined;
      ticket.acceptedAt = undefined;
      if (ticket.status === MAINTENANCE_STATUS.REJECTED || ticket.status === MAINTENANCE_STATUS.OPEN) {
        ticket.status = MAINTENANCE_STATUS.ASSIGNED;
      }
    }
    if (status && !isReassignmentOfRejectedTicket) {
      ticket.status = status;
    }
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

    if (status || assignedTechnician) {
      const eventType = status ? `maintenance_${status}` : 'maintenance_ticket_reassigned';
      if (assignedTechnician && String(assignedTechnician) !== previousTechnician) {
        await notifyUsers({
          hotelId: req.hotelId,
          userIds: [technician._id],
          roles: ['maintenance_staff'],
          title: 'Maintenance request assigned',
          message: `Maintenance ticket ${ticket.ticketNumber} has been assigned to you.`,
          module: 'maintenance',
          eventType: 'maintenance_ticket_assigned',
          relatedRecordId: ticket._id,
          priority: ticket.priority === PRIORITY.CRITICAL ? 'critical' : 'high',
          link: '/maintenance',
          eventId: `maintenance-reassigned:${ticket._id}:${ticket.assignedAt.getTime()}`
        });
        await logAudit({
          hotelId: req.hotelId,
          action: 'REASSIGN_MAINTENANCE_TICKET',
          entity: 'MaintenanceTicket',
          entityId: ticket._id,
          details: {
            previousAssignee: previousTechnician,
            assignedTo: String(technician._id),
            assignedAt: ticket.assignedAt
          },
          req
        });
      }
      await notifyRoles({
        hotelId: req.hotelId,
        roles: ['hotel_admin'],
        title: 'Maintenance ticket updated',
        message: `Maintenance ticket ${ticket.ticketNumber} is now ${ticket.status}.`,
        module: 'maintenance',
        eventType,
        relatedRecordId: ticket._id,
        priority: ticket.priority === PRIORITY.CRITICAL ? 'critical' : 'medium',
        link: '/maintenance',
        eventId: `maintenance-update:${ticket._id}:${ticket.updatedAt?.getTime?.() || Date.now()}`
      });
    }

    res.json({
      success: true,
      message: `Ticket updated. Status: ${ticket.status}.`,
      data: ticket
    });
  } catch (err) {
    next(err);
  }
};

const assignmentPendingFilter = {
  $or: [{ assignmentStatus: 'pending' }, { assignmentStatus: { $exists: false } }]
};

const canManageAssignment = (ticket, user) =>
  String(ticket.assignedTechnician?._id || ticket.assignedTechnician) === String(user._id)
  || ['hotel_admin', 'receptionist'].includes(user.role);

export const acceptTicketAssignment = async (req, res, next) => {
  try {
    const ticket = await MaintenanceTicket.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    if (!ticket.assignedTechnician || !canManageAssignment(ticket, req.user)) {
      return res.status(403).json({ success: false, message: 'Only the assigned technician or hotel operations can accept this ticket.' });
    }

    const acceptedAt = new Date();
    const updatedTicket = await MaintenanceTicket.findOneAndUpdate({
      _id: ticket._id,
      hotelId: req.hotelId,
      assignedTechnician: ticket.assignedTechnician,
      ...assignmentPendingFilter,
      status: { $nin: [MAINTENANCE_STATUS.RESOLVED, MAINTENANCE_STATUS.CLOSED, MAINTENANCE_STATUS.REJECTED] }
    }, {
      $set: { assignmentStatus: 'accepted', acceptedBy: req.user._id, acceptedAt },
      $push: {
        assignmentHistory: {
          action: 'accepted',
          actorId: req.user._id,
          assignedTo: ticket.assignedTechnician,
          timestamp: acceptedAt
        }
      }
    }, { new: true, runValidators: true });

    if (!updatedTicket) {
      return res.status(409).json({ success: false, message: 'This ticket has already been accepted, rejected, or completed.' });
    }
    await logAudit({
      hotelId: req.hotelId,
      action: 'ACCEPT_MAINTENANCE_TICKET',
      entity: 'MaintenanceTicket',
      entityId: updatedTicket._id,
      req
    });
    res.json({ success: true, message: 'Ticket assignment accepted.', data: updatedTicket });
  } catch (err) {
    next(err);
  }
};

export const rejectTicketAssignment = async (req, res, next) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ success: false, message: 'A rejection reason is required.' });

    const ticket = await MaintenanceTicket.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('assignedTechnician', 'name');
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    if (!ticket.assignedTechnician || !canManageAssignment(ticket, req.user)) {
      return res.status(403).json({ success: false, message: 'Only the assigned technician or hotel operations can reject this ticket.' });
    }

    const rejectedAt = new Date();
    const updatedTicket = await MaintenanceTicket.findOneAndUpdate({
      _id: ticket._id,
      hotelId: req.hotelId,
      assignedTechnician: ticket.assignedTechnician._id,
      ...assignmentPendingFilter,
      status: { $nin: [MAINTENANCE_STATUS.RESOLVED, MAINTENANCE_STATUS.CLOSED, MAINTENANCE_STATUS.REJECTED] }
    }, {
      $set: {
        status: MAINTENANCE_STATUS.REJECTED,
        assignmentStatus: 'rejected',
        rejectionReason: reason,
        rejectedBy: req.user._id,
        rejectedAt
      },
      $push: {
        assignmentHistory: {
          action: 'rejected',
          actorId: req.user._id,
          assignedTo: ticket.assignedTechnician._id,
          timestamp: rejectedAt,
          reason
        }
      }
    }, { new: true, runValidators: true });
    if (!updatedTicket) {
      return res.status(409).json({ success: false, message: 'Only pending, unfinished assignments can be rejected.' });
    }

    await notifyJobRejection({
      hotelId: req.hotelId,
      jobId: ticket._id,
      jobReference: ticket.ticketNumber,
      jobTitle: ticket.issueDescription,
      assignedTo: ticket.assignedTechnician._id,
      assignedBy: ticket.assignedBy,
      assigneeName: ticket.assignedTechnician.name,
      actorId: req.user._id,
      reason,
      rejectedAt,
      module: 'maintenance',
      eventType: 'maintenance_ticket_rejected',
      link: '/maintenance'
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'REJECT_MAINTENANCE_TICKET',
      entity: 'MaintenanceTicket',
      entityId: ticket._id,
      details: { reason, assignedTo: String(ticket.assignedTechnician._id), rejectedAt },
      req
    });
    res.json({ success: true, message: 'Ticket rejected and the assigned team has been notified.', data: updatedTicket });
  } catch (err) {
    next(err);
  }
};
