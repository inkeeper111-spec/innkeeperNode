import mongoose from 'mongoose';
import { InventoryBatch } from '../models/InventoryBatch.js';
import { InventoryBalance } from '../models/InventoryBalance.js';
import { StorageLocation } from '../models/StorageLocation.js';
import { StorageLocationType } from '../models/StorageLocationType.js';
import { logAudit } from '../services/auditService.js';
import {
  ensureLegacyStorageLocations,
  getStorageLocationStock,
  STORAGE_LOCATION_TYPES
} from '../services/storageLocationService.js';

const isAdmin = (req) => ['hotel_admin', 'super_admin'].includes(req.user?.role);

export const getStorageLocationTypes = async (req, res, next) => {
  try {
    const types = await ensureLegacyStorageLocations(req.hotelId);
    res.json({
      success: true,
      data: types.map((type) => ({
        _id: type._id,
        key: type.key,
        name: type.name
      }))
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A storage location with this name already exists in this hotel.' });
    }
    next(error);
  }
};

export const getStorageLocations = async (req, res, next) => {
  try {
    if (req.query.includeInactive === 'true' && !isAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can view inactive storage locations.' });
    }
    await ensureLegacyStorageLocations(req.hotelId);
    const filter = { hotelId: req.hotelId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (req.query.typeId) {
      if (!mongoose.isValidObjectId(req.query.typeId)) {
        return res.status(400).json({ success: false, message: 'Choose a valid storage location type.' });
      }
      filter.locationTypeId = req.query.typeId;
    }
    if (req.query.search) {
      const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.locationName = { $regex: escaped, $options: 'i' };
    }
    const locations = await StorageLocation.find(filter)
      .populate('locationTypeId', 'key name')
      .sort({ isActive: -1, locationName: 1 })
      .lean();
    res.json({ success: true, data: locations });
  } catch (error) {
    next(error);
  }
};

export const getStorageLocationStockReport = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Storage location not found.' });
    }
    const data = await getStorageLocationStock({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      locationId: req.params.id
    });
    if (!data) return res.status(404).json({ success: false, message: 'Storage location not found.' });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const createStorageLocation = async (req, res, next) => {
  try {
    const locationName = String(req.body.locationName || '').trim();
    const description = String(req.body.description || '').trim();
    const locationTypeId = req.body.locationTypeId;
    if (!locationName || locationName.length > 120) {
      return res.status(400).json({ success: false, message: 'Enter a storage location name (up to 120 characters).' });
    }
    if (!mongoose.isValidObjectId(locationTypeId)) {
      return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
    }
    if (description.length > 500) {
      return res.status(400).json({ success: false, message: 'Description cannot exceed 500 characters.' });
    }
    const type = await StorageLocationType.findOne({
      _id: locationTypeId,
      key: { $in: STORAGE_LOCATION_TYPES.map(({ key }) => key) }
    }).lean();
    if (!type) return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
    const location = await StorageLocation.create({
      hotelId: req.hotelId,
      locationName,
      normalizedName: locationName.toLocaleLowerCase(),
      locationTypeId: type._id,
      description,
      isActive: true
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_STORAGE_LOCATION',
      entity: 'StorageLocation',
      entityId: location._id,
      details: { locationName, locationType: type.name },
      req
    });
    await location.populate('locationTypeId', 'key name');
    res.status(201).json({ success: true, data: location });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A storage location with this name already exists in this hotel.' });
    }
    next(error);
  }
};

export const updateStorageLocation = async (req, res, next) => {
  try {
    const location = await StorageLocation.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!location) return res.status(404).json({ success: false, message: 'Storage location not found.' });
    if (req.body.locationName !== undefined) {
      const locationName = String(req.body.locationName || '').trim();
      if (!locationName || locationName.length > 120) {
        return res.status(400).json({ success: false, message: 'Enter a storage location name (up to 120 characters).' });
      }
      location.locationName = locationName;
      location.normalizedName = locationName.toLocaleLowerCase();
    }
    if (req.body.locationTypeId !== undefined) {
      if (!mongoose.isValidObjectId(req.body.locationTypeId)) {
        return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
      }
      const type = await StorageLocationType.findOne({
        _id: req.body.locationTypeId,
        key: { $in: STORAGE_LOCATION_TYPES.map(({ key }) => key) }
      }).lean();
      if (!type) return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
      location.locationTypeId = type._id;
    }
    if (req.body.description !== undefined) {
      location.description = String(req.body.description || '').trim();
      if (location.description.length > 500) {
        return res.status(400).json({ success: false, message: 'Description cannot exceed 500 characters.' });
      }
    }
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Location status must be active or inactive.' });
      }
      if (!req.body.isActive) {
        const [hasBalance, hasBatch] = await Promise.all([
          InventoryBalance.exists({
            hotelId: req.hotelId, locationId: location._id, quantity: { $gt: 0 }
          }),
          InventoryBatch.exists({
            hotelId: req.hotelId, locationId: location._id, remainingQuantity: { $gt: 0 }
          })
        ]);
        if (hasBalance || hasBatch) {
          return res.status(409).json({
            success: false,
            message: 'This location still contains stock. Transfer or use the stock before deactivating it.'
          });
        }
      }
      location.isActive = req.body.isActive;
    }
    await location.save();
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_STORAGE_LOCATION',
      entity: 'StorageLocation',
      entityId: location._id,
      details: { locationName: location.locationName, isActive: location.isActive },
      req
    });
    await location.populate('locationTypeId', 'key name');
    res.json({ success: true, data: location });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A storage location with this name already exists in this hotel.' });
    }
    next(error);
  }
};
