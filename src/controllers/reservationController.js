import dayjs from 'dayjs';
import { Reservation, Room, RoomType, Guest, Invoice } from '../models/index.js';
import { RESERVATION_STATUS, ROOM_STATUS, HOUSEKEEPING_STATUS, PAYMENT_STATUS, INVOICE_STATUS, PRIORITY, ROLES } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { sendEmail } from '../services/emailService.js';
import { notifyGuestByEmail, notifyRoles } from '../services/notificationService.js';

const ACTIVE_RESERVATION_STATUSES = [
  RESERVATION_STATUS.PENDING,
  RESERVATION_STATUS.PENDING_APPROVAL,
  RESERVATION_STATUS.APPROVED,
  RESERVATION_STATUS.CONFIRMED,
  RESERVATION_STATUS.CHECKED_IN
];

const canManageReservationRequests = (user) =>
  [ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN].includes(user.role);

export const getReservationRequests = async (req, res, next) => {
  try {
    const reservations = await Reservation.find({
      hotelId: req.hotelId,
      status: RESERVATION_STATUS.PENDING_APPROVAL
    })
      .populate('guestId', 'name email phone')
      .populate('rooms.roomId', 'roomNumber roomStatus isActive')
      .populate('rooms.roomTypeId', 'name')
      .sort({ createdAt: 1 });
    const activeReservations = await Reservation.find({
      hotelId: req.hotelId,
      status: { $in: ACTIVE_RESERVATION_STATUSES }
    }).select('_id rooms.roomId checkInDate checkOutDate').lean();

    const requestsWithAvailability = reservations.map((reservation) => {
      const roomIds = new Set(
        reservation.rooms.map((room) => room.roomId?._id).filter(Boolean).map(String)
      );
      const conflict = activeReservations.some((other) =>
        !other._id.equals(reservation._id)
        && other.checkInDate < reservation.checkOutDate
        && other.checkOutDate > reservation.checkInDate
        && other.rooms.some((room) => roomIds.has(String(room.roomId)))
      );
      const roomsAvailable = reservation.rooms.length > 0 && reservation.rooms.every(
        (room) => room.roomId?.isActive && room.roomId?.roomStatus !== ROOM_STATUS.OUT_OF_SERVICE
      );

      return {
        ...reservation.toObject(),
        isRoomAvailable: roomsAvailable && !conflict
      };
    });

    res.json({ success: true, data: { reservations: requestsWithAvailability } });
  } catch (err) {
    next(err);
  }
};

const notifyReservationGuest = async (reservation, action, reason = '') => {
  if (!reservation.guestEmail) return;

  const isApproved = action === 'approved';
  await sendEmail({
    to: reservation.guestEmail,
    subject: `Reservation ${reservation.bookingReference} ${action}`,
    text: isApproved
      ? `Your reservation ${reservation.bookingReference} has been approved by the hotel team.`
      : `Your reservation ${reservation.bookingReference} has been rejected by the hotel team. Reason: ${reason}`
  });
};

