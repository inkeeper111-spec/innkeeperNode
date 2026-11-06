import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInventoryUnit,
  createDefaultInventoryUnits,
  deleteInventoryUnit,
  getInventoryUnits,
  updateInventoryUnit
} from '../controllers/inventoryUnitController.js';
import { createInventoryItem } from '../controllers/inventoryController.js';
import { InventoryItem, StockMovement, Unit } from '../models/index.js';
import { postStockMovement, runInventoryTransaction } from '../services/inventoryService.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
const otherHotelId = new mongoose.Types.ObjectId();
const propertyId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();
const requestFor = (overrides = {}) => ({
  hotelId,
  propertyId,
  user: { _id: actorId, role: 'hotel_admin' },
  params: {},
  query: {},
  body: {},
  headers: {},
  socket: {},
  ...overrides
});
const response = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});
const invoke = async (controller, req) => {
  const res = response();
  await controller(req, res, (error) => {
    throw error;
  });
  return res;
};

describe('inventory unit management API', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('creates hotel-scoped units and prevents duplicate names or symbols', async () => {
    const created = await invoke(createInventoryUnit, requestFor({
      body: { name: 'Kilogram', symbol: 'kg', category: 'weight' }
    }));
    expect(created.statusCode).toBe(201);
    expect(created.body.data.hotelId.toString()).toBe(hotelId.toString());

    const duplicateName = await invoke(createInventoryUnit, requestFor({
      body: { name: ' kilogram ', symbol: 'kilo', category: 'weight' }
    }));
    expect(duplicateName.statusCode).toBe(409);

    const duplicateSymbol = await invoke(createInventoryUnit, requestFor({
      body: { name: 'Another unit', symbol: 'KG', category: 'weight' }
    }));
    expect(duplicateSymbol.statusCode).toBe(409);

    await Unit.create({
      hotelId: otherHotelId,
      name: 'Kilogram',
      symbol: 'kg',
      category: 'weight',
      createdBy: actorId,
      updatedBy: actorId
    });
    const otherHotelUnits = await invoke(getInventoryUnits, requestFor({ hotelId: otherHotelId }));
    expect(otherHotelUnits.body.data).toHaveLength(1);
  });

  it('lists active units by default and includes inactive units only on request', async () => {
    const unit = await Unit.findOne({ hotelId, symbol: 'kg' });
    const updated = await invoke(updateInventoryUnit, requestFor({
      params: { id: unit._id },
      body: { isActive: false }
    }));
    expect(updated.statusCode).toBe(200);

    const active = await invoke(getInventoryUnits, requestFor());
    expect(active.body.data).toHaveLength(0);

    const all = await invoke(getInventoryUnits, requestFor({ query: { includeInactive: 'true' } }));
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0].isActive).toBe(false);
  });

  it('protects units referenced by an inventory item and provisions recommended units as records', async () => {
    const unit = await Unit.findOne({ hotelId, symbol: 'kg' });
    await InventoryItem.create({
      hotelId,
      propertyId,
      name: 'Test stock',
      code: 'TEST-STOCK',
      unit: 'kg',
      baseUnit: 'kg',
      baseUnitId: unit._id,
      purchaseUnitId: unit._id,
      currentStock: 0,
      minStockThreshold: 0,
      unitCost: 0
    });

    const deleted = await invoke(deleteInventoryUnit, requestFor({ params: { id: unit._id } }));
    expect(deleted.statusCode).toBe(409);

    const defaults = await invoke(createDefaultInventoryUnits, requestFor());
    expect(defaults.statusCode).toBe(201);
    expect(defaults.body.addedCount).toBeGreaterThan(0);
    expect(defaults.body.data.some((entry) => entry.symbol === 'm²')).toBe(true);

    const repeated = await invoke(createDefaultInventoryUnits, requestFor());
    expect(repeated.body.addedCount).toBe(0);
  });

  it('creates item unit references and converts package receipts into base stock', async () => {
    const [gram, bag] = await Unit.create([
      { hotelId, name: 'Gram', symbol: 'g', category: 'weight', createdBy: actorId, updatedBy: actorId },
      { hotelId, name: 'Rice Bag', symbol: 'bag', category: 'quantity', createdBy: actorId, updatedBy: actorId }
    ]);
    const created = await invoke(createInventoryItem, requestFor({
      body: {
        name: 'Rice stock',
        code: 'RICE-STOCK',
        baseUnitId: gram._id,
        purchaseUnitId: bag._id,
        conversionFactor: 25000,
        currentStock: 0,
        minStockThreshold: 0,
        purchasePrice: 500
      }
    }));
    expect(created.statusCode).toBe(201);
    expect(created.body.data.baseUnitId.toString()).toBe(gram._id.toString());
    expect(created.body.data.purchaseUnitId.toString()).toBe(bag._id.toString());
    expect(created.body.data.purchaseConversionFactor).toBe(25000);

    const received = await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: created.body.data._id,
      movementType: 'receipt',
      quantity: 3,
      unit: 'bag',
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));
    expect(received.item.currentStock).toBe(75000);
    expect(received.movement.enteredUnitId.toString()).toBe(bag._id.toString());
    expect(received.movement.conversionFactor).toBe(25000);
    expect(await StockMovement.countDocuments({ itemId: created.body.data._id })).toBe(1);
  });
});
