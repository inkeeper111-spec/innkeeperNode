import mongoose from 'mongoose';
import { InventoryBalance } from '../models/InventoryBalance.js';
import { InventoryBatch } from '../models/InventoryBatch.js';
import { InventoryItem } from '../models/InventoryItem.js';
import { InventoryRecipe } from '../models/InventoryRecipe.js';
import { GoodsReceipt } from '../models/GoodsReceipt.js';
import { PreparedFoodMovement } from '../models/PreparedFoodMovement.js';
import { ProductionBatch } from '../models/ProductionBatch.js';
import { StockAdjustment } from '../models/StockAdjustment.js';
import { StockMovement } from '../models/StockMovement.js';
import { StockReceiptRequest } from '../models/StockReceiptRequest.js';
import { StockVerification } from '../models/StockVerification.js';
import { StorageLocation } from '../models/StorageLocation.js';
import { StorageLocationType } from '../models/StorageLocationType.js';

export const STORAGE_LOCATION_TYPES = [
  { key: 'main_store', name: 'Main Store' },
  { key: 'restaurant_store', name: 'Restaurant Store' },
  { key: 'kitchen_store', name: 'Kitchen Store' },
  { key: 'cold_storage', name: 'Cold Storage' },
  { key: 'freezer_storage', name: 'Freezer Storage' },
  { key: 'beverage_store', name: 'Beverage Store' },
  { key: 'dry_store', name: 'Dry Store' },
  { key: 'housekeeping_store', name: 'Housekeeping Store' }
];

const legacyTypeByName = new Map([
  ['main store', 'main_store'],
  ['restaurant store', 'restaurant_store'],
  ['kitchen store', 'kitchen_store'],
  ['cold storage', 'cold_storage'],
  ['freezer storage', 'freezer_storage'],
  ['beverage store', 'beverage_store'],
  ['dry store', 'dry_store'],
  ['housekeeping store', 'housekeeping_store'],
  ['minibar store', 'beverage_store'],
  ['maintenance store', 'dry_store']
]);

const getLegacyTypeKey = (name) => {
  const normalized = String(name).trim().toLowerCase();
  if (legacyTypeByName.has(normalized)) return legacyTypeByName.get(normalized);
  if (normalized.includes('kitchen')) return 'kitchen_store';
  if (normalized.includes('restaurant')) return 'restaurant_store';
  if (normalized.includes('freezer')) return 'freezer_storage';
  if (normalized.includes('cold')) return 'cold_storage';
  if (normalized.includes('beverage') || normalized.includes('minibar')) return 'beverage_store';
  if (normalized.includes('housekeeping')) return 'housekeeping_store';
  return 'dry_store';
};

const locationFields = [
  [InventoryItem, 'location', 'locationId'],
  [InventoryRecipe, 'location', 'locationId'],
  [InventoryBalance, 'location', 'locationId'],
  [InventoryBatch, 'location', 'locationId'],
  [StockMovement, 'location', 'locationId'],
  [StockMovement, 'destinationLocation', 'destinationLocationId'],
  [GoodsReceipt, 'location', 'locationId'],
  [StockReceiptRequest, 'location', 'locationId'],
  [StockVerification, 'location', 'locationId'],
  [StockAdjustment, 'location', 'locationId'],
  [ProductionBatch, 'location', 'locationId'],
  [ProductionBatch, 'rawMaterialLocation', 'rawMaterialLocationId'],
  [PreparedFoodMovement, 'location', 'locationId'],
  [PreparedFoodMovement, 'destinationLocation', 'destinationLocationId']
];

const typeInitializationByKey = new Map();
const legacyMigrationByHotel = new Map();

const ensureLocationTypes = async () => {
  const initializationKey = 'system-storage-location-types';
  if (!typeInitializationByKey.has(initializationKey)) {
    typeInitializationByKey.set(initializationKey, (async () => {
      await Promise.all(STORAGE_LOCATION_TYPES.map(({ key, name }) => (
        StorageLocationType.updateOne(
          { key },
          { $setOnInsert: { key, name, isSystem: true } },
          { upsert: true }
        )
      )));
      return StorageLocationType.find({ key: { $in: STORAGE_LOCATION_TYPES.map(({ key }) => key) } })
        .sort({ name: 1 })
        .lean();
    })().catch((error) => {
      typeInitializationByKey.delete(initializationKey);
      throw error;
    }));
  }
  return typeInitializationByKey.get(initializationKey);
};

