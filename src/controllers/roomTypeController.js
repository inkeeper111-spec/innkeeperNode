import { RoomType, Property } from '../models/index.js';

export const getRoomTypes = async (req, res, next) => {
  try {
    const roomTypes = await RoomType.find({ hotelId: req.hotelId, isActive: true })
      .populate('propertyId', 'name code')
      .sort({ basePrice: 1 });

    res.json({ success: true, data: roomTypes });
  } catch (err) {
    next(err);
  }
};

export const createRoomType = async (req, res, next) => {
  try {
    let propertyId = req.body.propertyId || req.propertyId;
    if (!propertyId) {
      const defaultProp = await Property.findOne({ hotelId: req.hotelId });
      if (defaultProp) propertyId = defaultProp._id;
    }

    const roomType = await RoomType.create({
      ...req.body,
      hotelId: req.hotelId,
      propertyId,
      code: req.body.code.toUpperCase()
    });

    res.status(201).json({
      success: true,
      message: 'Room category created successfully.',
      data: roomType
    });
  } catch (err) {
    next(err);
  }
};

export const getRoomTypeById = async (req, res, next) => {
  try {
    const roomType = await RoomType.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!roomType) {
      return res.status(404).json({ success: false, message: 'Room type not found.' });
    }
    res.json({ success: true, data: roomType });
  } catch (err) {
    next(err);
  }
};

export const updateRoomType = async (req, res, next) => {
  try {
    const roomType = await RoomType.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    );
    if (!roomType) {
      return res.status(404).json({ success: false, message: 'Room type not found.' });
    }
    res.json({ success: true, message: 'Room type updated.', data: roomType });
  } catch (err) {
    next(err);
  }
};

export const deleteRoomType = async (req, res, next) => {
  try {
    const roomType = await RoomType.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { isActive: false },
      { new: true }
    );
    if (!roomType) {
      return res.status(404).json({ success: false, message: 'Room type not found.' });
    }
    res.json({ success: true, message: 'Room type deactivated.' });
  } catch (err) {
    next(err);
  }
};

