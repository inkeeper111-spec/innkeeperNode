import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStockVerification, getInventoryReport, reviewStockAdjustment
} from '../controllers/inventoryAdvancedController.js';
import { getInventoryBatches } from '../controllers/inventoryController.js';
import {
  AuditLog, Hotel, InventoryBatch, InventoryItem, StockAdjustment, StockMovement,
  StockReceiptRequest, StockVerification
} from '../models/index.js';
import {
  createStockReceiptRequest, recordStockMovement, reviewStockReceiptRequest
} from '../controllers/inventoryController.js';
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

  it('creates automatic hotel-prefixed raw-material batches and converts purchase price to base-unit cost', async () => {
    const hotel = await Hotel.create({
      name: 'Innkeeper Hotel',
      slug: `innkeeper-${new mongoose.Types.ObjectId()}`,
      email: `inventory-${new mongoose.Types.ObjectId()}@example.com`,
      phone: '+15555550123',
      address: '1 Test Street',
      city: 'Test City',
      state: 'Test State',
      postalCode: '12345'
    });
    const item = await InventoryItem.create({
      hotelId: hotel._id,
      propertyId,
      name: 'Onion',
      code: `ONION-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      purchaseUnit: 'kg',
      purchaseConversionFactor: 1000,
      unitConversions: { kg: 1000 },
      currentStock: 0,
      minStockThreshold: 0,
      unitCost: 0
    });

    const result = await runInventoryTransaction((session) => postStockMovement({
      hotelId: hotel._id,
      propertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 5,
      unit: 'kg',
      purchaseUnitPrice: 500,
      autoGenerateBatchNumber: true,
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));

    await runInventoryTransaction((session) => postStockMovement({
      hotelId: hotel._id,
      propertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 2,
      unit: 'kg',
      purchaseUnitPrice: 220,
      autoGenerateBatchNumber: true,
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));
    const reduction = await runInventoryTransaction((session) => postStockMovement({
      hotelId: hotel._id,
      propertyId,
      itemId: item._id,
      movementType: 'issue',
      quantity: 6,
      unit: 'kg',
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));

    const batches = await InventoryBatch.find({ itemId: item._id }).sort({ receivedAt: 1, _id: 1 });
    const batch = batches[0];
    expect(batch.batchNumber).toBe('INN_onion_B1');
    expect(batch.quantity).toBe(5000);
    expect(batch.remainingQuantity).toBe(0);
    expect(batch.unitCost).toBe(0.5);
    expect(batch.purchaseQuantity).toBe(5);
    expect(batch.purchaseUnit).toBe('kg');
    expect(batch.purchaseUnitCost).toBe(500);
    expect(batch.purchaseAmount).toBe(2500);
    expect(batches[1].batchNumber).toBe('INN_onion_B2');
    expect(batches[1].remainingQuantity).toBe(1000);
    expect(reduction.movement.batchAllocations.map((allocation) => allocation.quantity)).toEqual([5000, 1000]);
    expect(result.movement.purchaseUnitPrice).toBe(500);
    expect(result.movement.totalValue).toBe(2500);
    const batchResponse = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: hotel._id,
      query: { itemId: String(item._id) }
    });
    expect(batchResponse.body.data.map(({ batchNumber, status }) => ({ batchNumber, status }))).toEqual([
      { batchNumber: 'INN_onion_B1', status: 'closed' },
      { batchNumber: 'INN_onion_B2', status: 'open' }
    ]);
  });

  it('records previous batch availability and holds restock stock until approval', async () => {
    const hotel = await Hotel.create({
      name: 'Innkeeper Hotel',
      slug: `innkeeper-${new mongoose.Types.ObjectId()}`,
      email: `restock-${new mongoose.Types.ObjectId()}@example.com`,
      phone: '+15555550123',
      address: '1 Test Street',
      city: 'Test City',
      state: 'Test State',
      postalCode: '12345'
    });
    const item = await InventoryItem.create({
      hotelId: hotel._id,
      propertyId,
      name: 'Onion',
      code: `ONION-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      purchaseUnit: 'kg',
      purchaseConversionFactor: 1000,
      unitConversions: { kg: 1000 },
      supportedUnits: [{
        unitId: new mongoose.Types.ObjectId(),
        unitNameSnapshot: 'Kilogram',
        unitSymbolSnapshot: 'kg',
        conversionFactorToBase: 1000
      }],
      currentStock: 0,
      minStockThreshold: 0,
      unitCost: 0
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId: hotel._id,
      propertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 5,
      unit: 'kg',
      purchaseUnitPrice: 500,
      autoGenerateBatchNumber: true,
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));

    const bypassAttempt = await invoke(recordStockMovement, {
      ...requestFor({
        itemId: String(item._id),
        movementType: 'receipt',
        quantity: 1,
        unit: 'kg',
        purchaseUnitPrice: 220,
        autoGenerateBatchNumber: true,
        location: 'Main Store'
      }),
      hotelId: hotel._id,
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(bypassAttempt.statusCode).toBe(409);

    const submitted = await invoke(createStockReceiptRequest, {
      ...requestFor({
        itemId: String(item._id),
        quantity: 2,
        unit: 'kg',
        purchaseUnitPrice: 220,
        existingStockDeduction: 1000,
        location: 'Main Store'
      }),
      hotelId: hotel._id
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.body.data.previousAvailableQuantity).toBe(5000);
    expect(submitted.body.data.existingStockDeduction).toBe(1000);
    expect(submitted.body.data.remainingPreviousStockAfterDeduction).toBe(4000);
    expect(submitted.body.data.previousBatches).toHaveLength(1);
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(5000);
    expect(await InventoryBatch.countDocuments({ itemId: item._id })).toBe(1);

    const receiptRequest = await StockReceiptRequest.findById(submitted.body.data._id);
    const reviewed = await invoke(reviewStockReceiptRequest, {
      ...requestFor({ decision: 'approve' }),
      hotelId: hotel._id,
      params: { id: String(receiptRequest._id) },
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(reviewed.body.data.status).toBe('approved');
    expect(reviewed.body.data.remainingPreviousStockAfterDeduction).toBe(4000);
    expect(reviewed.body.data.deductionMovementId).toBeTruthy();
    expect(reviewed.body.data.movementId).toBeTruthy();
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(6000);
    expect(await InventoryBatch.countDocuments({ itemId: item._id })).toBe(2);
    const previousBatch = await InventoryBatch.findOne({ itemId: item._id, batchNumber: 'INN_onion_B1' });
    expect(previousBatch.remainingQuantity).toBe(4000);
  });

  it('records receipt wastage separately and deducts its quantity FIFO from the permitted batches', async () => {
    const hotel = await Hotel.create({
      name: 'Innkeeper Hotel',
      slug: `restock-wastage-${new mongoose.Types.ObjectId()}`,
      email: `restock-wastage-${new mongoose.Types.ObjectId()}@example.com`,
      phone: '+15555550123',
      address: '1 Test Street',
      city: 'Test City',
      state: 'Test State',
      postalCode: '12345'
    });
    const item = await InventoryItem.create({
      hotelId: hotel._id,
      propertyId,
      name: 'Potato',
      code: `POTATO-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      purchaseUnit: 'kg',
      purchaseConversionFactor: 1000,
      unitConversions: { kg: 1000 },
      supportedUnits: [
        {
          unitId: new mongoose.Types.ObjectId(),
          unitNameSnapshot: 'Gram',
          unitSymbolSnapshot: 'g',
          conversionFactorToBase: 1
        },
        {
          unitId: new mongoose.Types.ObjectId(),
          unitNameSnapshot: 'Kilogram',
          unitSymbolSnapshot: 'kg',
          conversionFactorToBase: 1000
        }
      ],
      currentStock: 0,
      minStockThreshold: 0,
      unitCost: 0
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId: hotel._id,
      propertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 20,
      unit: 'kg',
      purchaseUnitPrice: 500,
      autoGenerateBatchNumber: true,
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));

    const excessiveWastage = await invoke(createStockReceiptRequest, {
      ...requestFor({
        itemId: String(item._id),
        quantity: 10,
        unit: 'kg',
        purchaseUnitPrice: 250,
        wastageQuantity: 11000,
        wastageUnit: 'g',
        wastageReason: 'Spoiled during storage',
        location: 'Main Store'
      }),
      hotelId: hotel._id
    });
    expect(excessiveWastage.statusCode).toBe(400);

    const submitted = await invoke(createStockReceiptRequest, {
      ...requestFor({
        itemId: String(item._id),
        quantity: 10,
        unit: 'kg',
        purchaseUnitPrice: 250,
        existingStockDeductionQuantity: 5,
        existingStockDeductionUnit: 'kg',
        wastageQuantity: 1000,
        wastageUnit: 'g',
        wastageReason: 'Spoiled during storage',
        location: 'Main Store'
      }),
      hotelId: hotel._id
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.body.data.wastageQuantity).toBe(1000);
    expect(submitted.body.data.wastageUnit).toBe('g');
    expect(submitted.body.data.existingStockDeduction).toBe(5000);
    expect(submitted.body.data.existingStockDeductionEnteredQuantity).toBe(5);
    expect(submitted.body.data.existingStockDeductionUnit).toBe('kg');

    const reviewed = await invoke(reviewStockReceiptRequest, {
      ...requestFor({ decision: 'approve' }),
      hotelId: hotel._id,
      params: { id: String(submitted.body.data._id) },
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(reviewed.body.data.status).toBe('approved');
    expect(reviewed.body.data.batchNumber).toBe('INN_potato_B2');
    expect(reviewed.body.data.wastageMovementId).toBeTruthy();
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(24000);

    const batches = await InventoryBatch.find({ itemId: item._id }).sort({ receivedAt: 1, _id: 1 });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ quantity: 20000, remainingQuantity: 14000 });
    expect(batches[1]).toMatchObject({ quantity: 10000, remainingQuantity: 10000 });

    const wastageMovement = await StockMovement.findById(reviewed.body.data.wastageMovementId);
    expect(wastageMovement).toMatchObject({
      movementType: 'wastage',
      quantity: 1000,
      metadata: {
        reason: 'Spoiled during storage',
        source: 'raw_material_receipt',
        batchNumbers: [batches[0].batchNumber]
      }
    });
    expect(wastageMovement.notes).toContain(batches[0].batchNumber);
    expect(wastageMovement.batchAllocations).toMatchObject([
      { batchId: batches[0]._id, quantity: 1000 }
    ]);
    expect(await AuditLog.exists({
      action: 'STOCK_RECEIPT_REQUEST_APPROVE',
      entityId: String(submitted.body.data._id)
    })).toBeTruthy();

    const noDeductionRequest = await invoke(createStockReceiptRequest, {
      ...requestFor({
        itemId: String(item._id),
        quantity: 1,
        unit: 'kg',
        purchaseUnitPrice: 250,
        existingStockDeduction: 0,
        wastageQuantity: 500,
        wastageUnit: 'g',
        wastageReason: 'Damaged during unpacking',
        location: 'Main Store'
      }),
      hotelId: hotel._id
    });
    expect(noDeductionRequest.statusCode).toBe(201);
    const noDeductionApproval = await invoke(reviewStockReceiptRequest, {
      ...requestFor({ decision: 'approve' }),
      hotelId: hotel._id,
      params: { id: String(noDeductionRequest.body.data._id) },
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(noDeductionApproval.body.data.status).toBe('approved');
    expect(noDeductionApproval.body.data.batchNumber).toBe('INN_potato_B3');
    const batchesAfterNoDeduction = await InventoryBatch.find({ itemId: item._id }).sort({ receivedAt: 1, _id: 1 });
    expect(batchesAfterNoDeduction.slice(0, 2).map((batch) => batch.remainingQuantity)).toEqual([14000, 10000]);
    expect(batchesAfterNoDeduction[2]).toMatchObject({ quantity: 1000, remainingQuantity: 500 });
    expect(batchesAfterNoDeduction.map((batch) => batch.batchNumber)).toEqual([
      'INN_potato_B1',
      'INN_potato_B2',
      'INN_potato_B3'
    ]);
  });

  it('records direct receipt wastage against the newly created batch only', async () => {
    const hotel = await Hotel.create({
      name: 'Innkeeper Hotel',
      slug: `direct-wastage-${new mongoose.Types.ObjectId()}`,
      email: `direct-wastage-${new mongoose.Types.ObjectId()}@example.com`,
      phone: '+15555550123',
      address: '1 Test Street',
      city: 'Test City',
      state: 'Test State',
      postalCode: '12345'
    });
    const item = await InventoryItem.create({
      hotelId: hotel._id,
      propertyId,
      name: 'Onion',
      code: `ONION-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'kg',
      baseUnit: 'kg',
      supportedUnits: [
        {
          unitId: new mongoose.Types.ObjectId(),
          unitNameSnapshot: 'Kilogram',
          unitSymbolSnapshot: 'kg',
          conversionFactorToBase: 1
        },
        {
          unitId: new mongoose.Types.ObjectId(),
          unitNameSnapshot: 'Gram',
          unitSymbolSnapshot: 'g',
          conversionFactorToBase: 0.001
        }
      ],
      unitConversions: { g: 0.001 },
      currentStock: 0,
      minStockThreshold: 0,
      unitCost: 0
    });

    const result = await invoke(recordStockMovement, {
      ...requestFor({
        itemId: String(item._id),
        movementType: 'receipt',
        quantity: 2,
        unit: 'kg',
        purchaseUnitPrice: 200,
        autoGenerateBatchNumber: true,
        wastageQuantity: 500,
        wastageUnit: 'g',
        wastageReason: 'Damaged while unpacking',
        location: 'Main Store'
      }),
      hotelId: hotel._id,
      user: { _id: actorId, role: 'hotel_admin' }
    });

    expect(result.statusCode).toBe(201);
    expect(result.body.data.wastageMovement.movementType).toBe('wastage');
    expect(result.body.data.wastageMovement.quantity).toBe(0.5);
    expect(result.body.data.item.currentStock).toBe(1.5);
    const batch = await InventoryBatch.findOne({ itemId: item._id });
    expect(batch).toMatchObject({ quantity: 2, remainingQuantity: 1.5 });
    expect(result.body.data.wastageMovement.batchAllocations).toMatchObject([
      { batchId: batch._id, quantity: 0.5 }
    ]);
    expect(await AuditLog.exists({
      action: 'RECORD_RAW_MATERIAL_WASTAGE',
      entityId: String(result.body.data.wastageMovement._id)
    })).toBeTruthy();
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
