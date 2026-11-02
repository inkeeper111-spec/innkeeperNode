import { Hotel, Room, RoomType, Reservation, Guest, Invoice, Property } from '../models/index.js';
import { HOTEL_STATUS, RESERVATION_STATUS, ROOM_STATUS, PAYMENT_STATUS, INVOICE_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { combineHotelDateAndTime, validateReservationDateRange } from '../utils/reservationDates.js';
import { createReservationWithUniqueReference } from '../utils/reservationReference.js';

const serializePublicHotel = (hotel) => ({
  id: hotel._id,
  name: hotel.name,
  slug: hotel.slug,
  email: hotel.email,
  phone: hotel.phone,
  address: hotel.address,
  city: hotel.city,
  state: hotel.state,
  country: hotel.country,
  currency: hotel.currency,
  checkInTime: hotel.checkInTime,
  checkOutTime: hotel.checkOutTime,
  cancellationPolicy: hotel.cancellationPolicy,
  logo: hotel.logo
});

export const listPublicHotels = async (req, res, next) => {
  try {
    const hotels = await Hotel.find({ status: HOTEL_STATUS.ACTIVE })
      .select('name slug city state country currency logo')
      .sort({ createdAt: -1 })
      .lean();

    const withInventory = await Promise.all(
      hotels.map(async (hotel) => {
        const roomCount = await Room.countDocuments({ hotelId: hotel._id, isActive: true });
        return {
          id: hotel._id,
          name: hotel.name,
          slug: hotel.slug,
          city: hotel.city,
          state: hotel.state,
          country: hotel.country,
          currency: hotel.currency,
          logo: hotel.logo,
          roomCount
        };
      })
    );

    withInventory.sort((a, b) => b.roomCount - a.roomCount);

    res.json({ success: true, data: { hotels: withInventory } });
  } catch (err) {
    next(err);
  }
};

export const getPublicHotel = async (req, res, next) => {
  try {
    const { slug } = req.params;
    let hotel;

    if (slug) {
      hotel = await Hotel.findOne({ slug, status: HOTEL_STATUS.ACTIVE });
    } else {
      const activeHotels = await Hotel.find({ status: HOTEL_STATUS.ACTIVE }).sort({ createdAt: -1 });
      hotel = null;
      for (const candidate of activeHotels) {
        const roomCount = await Room.countDocuments({ hotelId: candidate._id, isActive: true });
        if (roomCount > 0) {
          hotel = candidate;
          break;
        }
      }
      if (!hotel) hotel = activeHotels[0] || null;
    }

    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found or currently inactive.' });
    }

    const roomTypes = await RoomType.find({ hotelId: hotel._id, isActive: true });
    const properties = await Property.find({ hotelId: hotel._id });

    res.json({
      success: true,
      data: {
        hotel: serializePublicHotel(hotel),
        properties,
        roomTypes
      }
    });
  } catch (err) {
    next(err);
  }
};

export const searchPublicRooms = async (req, res, next) => {
  try {
    const { hotelId, checkInDate, checkOutDate, adults = 1, children = 0 } = req.query;

    if (!hotelId || !checkInDate || !checkOutDate) {
      return res.status(400).json({ success: false, message: 'Hotel, check-in, and check-out dates are required.' });
    }

    const hotel = await Hotel.findById(hotelId).select('timezone checkInTime checkOutTime');
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }
    const dateRange = validateReservationDateRange(checkInDate, checkOutDate, hotel.timezone);
    if (dateRange.error) {
      return res.status(400).json({ success: false, message: dateRange.error });
    }
    const { start, end, nights } = dateRange;
    const expectedCheckInTime = hotel.checkInTime || '12:00';
    const expectedCheckOutTime = hotel.checkOutTime || '11:00';
    if (
      !combineHotelDateAndTime(checkInDate, expectedCheckInTime, hotel.timezone)
      || !combineHotelDateAndTime(checkOutDate, expectedCheckOutTime, hotel.timezone)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Hotel reservation times are not valid in the configured timezone.'
      });
    }

    // Find active overlapping reservations
    const overlapping = await Reservation.find({
      hotelId,
      status: { $in: [RESERVATION_STATUS.PENDING, RESERVATION_STATUS.PENDING_APPROVAL, RESERVATION_STATUS.APPROVED, RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN] },
      checkInDate: { $lt: end },
      checkOutDate: { $gt: start }
    }).select('rooms.roomId');

    const bookedRoomIds = [];
    overlapping.forEach(r => {
      r.rooms?.forEach(rm => {
        if (rm.roomId) bookedRoomIds.push(rm.roomId);
      });
    });

    const adultsCount = Math.max(1, Number(adults) || 1);

    // Available rooms
    const availableRooms = await Room.find({
      hotelId,
      isActive: true,
      roomStatus: { $ne: ROOM_STATUS.OUT_OF_SERVICE },
      ...(bookedRoomIds.length ? { _id: { $nin: bookedRoomIds } } : {})
    }).populate('roomTypeId');

    // Group available rooms by Room Type
    const roomTypeMap = {};
    availableRooms.forEach(room => {
      if (!room.roomTypeId || room.roomTypeId.isActive === false) return;
      const occupancy = room.roomTypeId.maxOccupancy || room.roomTypeId.adultCapacity || 1;
      if (occupancy < adultsCount) return;
      const typeId = room.roomTypeId._id.toString();
      if (!roomTypeMap[typeId]) {
        roomTypeMap[typeId] = {
          roomType: room.roomTypeId,
          availableCount: 0,
          sampleRooms: []
        };
      }
      roomTypeMap[typeId].availableCount++;
      roomTypeMap[typeId].sampleRooms.push({
        id: room._id,
        roomNumber: room.roomNumber,
        floor: room.floor
      });
    });

    res.json({
      success: true,
      data: {
        checkInDate: start,
        checkOutDate: end,
        nights,
        categories: Object.values(roomTypeMap)
      }
    });
  } catch (err) {
    next(err);
  }
};