const createOrGetLocation = async ({ hotelId, locationName, locationTypeId, isLegacy = false, session }) => {
  const name = String(locationName || '').trim();
  if (!name) return null;
  const normalizedName = name.toLocaleLowerCase();
  try {
    return await StorageLocation.findOneAndUpdate(
      { hotelId, normalizedName },
      {
        $setOnInsert: {
          hotelId,
          locationName: name,
          normalizedName,
          locationTypeId,
          description: isLegacy ? 'Migrated from existing inventory records.' : '',
          isActive: true,
          isLegacy
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    return StorageLocation.findOne({ hotelId, normalizedName }).session(session);
  }
};

export const ensureLegacyStorageLocations = async (hotelId) => {
  if (!mongoose.isValidObjectId(hotelId)) {
    throw Object.assign(new Error('A valid hotel is required to initialize storage locations.'), { statusCode: 400 });
  }
  const migrationKey = String(hotelId);
  if (!legacyMigrationByHotel.has(migrationKey)) {
    legacyMigrationByHotel.set(migrationKey, (async () => {
      const types = await ensureLocationTypes();
      const typeByKey = new Map(types.map((type) => [type.key, type]));
      const distinctByField = await Promise.all(locationFields.map(async ([Model, field, locationIdField]) => {
        const names = await Model.distinct(field, {
          hotelId,
          $and: [
            { [locationIdField]: { $in: [null, undefined] } },
            { [field]: { $type: 'string', $ne: '' } }
          ]
        });
        return names.map((name) => String(name || '').trim()).filter(Boolean);
      }));
      const allNames = distinctByField.flat();
      const names = [...new Set(allNames.map((name) => name.toLocaleLowerCase()))];
      const idsByName = new Map();
      for (const normalizedName of names) {
        const originalName = allNames.find((name) => name.toLocaleLowerCase() === normalizedName);
        const type = typeByKey.get(getLegacyTypeKey(originalName));
        const location = await createOrGetLocation({
          hotelId,
          locationName: originalName,
          locationTypeId: type._id,
          isLegacy: true
        });
        idsByName.set(normalizedName, location._id);
      }

      for (const [Model, field, locationIdField] of locationFields) {
        for (const [normalizedName, locationId] of idsByName) {
          const originalName = allNames.find((name) => name.toLocaleLowerCase() === normalizedName);
          await Model.updateMany({
            hotelId,
            [field]: originalName,
            $or: [{ [locationIdField]: null }, { [locationIdField]: { $exists: false } }]
          }, { $set: { [locationIdField]: locationId } });
        }
      }
      return types;
    })().catch((error) => {
      legacyMigrationByHotel.delete(migrationKey);
      throw error;
    }));
  }
  return legacyMigrationByHotel.get(migrationKey);
};

export const resolveStorageLocation = async ({
  hotelId,
  locationId,
  locationName,
  allowCreateLegacy = true,
  session
}) => {
  if (locationId && !mongoose.isValidObjectId(locationId)) {
    throw Object.assign(new Error('Choose a valid storage location.'), { statusCode: 400 });
  }
  const location = locationId
    ? await StorageLocation.findOne({ _id: locationId, hotelId, isActive: true }).session(session)
    : null;
  if (locationId && !location) {
    throw Object.assign(new Error('The selected storage location is inactive or does not belong to this hotel.'), { statusCode: 400 });
  }
  if (location) return location;
  if (!allowCreateLegacy || !String(locationName || '').trim()) {
    throw Object.assign(new Error('Select an active storage location.'), { statusCode: 400 });
  }
  const existing = await StorageLocation.findOne({
    hotelId,
    normalizedName: String(locationName).trim().toLocaleLowerCase()
  }).session(session);
  if (existing) {
    if (!existing.isActive) {
      throw Object.assign(new Error('The selected storage location is inactive.'), { statusCode: 400 });
    }
    return existing;
  }
  const types = await ensureLocationTypes();
  const type = types.find(({ key }) => key === getLegacyTypeKey(locationName));
  return createOrGetLocation({
    hotelId,
    locationName,
    locationTypeId: type._id,
    isLegacy: true,
    session
  });
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const getStorageLocationStock = async ({ hotelId, propertyId, locationId }) => {
  const location = await StorageLocation.findOne({ _id: locationId, hotelId }).lean();
  if (!location) return null;

  const rows = await InventoryBatch.aggregate([
    {
      $match: {
        hotelId: new mongoose.Types.ObjectId(hotelId),
        propertyId: new mongoose.Types.ObjectId(propertyId),
        locationId: new mongoose.Types.ObjectId(locationId),
        quantity: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: '$itemId',
        receivedQuantity: { $sum: '$quantity' },
        currentQuantity: { $sum: '$remainingQuantity' },
        currentValue: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } },
        purchaseValue: { $sum: { $multiply: ['$quantity', '$unitCost'] } },
        batchCount: { $sum: 1 }
      }
    },
    {
      $lookup: {
        from: InventoryItem.collection.name,
        localField: '_id',
        foreignField: '_id',
        as: 'item'
      }
    },
    { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
    { $sort: { 'item.name': 1 } }
  ]);

  const items = rows.map((row) => {
    const receivedQuantity = Number(row.receivedQuantity) || 0;
    const currentQuantity = Number(row.currentQuantity) || 0;
    const currentValue = roundMoney(row.currentValue);
    const purchaseValue = roundMoney(row.purchaseValue);
    const averageUnitCost = currentQuantity > 0
      ? roundMoney(currentValue / currentQuantity)
      : receivedQuantity > 0
        ? roundMoney(purchaseValue / receivedQuantity)
        : 0;
    return {
      itemId: row._id,
      itemName: row.item?.name || 'Unknown item',
      itemCode: row.item?.code || '',
      batchCount: row.batchCount || 0,
      receivedQuantity,
      usedQuantity: Math.max(0, receivedQuantity - currentQuantity),
      currentQuantity,
      unit: row.item?.baseUnit || row.item?.unit || '',
      averageUnitCost,
      currentValue,
      purchaseValue
    };
  });

  return {
    locationId: location._id,
    locationName: location.locationName,
    items,
    currentValue: roundMoney(items.reduce((sum, item) => sum + item.currentValue, 0)),
    purchaseValue: roundMoney(items.reduce((sum, item) => sum + item.purchaseValue, 0))
  };
};
