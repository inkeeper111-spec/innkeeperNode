import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InventoryBalance, InventoryBatch, InventoryItem, StockMovement,
  StorageLocation, StorageLocationType
} from '../models/index.js';
import { ensureLegacyStorageLocations, getStorageLocationStock, resolveStorageLocation } from '../services/storageLocationService.js';
import { runInventoryTransaction, transferStock } from '../services/inventoryService.js';
import { setup, teardown } from './setup.js';

const actorId = new mongoose.Types.ObjectId();

describe('storage location master', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('creates predefined types and backfills legacy location references without changing stock', async () => {
    const hotelId = new mongoose.Types.ObjectId();
    const propertyId = new mongoose.Types.ObjectId();
    const item = await InventoryItem.create({
      hotelId,
      propertyId,
      name: 'Legacy cold storage material',
      code: `LEG-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      unit: 'kg',
      baseUnit: 'kg',
      currentStock: 12,
      location: 'Cold Room - Main Building'
    });
    const batch = await InventoryBatch.create({
      hotelId,
      propertyId,
      itemId: item._id,
      location: 'Cold Room - Main Building',
      batchNumber: 'LEGACY-COLD-1',
      quantity: 12,
      remainingQuantity: 12,
      unitCost: 2
    });
    const balance = await InventoryBalance.create({
      hotelId,
      propertyId,
      itemId: item._id,
      location: 'Cold Room - Main Building',
      quantity: 12
    });

    await ensureLegacyStorageLocations(hotelId);

    const location = await StorageLocation.findOne({ hotelId, normalizedName: 'cold room - main building' })
      .populate('locationTypeId');
    expect(await StorageLocationType.countDocuments({ isSystem: true })).toBe(8);
    expect(location.locationTypeId.key).toBe('cold_storage');
    expect(String((await InventoryItem.findById(item._id)).locationId)).toBe(String(location._id));
    expect(String((await InventoryBatch.findById(batch._id)).locationId)).toBe(String(location._id));
    expect(String((await InventoryBalance.findById(balance._id)).locationId)).toBe(String(location._id));
    expect(await InventoryBalance.findById(balance._id).then((entry) => entry.quantity)).toBe(12);
    expect(await InventoryBatch.findById(batch._id).then((entry) => entry.remainingQuantity)).toBe(12);
  });

  it('rejects location IDs from another hotel or inactive master records', async () => {
    const hotelId = new mongoose.Types.ObjectId();
    const otherHotelId = new mongoose.Types.ObjectId();
    const types = await ensureLegacyStorageLocations(hotelId);
    const mainType = types.find((type) => type.key === 'main_store');
    const location = await StorageLocation.create({
      hotelId: otherHotelId,
      locationName: 'Other hotel store',
      normalizedName: 'other hotel store',
      locationTypeId: mainType._id
    });

    await expect(resolveStorageLocation({
      hotelId,
      locationId: location._id,
      locationName: 'Other hotel store',
      allowCreateLegacy: false
    })).rejects.toThrow('inactive or does not belong to this hotel');

    const inactiveLocation = await StorageLocation.create({
      hotelId,
      locationName: 'Inactive store',
      normalizedName: 'inactive store',
      locationTypeId: mainType._id,
      isActive: false
    });
    await expect(resolveStorageLocation({
      hotelId,
      locationId: inactiveLocation._id,
      allowCreateLegacy: false
    })).rejects.toThrow('inactive or does not belong to this hotel');
  });

  it('transfers stock between distinct master locations and records both location references', async () => {
    const hotelId = new mongoose.Types.ObjectId();
    const propertyId = new mongoose.Types.ObjectId();
    const types = await ensureLegacyStorageLocations(hotelId);
    const mainType = types.find((type) => type.key === 'main_store');
    const kitchenType = types.find((type) => type.key === 'kitchen_store');
    const [sourceLocation, destinationLocation] = await Promise.all([
      StorageLocation.create({
        hotelId, locationName: 'Main Store - Transfer Test',
        normalizedName: 'main store - transfer test', locationTypeId: mainType._id
      }),
      StorageLocation.create({
        hotelId, locationName: 'Kitchen Store - Transfer Test',
        normalizedName: 'kitchen store - transfer test', locationTypeId: kitchenType._id
      })
    ]);
    const item = await InventoryItem.create({
      hotelId,
      propertyId,
      name: 'Transfer test material',
      code: `TR-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      unit: 'kg',
      baseUnit: 'kg',
      currentStock: 10
    });
    await InventoryBalance.create({
      hotelId,
      propertyId,
      itemId: item._id,
      location: sourceLocation.locationName,
      locationId: sourceLocation._id,
      quantity: 10
    });
    const sourceBatch = await InventoryBatch.create({
      hotelId,
      propertyId,
      itemId: item._id,
      location: sourceLocation.locationName,
      locationId: sourceLocation._id,
      batchNumber: 'TRANSFER-SOURCE-1',
      quantity: 10,
      remainingQuantity: 10,
      unitCost: 2
    });
    sourceLocation.locationName = 'Main Store - Renamed Transfer Test';
    sourceLocation.normalizedName = 'main store - renamed transfer test';
    await sourceLocation.save();

    const result = await runInventoryTransaction((session) => transferStock({
      hotelId,
      propertyId,
      itemId: item._id,
      quantity: 3,
      unit: 'kg',
      fromLocationId: sourceLocation._id,
      toLocationId: destinationLocation._id,
      referenceNumber: 'LOCATION-TRANSFER-TEST',
      idempotencyKey: 'location-transfer-test',
      recordedBy: actorId,
      session
    }));

    expect(result.duplicate).toBe(false);
    expect(await InventoryBalance.findOne({ itemId: item._id, locationId: sourceLocation._id }).then((entry) => entry.quantity)).toBe(7);
    expect(await InventoryBalance.findOne({ itemId: item._id, locationId: destinationLocation._id }).then((entry) => entry.quantity)).toBe(3);
    expect(await InventoryBatch.findById(sourceBatch._id).then((entry) => entry.remainingQuantity)).toBe(7);
    expect(await InventoryBatch.findOne({ itemId: item._id, locationId: destinationLocation._id }).then((entry) => entry.remainingQuantity)).toBe(3);
    const movements = await StockMovement.find({
      itemId: item._id,
      referenceNumber: 'LOCATION-TRANSFER-TEST'
    });
    expect(movements).toHaveLength(2);
    expect(movements.map((entry) => String(entry.locationId)).sort()).toEqual(
      [String(sourceLocation._id), String(destinationLocation._id)].sort()
    );
    await expect(runInventoryTransaction((session) => transferStock({
      hotelId,
      propertyId,
      itemId: item._id,
      quantity: 1,
      unit: 'kg',
      fromLocationId: sourceLocation._id,
      toLocationId: sourceLocation._id,
      referenceNumber: 'SAME-LOCATION-TEST',
      idempotencyKey: 'same-location-test',
      recordedBy: actorId,
      session
    }))).rejects.toThrow('different from the source storage location');
  });

  it('returns received, used, and current stock for one storage location', async () => {
    const hotelId = new mongoose.Types.ObjectId();
    const propertyId = new mongoose.Types.ObjectId();
    const otherPropertyId = new mongoose.Types.ObjectId();
    const types = await ensureLegacyStorageLocations(hotelId);
    const mainType = types.find((type) => type.key === 'main_store');
    const location = await StorageLocation.create({
      hotelId,
      locationName: 'Main Store - Stock Report',
      normalizedName: 'main store - stock report',
      locationTypeId: mainType._id
    });
    const rice = await InventoryItem.create({
      hotelId, propertyId, name: 'Rice', code: `RC-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      unit: 'kg', baseUnit: 'kg', currentStock: 8
    });
    await InventoryBatch.create({
      hotelId, propertyId, itemId: rice._id, location: location.locationName, locationId: location._id,
      batchNumber: 'RICE-1', quantity: 10, remainingQuantity: 6, unitCost: 4
    });
    await InventoryBatch.create({
      hotelId, propertyId, itemId: rice._id, location: location.locationName, locationId: location._id,
      batchNumber: 'RICE-2', quantity: 5, remainingQuantity: 2, unitCost: 6
    });
    await InventoryBatch.create({
      hotelId, propertyId: otherPropertyId, itemId: rice._id, location: location.locationName, locationId: location._id,
      batchNumber: 'OTHER-PROPERTY', quantity: 100, remainingQuantity: 100, unitCost: 1
    });

    const report = await getStorageLocationStock({ hotelId, propertyId, locationId: location._id });

    expect(report.locationName).toBe('Main Store - Stock Report');
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      itemName: 'Rice',
      batchCount: 2,
      receivedQuantity: 15,
      usedQuantity: 7,
      currentQuantity: 8,
      unit: 'kg',
      currentValue: 36,
      purchaseValue: 70
    });
    expect(report.currentValue).toBe(36);
    expect(await getStorageLocationStock({
      hotelId, propertyId, locationId: new mongoose.Types.ObjectId()
    })).toBeNull();
  });
});