export const approveReservationRequest = async (req, res, next) => {
  try {
    const reservation = await Reservation.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      status: RESERVATION_STATUS.PENDING_APPROVAL
    });

    if (!reservation) {
      const existing = await Reservation.exists({ _id: req.params.id, hotelId: req.hotelId });
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing
          ? 'Only pending reservation requests can be approved.'
          : 'Reservation request not found.'
      });
    }

    const conflict = await Reservation.exists({
      _id: { $ne: reservation._id },
      hotelId: req.hotelId,
      status: { $in: ACTIVE_RESERVATION_STATUSES },
      'rooms.roomId': { $in: reservation.rooms.map((room) => room.roomId) },
      checkInDate: { $lt: reservation.checkOutDate },
      checkOutDate: { $gt: reservation.checkInDate }
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        message: 'Room availability changed. This reservation cannot be approved for the selected dates.'
      });
    }

    const roomsAvailable = await Room.countDocuments({
      _id: { $in: reservation.rooms.map((room) => room.roomId) },
      hotelId: req.hotelId,
      isActive: true,
      roomStatus: { $ne: ROOM_STATUS.OUT_OF_SERVICE }
    });
    if (roomsAvailable !== reservation.rooms.length) {
      return res.status(409).json({
        success: false,
        message: 'One or more rooms are no longer available for reservation.'
      });
    }

    const approvedAt = new Date();
    const updatedReservation = await Reservation.findOneAndUpdate(
      {
        _id: reservation._id,
        hotelId: req.hotelId,
        status: RESERVATION_STATUS.PENDING_APPROVAL
      },
      {
        $set: {
          status: RESERVATION_STATUS.APPROVED,
          approvedBy: req.user._id,
          approvedByRole: req.user.role,
          approvedAt
        }
      },
      { new: true, runValidators: true }
    );

    if (!updatedReservation) {
      return res.status(409).json({
        success: false,
        message: 'This reservation request has already been processed.'
      });
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'APPROVE_RESERVATION',
      entity: 'Reservation',
      entityId: updatedReservation._id,
      details: {
        bookingReference: updatedReservation.bookingReference,
        actorId: String(req.user._id),
        actorRole: req.user.role,
        approvedAt
      },
      req
    });

    await notifyRoles({
      hotelId: req.hotelId,
      roles: [ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST],
      title: 'Reservation Approved',
      message: `Reservation ${updatedReservation.bookingReference} was approved.`,
      module: 'reservations',
      eventType: 'reservation_approved',
      relatedRecordId: updatedReservation._id,
      priority: 'medium',
      link: `/reservations`,
      eventId: `reservation-approved:${updatedReservation._id}`
    });
    await notifyGuestByEmail({
      hotelId: req.hotelId,
      email: updatedReservation.guestEmail,
      title: 'Reservation approved',
      message: `Your reservation ${updatedReservation.bookingReference} has been approved.`,
      module: 'reservations',
      eventType: 'reservation_approved',
      relatedRecordId: updatedReservation._id,
      link: '/lookup',
      eventId: `reservation-approved-guest:${updatedReservation._id}`
    });
    await notifyReservationGuest(updatedReservation, 'approved');

    res.json({
      success: true,
      message: 'Reservation approved successfully.',
      data: updatedReservation
    });
  } catch (err) {
    next(err);
  }
};

export const rejectReservationRequest = async (req, res, next) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A rejection reason is required.'
      });
    }

    const rejectedAt = new Date();
    const reservation = await Reservation.findOneAndUpdate(
      {
        _id: req.params.id,
        hotelId: req.hotelId,
        status: RESERVATION_STATUS.PENDING_APPROVAL
      },
      {
        $set: {
          status: RESERVATION_STATUS.REJECTED,
          rejectionReason: reason,
          rejectedBy: req.user._id,
          rejectedByRole: req.user.role,
          rejectedAt
        }
      },
      { new: true, runValidators: true }
    );

    if (!reservation) {
      const existing = await Reservation.exists({ _id: req.params.id, hotelId: req.hotelId });
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing
          ? 'Only pending reservation requests can be rejected.'
          : 'Reservation request not found.'
      });
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'REJECT_RESERVATION',
      entity: 'Reservation',
      entityId: reservation._id,
      details: {
        bookingReference: reservation.bookingReference,
        actorId: String(req.user._id),
        actorRole: req.user.role,
        rejectedAt,
        reason
      },
      req
    });

    await notifyRoles({
      hotelId: req.hotelId,
      roles: [ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST],
      title: 'Reservation Rejected',
      message: `Reservation ${reservation.bookingReference} was rejected.`,
      module: 'reservations',
      eventType: 'reservation_rejected',
      relatedRecordId: reservation._id,
      priority: 'medium',
      link: '/reservations',
      eventId: `reservation-rejected:${reservation._id}`
    });
    await notifyGuestByEmail({
      hotelId: req.hotelId,
      email: reservation.guestEmail,
      title: 'Reservation rejected',
      message: `Your reservation ${reservation.bookingReference} was rejected. Reason: ${reason}`,
      module: 'reservations',
      eventType: 'reservation_rejected',
      relatedRecordId: reservation._id,
      priority: 'high',
      link: '/lookup',
      eventId: `reservation-rejected-guest:${reservation._id}`
    });
    await notifyReservationGuest(reservation, 'rejected', reason);

    res.json({
      success: true,
      message: 'Reservation rejected successfully.',
      data: reservation
    });
  } catch (err) {
    next(err);
  }
};