export const bookPublicReservation = async (req, res, next) => {
  try {
    const {
      hotelId,
      guestName,
      guestEmail,
      guestPhone,
      checkInDate,
      checkOutDate,
      roomTypeId,
      adultsCount = 1,
      childrenCount = 0,
      specialRequests = ''
    } = req.body;

    const hotel = await Hotel.findById(hotelId).select('name timezone checkInTime checkOutTime');
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }
    const dateRange = validateReservationDateRange(checkInDate, checkOutDate, hotel.timezone);
    if (dateRange.error) {
      return res.status(400).json({ success: false, message: dateRange.error });
    }
    const { start, end, nights } = dateRange;
    const expectedCheckInTime = hotel.checkInTime || '12:00';
    const expectedCheckOutTime = hotel.checkOutTime || '11:00';
    const expectedCheckInAt = combineHotelDateAndTime(checkInDate, expectedCheckInTime, hotel.timezone);
    const expectedCheckOutAt = combineHotelDateAndTime(checkOutDate, expectedCheckOutTime, hotel.timezone);
    if (!expectedCheckInAt || !expectedCheckOutAt) {
      return res.status(400).json({
        success: false,
        message: 'Hotel reservation times are not valid in the configured timezone.'
      });
    }

    const roomType = await RoomType.findOne({ _id: roomTypeId, hotelId });
    if (!roomType) {
      return res.status(404).json({ success: false, message: 'Room type not found.' });
    }

    // Find an available room of this type
    const overlapping = await Reservation.find({
      hotelId,
      status: { $in: [RESERVATION_STATUS.PENDING, RESERVATION_STATUS.PENDING_APPROVAL, RESERVATION_STATUS.APPROVED, RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN] },
      checkInDate: { $lt: end },
      checkOutDate: { $gt: start }
    }).select('rooms.roomId');

    const bookedIds = overlapping.flatMap(o => o.rooms?.map(r => r.roomId) || []);

    const assignedRoom = await Room.findOne({
      hotelId,
      roomTypeId: roomType._id,
      isActive: true,
      roomStatus: { $ne: ROOM_STATUS.OUT_OF_SERVICE },
      _id: { $nin: bookedIds }
    });

    if (!assignedRoom) {
      return res.status(409).json({ success: false, message: 'No rooms of this category are available for the selected dates.' });
    }

    // Guest lookup or creation
    let guest = await Guest.findOne({ hotelId, email: guestEmail.toLowerCase() });
    if (!guest) {
      guest = await Guest.create({
        hotelId,
        name: guestName,
        email: guestEmail.toLowerCase(),
        phone: guestPhone
      });
    }

    const subtotal = roomType.basePrice * nights;
    const taxAmount = Math.round(subtotal * 0.10 * 100) / 100;
    const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

    const reservation = await createReservationWithUniqueReference(Reservation, {
      hotelId,
      propertyId: assignedRoom.propertyId,
      guestId: guest._id,
      guestName,
      guestEmail: guest.email,
      guestPhone,
      checkInDate: start,
      checkOutDate: end,
      expectedCheckInTime,
      expectedCheckOutTime,
      expectedCheckInAt,
      expectedCheckOutAt,
      rooms: [{
        roomId: assignedRoom._id,
        roomTypeId: roomType._id,
        roomNumber: assignedRoom.roomNumber,
        ratePerNight: roomType.basePrice
      }],
      adultsCount,
      childrenCount,
      bookingSource: 'online',
      status: RESERVATION_STATUS.PENDING_APPROVAL,
      paymentStatus: PAYMENT_STATUS.UNPAID,
      subtotal,
      taxAmount,
      totalAmount,
      paidAmount: 0,
      balanceAmount: totalAmount,
      specialRequests
    }, hotel);
    const { bookingReference } = reservation;

    // Create Invoice
    const invoiceNumber = generateReference('INV');
    const invoice = await Invoice.create({
      hotelId,
      propertyId: assignedRoom.propertyId,
      invoiceNumber,
      reservationId: reservation._id,
      guestId: guest._id,
      items: [{
        description: `${roomType.name} - ${nights} Night(s)`,
        quantity: nights,
        unitPrice: roomType.basePrice,
        amount: subtotal,
        itemType: 'room'
      }],
      subtotal,
      taxAmount,
      totalAmount,
      paidAmount: 0,
      balanceAmount: totalAmount,
      status: INVOICE_STATUS.ISSUED
    });

    res.status(201).json({
      success: true,
      message: 'Reservation request submitted successfully. It is awaiting approval from the hotel team.',
      data: {
        bookingReference,
        reservation,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};

export const lookupPublicReservation = async (req, res, next) => {
  try {
    const { reference, email } = req.query;
    if (!reference || !email) {
      return res.status(400).json({ success: false, message: 'Booking reference and email required.' });
    }

    const reservation = await Reservation.findOne({
      bookingReference: reference.trim().toUpperCase(),
      guestEmail: email.trim().toLowerCase()
    })
      .populate('hotelId', 'name phone email address city currency')
      .populate('rooms.roomTypeId');

    if (!reservation) {
      return res.status(404).json({ success: false, message: 'Reservation not found.' });
    }

    const invoice = await Invoice.findOne({ reservationId: reservation._id });

    res.json({
      success: true,
      data: {
        reservation,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};
