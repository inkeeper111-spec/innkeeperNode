import { Guest, Reservation, Invoice } from '../models/index.js';

export const getGuests = async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const filter = { hotelId: req.hotelId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Guest.countDocuments(filter);
    const guests = await Guest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: {
        guests,
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

export const createGuest = async (req, res, next) => {
  try {
    const guest = await Guest.create({
      ...req.body,
      hotelId: req.hotelId
    });

    res.status(201).json({
      success: true,
      message: 'Guest profile created successfully.',
      data: guest
    });
  } catch (err) {
    next(err);
  }
};

export const getGuestById = async (req, res, next) => {
  try {
    const guest = await Guest.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!guest) {
      return res.status(404).json({ success: false, message: 'Guest profile not found.' });
    }

    // Fetch guest booking history & invoices
    const reservations = await Reservation.find({ guestId: guest._id, hotelId: req.hotelId })
      .sort({ createdAt: -1 });

    const invoices = await Invoice.find({ guestId: guest._id, hotelId: req.hotelId })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        guest,
        reservations,
        invoices
      }
    });
  } catch (err) {
    next(err);
  }
};

export const updateGuest = async (req, res, next) => {
  try {
    const guest = await Guest.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    );

    if (!guest) {
      return res.status(404).json({ success: false, message: 'Guest profile not found.' });
    }

    res.json({
      success: true,
      message: 'Guest profile updated.',
      data: guest
    });
  } catch (err) {
    next(err);
  }
};