export const getReservations = async (req, res, next) => {
  try {
    const { status, search, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = { hotelId: req.hotelId };

    if (status && status !== 'all') {
      if (status === RESERVATION_STATUS.PENDING_APPROVAL && !canManageReservationRequests(req.user)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to view reservation requests.'
        });
      }
      filter.status = status;
    } else if (!canManageReservationRequests(req.user)) {
      filter.status = { $ne: RESERVATION_STATUS.PENDING_APPROVAL };
    }

    if (startDate && endDate) {
      filter.checkInDate = {
        $gte: dayjs(startDate).startOf('day').toDate(),
        $lte: dayjs(endDate).endOf('day').toDate()
      };
    }

    if (search) {
      filter.$or = [
        { bookingReference: { $regex: search, $options: 'i' } },
        { guestName: { $regex: search, $options: 'i' } },
        { guestPhone: { $regex: search, $options: 'i' } },
        { guestEmail: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Reservation.countDocuments(filter);
    const reservations = await Reservation.find(filter)
      .populate('guestId')
      .populate('rooms.roomId')
      .populate('rooms.roomTypeId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: {
        reservations,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const createReservation = async (req, res, next) => {
  try {
    const {
      guestId: providedGuestId,
      guestData,
      checkInDate,
      checkOutDate,
      rooms, // Array of { roomId, roomTypeId }
      adultsCount = 1,
      childrenCount = 0,
      bookingSource = 'walk_in',
      specialRequests = '',
      discountAmount = 0
    } = req.body;

    const start = dayjs(checkInDate).startOf('day').toDate();
    const end = dayjs(checkOutDate).startOf('day').toDate();
    const nights = dayjs(end).diff(dayjs(start), 'day');

    if (nights <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Check-out date must be at least one day after check-in date.'
      });
    }

    if (!rooms || rooms.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one room must be selected for the reservation.'
      });
    }

    const requestedRoomIds = rooms.map(r => r.roomId);

    // Double-Booking Prevention: Concurrency & Overlap Check
    const overlapping = await Reservation.find({
      hotelId: req.hotelId,
      status: { $in: ACTIVE_RESERVATION_STATUSES },
      'rooms.roomId': { $in: requestedRoomIds },
      checkInDate: { $lt: end },
      checkOutDate: { $gt: start }
    });

    if (overlapping.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'One or more selected rooms are already booked for these dates. Please choose different rooms or dates.'
      });
    }

    // Verify guest or create new guest
    let guest;
    if (providedGuestId) {
      guest = await Guest.findOne({ _id: providedGuestId, hotelId: req.hotelId });
    }
    if (!guest && guestData) {
      guest = await Guest.create({
        hotelId: req.hotelId,
        name: guestData.name,
        email: guestData.email || '',
        phone: guestData.phone,
        address: guestData.address || '',
        city: guestData.city || '',
        idDocumentType: guestData.idDocumentType || 'none',
        idDocumentNumber: guestData.idDocumentNumber || ''
      });
    }

    if (!guest) {
      return res.status(400).json({
        success: false,
        message: 'Valid guest information is required.'
      });
    }

    // Prepare room line items & calculate total
    let subtotal = 0;
    const reservationRooms = [];
    const invoiceItems = [];

    for (const r of rooms) {
      const room = await Room.findOne({ _id: r.roomId, hotelId: req.hotelId });
      const roomType = await RoomType.findOne({ _id: r.roomTypeId, hotelId: req.hotelId });

      if (!room || !roomType) {
        return res.status(400).json({ success: false, message: 'Invalid room or room type specified.' });
      }

      if (room.roomStatus === ROOM_STATUS.OUT_OF_SERVICE) {
        return res.status(400).json({ success: false, message: `Room ${room.roomNumber} is currently out of service.` });
      }

      const ratePerNight = roomType.basePrice;
      const roomTotal = ratePerNight * nights;
      subtotal += roomTotal;

      reservationRooms.push({
        roomId: room._id,
        roomTypeId: roomType._id,
        roomNumber: room.roomNumber,
        ratePerNight
      });

      invoiceItems.push({
        description: `Room ${room.roomNumber} (${roomType.name}) - ${nights} Night(s)`,
        quantity: nights,
        unitPrice: ratePerNight,
        amount: roomTotal,
        itemType: 'room'
      });
    }

    const taxRatePercent = 10; // Standard 10% tax
    const taxAmount = Math.round((subtotal - discountAmount) * (taxRatePercent / 100) * 100) / 100;
    const totalAmount = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;

    const bookingReference = generateReference('BK');

    const reservation = await Reservation.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId || reservationRooms[0]?.roomId?.propertyId,
      bookingReference,
      guestId: guest._id,
      guestName: guest.name,
      guestEmail: guest.email,
      guestPhone: guest.phone,
      checkInDate: start,
      checkOutDate: end,
      rooms: reservationRooms,
      adultsCount,
      childrenCount,
      bookingSource,
      status: RESERVATION_STATUS.CONFIRMED,
      paymentStatus: PAYMENT_STATUS.UNPAID,
      subtotal,
      discountAmount,
      taxAmount,
      totalAmount,
      paidAmount: 0,
      balanceAmount: totalAmount,
      specialRequests
    });

    // Create Initial Invoice
    const invoiceNumber = generateReference('INV');
    const invoice = await Invoice.create({
      hotelId: req.hotelId,
      propertyId: reservation.propertyId,
      invoiceNumber,
      reservationId: reservation._id,
      guestId: guest._id,
      items: invoiceItems,
      subtotal,
      discountAmount,
      taxRatePercent,
      taxAmount,
      totalAmount,
      paidAmount: 0,
      balanceAmount: totalAmount,
      status: INVOICE_STATUS.ISSUED,
      issuedBy: req.user._id
    });

    // Create Notification
    await notifyRoles({
      hotelId: req.hotelId,
      roles: [ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST],
      title: 'New Reservation',
      message: `New reservation ${bookingReference} requires review.`,
      module: 'reservations',
      eventType: 'reservation_created',
      relatedRecordId: reservation._id,
      priority: 'medium',
      link: '/reservations',
      eventId: `reservation-created:${reservation._id}`
    });
    await notifyGuestByEmail({
      hotelId: req.hotelId,
      email: reservation.guestEmail,
      title: 'Reservation received',
      message: `Your reservation ${bookingReference} was created successfully.`,
      module: 'reservations',
      eventType: 'reservation_created',
      relatedRecordId: reservation._id,
      link: '/lookup',
      eventId: `reservation-created-guest:${reservation._id}`
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_RESERVATION',
      entity: 'Reservation',
      entityId: reservation._id,
      details: { bookingReference, guestName: guest.name, totalAmount },
      req
    });

    res.status(201).json({
      success: true,
      message: 'Reservation created successfully.',
      data: {
        reservation,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getReservationById = async (req, res, next) => {
  try {
    const reservation = await Reservation.findOne({
      _id: req.params.id,
      hotelId: req.hotelId
    })
      .populate('guestId')
      .populate('rooms.roomId')
      .populate('rooms.roomTypeId')
      .populate('checkedInBy', 'name')
      .populate('checkedOutBy', 'name');

    if (!reservation) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    if (reservation.status === RESERVATION_STATUS.PENDING_APPROVAL && !canManageReservationRequests(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view reservation requests.'
      });
    }

    const invoices = await Invoice.find({ reservationId: reservation._id, hotelId: req.hotelId });

    res.json({
      success: true,
      data: {
        reservation,
        invoices
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Check-In Workflow
 */
export const checkInReservation = async (req, res, next) => {
  try {
    const reservation = await Reservation.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    if (reservation.status === RESERVATION_STATUS.CHECKED_IN) {
      return res.status(400).json({ success: false, message: 'Reservation is already checked in.' });
    }

    if (reservation.status === RESERVATION_STATUS.CANCELLED) {
      return res.status(400).json({ success: false, message: 'Cannot check in a cancelled reservation.' });
    }

    if (![RESERVATION_STATUS.APPROVED, RESERVATION_STATUS.CONFIRMED].includes(reservation.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only approved reservations can be checked in.'
      });
    }

    // Verify rooms are ready and not out of service
    for (const r of reservation.rooms) {
      const room = await Room.findById(r.roomId);
      if (!room) {
        return res.status(400).json({ success: false, message: `Room not found for ID: ${r.roomId}` });
      }
      if (room.roomStatus === ROOM_STATUS.OUT_OF_SERVICE) {
        return res.status(400).json({ success: false, message: `Room ${room.roomNumber} is currently out of service.` });
      }
      // Update room to occupied
      room.roomStatus = ROOM_STATUS.OCCUPIED;
      await room.save();
    }

    reservation.status = RESERVATION_STATUS.CHECKED_IN;
    reservation.checkedInAt = new Date();
    reservation.checkedInBy = req.user._id;
    await reservation.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'CHECK_IN',
      entity: 'Reservation',
      entityId: reservation._id,
      details: { bookingReference: reservation.bookingReference },
      req
    });

    res.json({
      success: true,
      message: `Guest checked in successfully. Room(s) marked occupied.`,
      data: reservation
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Check-Out Workflow
 */
export const checkOutReservation = async (req, res, next) => {
  try {
    const reservation = await Reservation.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    if (reservation.status === RESERVATION_STATUS.CHECKED_OUT) {
      return res.status(400).json({ success: false, message: 'Reservation is already checked out.' });
    }

    // Mark all associated rooms as DIRTY and AVAILABLE
    for (const r of reservation.rooms) {
      const room = await Room.findById(r.roomId);
      if (room) {
        room.roomStatus = ROOM_STATUS.AVAILABLE;
        room.housekeepingStatus = HOUSEKEEPING_STATUS.DIRTY;
        await room.save();
      }
    }

    reservation.status = RESERVATION_STATUS.CHECKED_OUT;
    reservation.checkedOutAt = new Date();
    reservation.checkedOutBy = req.user._id;
    await reservation.save();

    await notifyRoles({
      hotelId: req.hotelId,
      roles: [ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST],
      title: 'Housekeeping Alert',
      message: `Guest checked out from booking ${reservation.bookingReference}. Rooms queued for cleaning.`,
      module: 'housekeeping',
      eventType: 'reservation_checked_out',
      relatedRecordId: reservation._id,
      priority: 'medium',
      link: '/housekeeping',
      eventId: `reservation-checked-out:${reservation._id}`
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'CHECK_OUT',
      entity: 'Reservation',
      entityId: reservation._id,
      details: { bookingReference: reservation.bookingReference, balanceAmount: reservation.balanceAmount },
      req
    });

    res.json({
      success: true,
      message: 'Guest checked out successfully. Rooms queued for housekeeping.',
      data: reservation
    });
  } catch (err) {
    next(err);
  }
};

export const updateReservation = async (req, res, next) => {
  try {
    const {
      checkInDate,
      checkOutDate,
      adultsCount,
      childrenCount,
      specialRequests,
      bookingSource,
      discountAmount
    } = req.body;

    const reservation = await Reservation.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    if (reservation.status === RESERVATION_STATUS.PENDING_APPROVAL && !canManageReservationRequests(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to modify reservation requests.'
      });
    }

    // Block edits on terminal statuses
    if ([RESERVATION_STATUS.CHECKED_OUT, RESERVATION_STATUS.CANCELLED].includes(reservation.status)) {
      return res.status(400).json({
        success: false,
        message: 'Checked-out or cancelled reservations cannot be modified.'
      });
    }

    // If dates are being changed, re-validate availability
    if (checkInDate && checkOutDate) {
      const newStart = dayjs(checkInDate).startOf('day').toDate();
      const newEnd   = dayjs(checkOutDate).startOf('day').toDate();

      if (dayjs(newEnd).diff(dayjs(newStart), 'day') <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Check-out must be at least one day after check-in.'
        });
      }

      const roomIds = reservation.rooms.map(r => r.roomId);

      // Overlap check — exclude this reservation itself
      const overlapping = await Reservation.findOne({
        hotelId: req.hotelId,
        _id: { $ne: reservation._id },
        status: { $in: ACTIVE_RESERVATION_STATUSES },
        'rooms.roomId': { $in: roomIds },
        checkInDate: { $lt: newEnd },
        checkOutDate: { $gt: newStart }
      });

      if (overlapping) {
        return res.status(409).json({
          success: false,
          message: 'The selected dates conflict with an existing reservation for the same room(s).'
        });
      }

      const nights = dayjs(newEnd).diff(dayjs(newStart), 'day');
      let subtotal = 0;
      for (const r of reservation.rooms) {
        const roomType = await RoomType.findById(r.roomTypeId);
        subtotal += (roomType?.basePrice || r.ratePerNight) * nights;
      }

      const disc = discountAmount !== undefined ? Number(discountAmount) : reservation.discountAmount;
      const taxAmount  = Math.round((subtotal - disc) * 0.10 * 100) / 100;
      const totalAmount = Math.round((subtotal - disc + taxAmount) * 100) / 100;
      const balanceAmount = Math.max(0, Math.round((totalAmount - reservation.paidAmount) * 100) / 100);

      reservation.checkInDate   = newStart;
      reservation.checkOutDate  = newEnd;
      reservation.subtotal      = subtotal;
      reservation.discountAmount = disc;
      reservation.taxAmount     = taxAmount;
      reservation.totalAmount   = totalAmount;
      reservation.balanceAmount = balanceAmount;

      // Keep invoice in sync
      const invoice = await Invoice.findOne({ reservationId: reservation._id, hotelId: req.hotelId });
      if (invoice) {
        invoice.subtotal      = subtotal;
        invoice.discountAmount = disc;
        invoice.taxAmount     = taxAmount;
        invoice.totalAmount   = totalAmount;
        invoice.balanceAmount = balanceAmount;
        await invoice.save();
      }
    }

    if (adultsCount    !== undefined) reservation.adultsCount    = adultsCount;
    if (childrenCount  !== undefined) reservation.childrenCount  = childrenCount;
    if (specialRequests !== undefined) reservation.specialRequests = specialRequests;
    if (bookingSource  !== undefined) reservation.bookingSource  = bookingSource;
    await reservation.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_RESERVATION',
      entity: 'Reservation',
      entityId: reservation._id,
      details: { bookingReference: reservation.bookingReference },
      req
    });

    res.json({
      success: true,
      message: 'Reservation updated successfully.',
      data: reservation
    });
  } catch (err) {
    next(err);
  }
};

export const cancelReservation = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const reservation = await Reservation.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    if (reservation.status === RESERVATION_STATUS.PENDING_APPROVAL && !canManageReservationRequests(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to cancel reservation requests.'
      });
    }

    if (reservation.status === RESERVATION_STATUS.CHECKED_IN) {
      return res.status(400).json({ success: false, message: 'Cannot cancel a currently checked-in reservation. Process check-out instead.' });
    }

    reservation.status = RESERVATION_STATUS.CANCELLED;
    reservation.cancellationReason = reason || 'Guest requested cancellation';
    reservation.cancelledAt = new Date();
    await reservation.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'CANCEL_RESERVATION',
      entity: 'Reservation',
      entityId: reservation._id,
      details: { bookingReference: reservation.bookingReference, reason },
      req
    });

    res.json({
      success: true,
      message: 'Reservation cancelled successfully.',
      data: reservation
    });
  } catch (err) {
    next(err);
  }
};
