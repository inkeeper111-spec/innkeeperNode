import dayjs from 'dayjs';
import { Room, RoomType, Property, Reservation } from '../models/index.js';
import { ROOM_STATUS, HOUSEKEEPING_STATUS, RESERVATION_STATUS } from '../config/constants.js';

export const getRooms = async (req, res, next) => {
  try {
    const { roomStatus, housekeepingStatus, floor, roomTypeId, search } = req.query;
    const filter = { hotelId: req.hotelId, isActive: true };

    if (roomStatus && roomStatus !== 'all') filter.roomStatus = roomStatus;
    if (housekeepingStatus && housekeepingStatus !== 'all') filter.housekeepingStatus = housekeepingStatus;
    if (floor && floor !== 'all') filter.floor = floor;
    if (roomTypeId && roomTypeId !== 'all') filter.roomTypeId = roomTypeId;
    if (search) filter.roomNumber = { $regex: search, $options: 'i' };

    const rooms = await Room.find(filter)
      .populate('roomTypeId', 'name code basePrice maxOccupancy')
      .populate('propertyId', 'name code')
      .sort({ roomNumber: 1 });

    res.json({ success: true, data: rooms });
  } catch (err) {
    next(err);
  }
};

export const createRoom = async (req, res, next) => {
  try {
    const { roomNumber, roomTypeId, floor = '1', notes = '' } = req.body;

    let propertyId = req.body.propertyId || req.propertyId;
    if (!propertyId) {
      const defaultProp = await Property.findOne({ hotelId: req.hotelId });
      if (defaultProp) propertyId = defaultProp._id;
    }

    // Check duplicate room number
    const existing = await Room.findOne({
      hotelId: req.hotelId,
      propertyId,
      roomNumber: roomNumber.trim()
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Room number ${roomNumber} already exists in this property.`
      });
    }

    const room = await Room.create({
      hotelId: req.hotelId,
      propertyId,
      roomNumber: roomNumber.trim(),
      roomTypeId,
      floor,
      roomStatus: ROOM_STATUS.AVAILABLE,
      housekeepingStatus: HOUSEKEEPING_STATUS.CLEAN,
      notes
    });

    const populatedRoom = await Room.findById(room._id).populate('roomTypeId', 'name code basePrice');

    res.status(201).json({
      success: true,
      message: 'Room created successfully.',
      data: populatedRoom
    });
  } catch (err) {
    next(err);
  }
};

export const getRoomById = async (req, res, next) => {
  try {
    const room = await Room.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('roomTypeId')
      .populate('propertyId', 'name code');

    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    res.json({ success: true, data: room });
  } catch (err) {
    next(err);
  }
};

export const updateRoom = async (req, res, next) => {
  try {
    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    ).populate('roomTypeId');

    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    res.json({ success: true, message: 'Room updated.', data: room });
  } catch (err) {
    next(err);
  }
};

export const updateRoomStatus = async (req, res, next) => {
  try {
    const { roomStatus, housekeepingStatus, maintenanceStatus } = req.body;
    const update = {};

    if (roomStatus) update.roomStatus = roomStatus;
    if (housekeepingStatus) update.housekeepingStatus = housekeepingStatus;
    if (maintenanceStatus) update.maintenanceStatus = maintenanceStatus;

    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      update,
      { new: true }
    ).populate('roomTypeId');

    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    res.json({ success: true, message: 'Room status updated.', data: room });
  } catch (err) {
    next(err);
  }
};

/**
 * Check Availability for date range [checkInDate, checkOutDate)
 */
export const checkAvailability = async (req, res, next) => {
  try {
    const { checkInDate, checkOutDate, roomTypeId } = req.query;

    if (!checkInDate || !checkOutDate) {
      return res.status(400).json({
        success: false,
        message: 'Both checkInDate and checkOutDate are required.'
      });
    }

    const start = dayjs(checkInDate).startOf('day').toDate();
    const end = dayjs(checkOutDate).startOf('day').toDate();

    if (dayjs(start).isAfter(end) || dayjs(start).isSame(end)) {
      return res.status(400).json({
        success: false,
        message: 'Check-out date must be after check-in date.'
      });
    }

    // 1. Find all active reservations overlapping the date range
    // Overlap condition: (existingCheckIn < requestedCheckOut) AND (existingCheckOut > requestedCheckIn)
    const overlappingReservations = await Reservation.find({
      hotelId: req.hotelId,
      status: { $in: [RESERVATION_STATUS.PENDING, RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN] },
      checkInDate: { $lt: end },
      checkOutDate: { $gt: start }
    }).select('rooms.roomId');

    const bookedRoomIds = new Set();
    overlappingReservations.forEach(r => {
      r.rooms?.forEach(rm => {
        if (rm.roomId) bookedRoomIds.add(rm.roomId.toString());
      });
    });

    // 2. Query rooms that are active, not out of service, and not booked
    const roomFilter = {
      hotelId: req.hotelId,
      isActive: true,
      roomStatus: { $ne: ROOM_STATUS.OUT_OF_SERVICE },
      _id: { $nin: Array.from(bookedRoomIds) }
    };

    if (roomTypeId && roomTypeId !== 'all') {
      roomFilter.roomTypeId = roomTypeId;
    }

    const availableRooms = await Room.find(roomFilter)
      .populate('roomTypeId')
      .populate('propertyId', 'name code')
      .sort({ roomNumber: 1 });

    res.json({
      success: true,
      data: {
        totalAvailable: availableRooms.length,
        checkInDate: start,
        checkOutDate: end,
        rooms: availableRooms
      }
    });
  } catch (err) {
    next(err);
  }
};

