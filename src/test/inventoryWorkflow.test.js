import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStockVerification, getInventoryReport, reviewStockAdjustment
} from '../controllers/inventoryAdvancedController.js';
import { InventoryBatch, InventoryItem, StockAdjustment, StockMovement, StockVerification } from '../models/index.js';
import { postStockMovement, runInventoryTransaction } from '../services/inventoryService.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
const propertyId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();

const requestFor = (body) => ({
  hotelId,
  propertyId,
  user: { _id: actorId, role: 'inventory_staff' },
  params: {},
  query: {},
  body,
  headers: {},
  socket: {},
  get: () => undefined
});
const reportRequest = (query = {}) => ({
  hotelId,
  propertyId,
  query: { type: 'financial', ...query }
});

const invoke = async (controller, req) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await controller(req, res, (error) => {
    throw error;
  });
  return res;
};

const createItem = () => InventoryItem.create({
  hotelId,
  propertyId,
  name: `Test raw material ${new mongoose.Types.ObjectId()}`,
  code: new mongoose.Types.ObjectId().toString().slice(-8),
  unit: 'kg',
  baseUnit: 'kg',
  purchaseUnit: 'kg',
  currentStock: 0,
  minStockThreshold: 0,
  unitCost: 60
});

describe('raw material inventory workflow', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('allocates reductions FIFO and records the actual batch cost', async () => {
    const item = await createItem();
    await runInventoryTransaction((session) => postStockMovement({
      hotelId, propertyId, itemId: item._id, movementType: 'receipt',
      quantity: 2, unit: 'kg', unitCost: 60, referenceNumber: 'PUR-1',
      batchDetails: {
        purchaseQuantity: 2,
        purchaseUnit: 'kg',
        purchaseUnitCost: 60,
        purchaseAmount: 120,
        invoiceNumber: 'INV-1'
      },
      session
    }));
    await runInventoryTransaction((session) => postStockMovement({
      hotelId, propertyId, itemId: item._id, movementType: 'receipt',
      quantity: 5, unit: 'kg', unitCost: 70, referenceNumber: 'PUR-2', session
    }));

    const result = await runInventoryTransaction((session) => postStockMovement({
      hotelId, propertyId, itemId: item._id, movementType: 'issue',
      quantity: 3, unit: 'kg', recordedBy: actorId, session
    }));

    expect(result.movement.batchAllocations.map((allocation) => allocation.quantity)).toEqual([2, 1]);
    expect(result.movement.batchAllocations.map((allocation) => allocation.unitCost)).toEqual([60, 70]);
    expect(result.movement.totalValue).toBe(190);
    expect(result.item.currentStock).toBe(4);
    const purchasedBatch = await InventoryBatch.findOne({ itemId: item._id, invoiceNumber: 'INV-1' });
    expect(purchasedBatch).toMatchObject({
      quantity: 2,
      remainingQuantity: 0,
      purchaseQuantity: 2,
      purchaseUnit: 'kg',
      purchaseUnitCost: 60,
      purchaseAmount: 120
    });
    const report = await invoke(getInventoryReport, reportRequest());
    expect(report.body.data[0]).toMatchObject({
      totalPurchaseValue: 470,
      totalConsumptionCost: 190,
      closingInventoryValue: 280,
      totalRawMaterialCost: 190
    });
    expect(report.body.data[0].itemBreakdown[0]).toMatchObject({
      purchasedQuantity: 7,
      purchaseValue: 470,
      consumedQuantity: 3,
      consumptionCost: 190
    });
  });

  it('reconciles an unrecorded stock loss once, with separate consumption and wastage movements', async () => {
    const item = await createItem();
    await runInventoryTransaction((session) => postStockMovement({
      hotelId, propertyId, itemId: item._id, movementType: 'receipt',
      quantity: 7, unit: 'kg', unitCost: 60, referenceNumber: 'PUR-3', session
    }));
    const today = new Date().toISOString().slice(0, 10);
    const response = await invoke(createStockVerification, requestFor({
      itemId: String(item._id),
      actualStock: 2,
      unit: 'kg',
      periodStart: today,
      periodEnd: today,
      consumptionQuantity: 1,
      wastageQuantity: 1,
      discrepancyReason: 'Unexplained count difference'
    }));

    expect(response.statusCode).toBe(201);
    expect(response.body.data.verification.expectedStock).toBe(7);
    expect(response.body.data.verification.actualStock).toBe(2);
    expect(response.body.data.verification.discrepancyQuantity).toBe(3);
    expect(response.body.data.verification.status).toBe('pending');
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(5);
    const adjustment = await StockAdjustment.findById(response.body.data.verification.adjustmentId);
    await invoke(reviewStockAdjustment, {
      ...requestFor({ decision: 'approve' }),
      params: { id: String(adjustment._id) },
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(2);
    expect(await StockVerification.findById(response.body.data.verification._id).then((entry) => entry.status)).toBe('approved');
    expect(await StockMovement.countDocuments({
      itemId: item._id,
      movementType: { $in: ['issue', 'wastage', 'physical_count'] }
    })).toBe(3);
    expect(await StockVerification.countDocuments({ itemId: item._id })).toBe(1);
  });

  it('reports period purchases and closing batch value as of the selected end date', async () => {
    const item = await createItem();
    const firstPurchaseDate = new Date('2025-01-10T12:00:00.000Z');
    const laterPurchaseDate = new Date('2025-02-10T12:00:00.000Z');
    await runInventoryTransaction((session) => postStockMovement({
      hotelId, propertyId, itemId: item._id, movementType: 'receipt',
      quantity: 2, unit: 'kg', unitCost: 60, referenceNumber: 'PUR-PERIOD-1',
      transactionDate: firstPurchaseDate, receivedAt: firstPurchaseDate, session
    }));
    await runInventoryTransaction((session) => postStockMovement({
      hotelId, propertyId, itemId: item._id, movementType: 'receipt',
      quantity: 3, unit: 'kg', unitCost: 70, referenceNumber: 'PUR-PERIOD-2',
      transactionDate: laterPurchaseDate, receivedAt: laterPurchaseDate, session
    }));

    const result = await invoke(getInventoryReport, reportRequest({ from: '2025-01-01', to: '2025-01-31' }));
    expect(result.body.data[0]).toMatchObject({
      totalPurchaseValue: 120,
      closingInventoryValue: 120
    });
  });
});
