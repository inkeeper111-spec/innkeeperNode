import { Hotel, Property, Reservation } from '../models/index.js';
import { logAudit } from '../services/auditService.js';
import { combineHotelDateAndTime, dateOnlyFromStoredDate, isValidHotelTime } from '../utils/reservationDates.js';

export const getHotelProfile = async (req, res, next) => {
  try {
    const hotel = await Hotel.findById(req.hotelId).populate('currentPlanId');
    const properties = await Property.find({ hotelId: req.hotelId });

    res.json({
      success: true,
      data: {
        hotel,
        properties
      }
    });
  } catch (err) {
    next(err);
  }
};

export const updateHotelProfile = async (req, res, next) => {
  try {
    const allowedFields = [
      'name', 'phone', 'address', 'city', 'state', 'country', 'postalCode',
      'logo', 'taxNumber', 'currency', 'timezone', 'checkInTime', 'checkOutTime',
      'allowCustomCheckInTime', 'allowCustomCheckOutTime', 'cancellationPolicy', 'invoicePrefix'
    ];

    const updates = {};
    for (const field of allowedFields) {
      const value = req.body[field];
      if (value !== undefined && value !== null) {
        updates[field] = value;
      }
    }

    for (const field of ['checkInTime', 'checkOutTime']) {
      if (updates[field] !== undefined && !isValidHotelTime(updates[field])) {
        return res.status(400).json({
          success: false,
          message: `${field === 'checkInTime' ? 'Check-in' : 'Check-out'} time must use 24-hour HH:mm format.`
        });
      }
    }
    for (const field of ['allowCustomCheckInTime', 'allowCustomCheckOutTime']) {
      if (updates[field] !== undefined && typeof updates[field] !== 'boolean') {
        return res.status(400).json({ success: false, message: `${field} must be true or false.` });
      }
    }
    if (updates.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: updates.timezone }).format(new Date());
      } catch {
        return res.status(400).json({ success: false, message: 'Enter a valid hotel timezone.' });
      }
    }

    if (req.body.attendanceLocation !== undefined) {
      if (
        req.body.attendanceLocation !== null
        && (typeof req.body.attendanceLocation !== 'object' || Array.isArray(req.body.attendanceLocation))
      ) {
        return res.status(400).json({
          success: false,
          message: 'Attendance location must contain latitude and longitude coordinates.'
        });
      }
      const { latitude, longitude } = req.body.attendanceLocation || {};
      const latitudeEmpty = latitude === '' || latitude === null || latitude === undefined;
      const longitudeEmpty = longitude === '' || longitude === null || longitude === undefined;

      if (latitudeEmpty && longitudeEmpty) {
        updates.attendanceLocation = null;
      } else {
        const parsedLatitude = Number(latitude);
        const parsedLongitude = Number(longitude);
        if (
          latitudeEmpty
          || longitudeEmpty
          || !Number.isFinite(parsedLatitude)
          || parsedLatitude < -90
          || parsedLatitude > 90
          || !Number.isFinite(parsedLongitude)
          || parsedLongitude < -180
          || parsedLongitude > 180
        ) {
          return res.status(400).json({
            success: false,
            message: 'Enter valid hotel latitude and longitude coordinates.'
          });
        }

        updates.attendanceLocation = {
          latitude: parsedLatitude,
          longitude: parsedLongitude
        };
      }
    }

    const currentHotel = await Hotel.findById(req.hotelId);
    if (!currentHotel) {
      return res.status(404).json({ success: false, message: 'Hotel organization not found.' });
    }

    const reservationTimingChanged = (
      updates.checkInTime !== undefined && updates.checkInTime !== currentHotel.checkInTime
    ) || (
      updates.checkOutTime !== undefined && updates.checkOutTime !== currentHotel.checkOutTime
    ) || (
      updates.timezone !== undefined && updates.timezone !== currentHotel.timezone
    );
    if (reservationTimingChanged) {
      const reservations = await Reservation.find({
        hotelId: req.hotelId,
        $or: [
          { expectedCheckInAt: null },
          { expectedCheckOutAt: null }
        ]
      }).select('_id checkInDate checkOutDate expectedCheckInAt expectedCheckOutAt expectedCheckInTime expectedCheckOutTime').lean();
      const operations = reservations.map((reservation) => {
        const checkInTime = reservation.expectedCheckInTime || currentHotel.checkInTime || '12:00';
        const checkOutTime = reservation.expectedCheckOutTime || currentHotel.checkOutTime || '11:00';
        const checkInDate = dateOnlyFromStoredDate(reservation.checkInDate);
        const checkOutDate = dateOnlyFromStoredDate(reservation.checkOutDate);
        const expectedCheckInAt = reservation.expectedCheckInAt
          || combineHotelDateAndTime(checkInDate, checkInTime, currentHotel.timezone);
        const expectedCheckOutAt = reservation.expectedCheckOutAt
          || combineHotelDateAndTime(checkOutDate, checkOutTime, currentHotel.timezone);
        return {
          updateOne: {
            filter: { _id: reservation._id, hotelId: req.hotelId },
            update: {
              $set: {
                expectedCheckInTime: checkInTime,
                expectedCheckOutTime: checkOutTime,
                expectedCheckInAt,
                expectedCheckOutAt
              }
            }
          }
        };
      }).filter((operation) => operation.updateOne.update.$set.expectedCheckInAt
        && operation.updateOne.update.$set.expectedCheckOutAt);
      if (operations.length) await Reservation.bulkWrite(operations);
    }

    const hotel = await Hotel.findByIdAndUpdate(req.hotelId, updates, {
      new: true,
      runValidators: true
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_HOTEL_PROFILE',
      entity: 'Hotel',
      entityId: req.hotelId,
      details: updates,
      req
    });

    res.json({
      success: true,
      message: 'Hotel profile updated successfully.',
      data: hotel
    });
  } catch (err) {
    next(err);
  }
};

export const getProperties = async (req, res, next) => {
  try {
    const properties = await Property.find({ hotelId: req.hotelId });
    res.json({ success: true, data: properties });
  } catch (err) {
    next(err);
  }
};

export const createProperty = async (req, res, next) => {
  try {
    const { name, code, address, city, state, country, phone, isMainBranch } = req.body;

    const property = await Property.create({
      hotelId: req.hotelId,
      name,
      code: code.toUpperCase(),
      address,
      city,
      state,
      country,
      phone,
      isMainBranch: Boolean(isMainBranch)
    });

    res.status(201).json({
      success: true,
      message: 'Property created successfully.',
      data: property
    });
  } catch (err) {
    next(err);
  }
};

export const updateProperty = async (req, res, next) => {
  try {
    const property = await Property.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    );

    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found.' });
    }

    res.json({ success: true, data: property });
  } catch (err) {
    next(err);
  }
};
