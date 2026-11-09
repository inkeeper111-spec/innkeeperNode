import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvePurchaseOrder, createStockAdjustment, createStockVerification, getInventoryReport, getReorderSuggestions,
  getStockAdjustments, getStockLocations
} from '../controllers/inventoryAdvancedController.js';
import { getInventoryBatches, receivePurchaseOrderGoods, reviewAutomaticReorder } from '../controllers/inventoryController.js';
import {
  AuditLog, FoodOrder, Hotel, InventoryBalance, InventoryBatch, InventoryItem, PurchaseOrder, RecipeConsumption, Vendor,
  StockAdjustment, StockMovement, StockReceiptRequest, StockVerification
} from '../models/index.js';
import {
  createStockReceiptRequest, recordStockMovement, reviewStockReceiptRequest
} from '../controllers/inventoryController.js';
import { postStockMovement, runInventoryTransaction, transferStock } from '../services/inventoryService.js';
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

const createReorderItem = ({
  currentStock = 0,
  isolatedHotelId = hotelId,
  isolatedPropertyId = propertyId
} = {}) => InventoryItem.create({
  hotelId: isolatedHotelId,
  propertyId: isolatedPropertyId,
  name: `Automatic reorder item ${new mongoose.Types.ObjectId()}`,
  code: new mongoose.Types.ObjectId().toString().slice(-8),
  inventoryType: 'raw_material',
  unit: 'kg',
  baseUnit: 'kg',
  purchaseUnit: 'kg',
  purchaseConversionFactor: 1,
  currentStock,
  minStockThreshold: 5,
  reorderLevel: 5,
  reorderQuantity: 5,
  maxStockLevel: 20,
  unitCost: 2
});

describe('raw material inventory workflow', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('transfers raw-material batches and balance between departments', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await InventoryItem.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      name: `Department transfer item ${new mongoose.Types.ObjectId()}`,
      code: new mongoose.Types.ObjectId().toString().slice(-8),
      unit: 'kg',
      baseUnit: 'kg',
      purchaseUnit: 'kg',
      currentStock: 10,
      minStockThreshold: 0,
      unitCost: 60
    });
    await InventoryBalance.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      location: 'Kitchen Store',
      quantity: 10
    });

    const transfer = await runInventoryTransaction((session) => transferStock({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      quantity: 4,
      unit: 'kg',
      transferMode: 'department',
      fromDepartment: 'Kitchen',
      toDepartment: 'Restaurant',
      recordedBy: actorId,
      referenceNumber: 'DEPARTMENT-TRANSFER-TEST',
      idempotencyKey: 'department-transfer-test',
      session
    }));

    expect(transfer.duplicate).toBe(false);
    expect(await InventoryBalance.findOne({ itemId: item._id, location: 'Kitchen Store' }).then((balance) => balance.quantity)).toBe(6);
    expect(await InventoryBalance.findOne({ itemId: item._id, location: 'Restaurant Store' }).then((balance) => balance.quantity)).toBe(4);
    const movements = await StockMovement.find({ itemId: item._id, referenceNumber: 'DEPARTMENT-TRANSFER-TEST' }).sort({ location: 1 });
    expect(movements).toHaveLength(2);
    expect(movements.map((movement) => movement.department).sort()).toEqual(['Kitchen', 'Restaurant']);
    expect(movements[0]).toMatchObject({
      sourceDepartment: 'Kitchen',
      destinationDepartment: 'Restaurant'
    });
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(10);
  });

  it('lists only below-threshold stock with a purchase quantity suggestion', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const lowItem = await createItem();
    lowItem.hotelId = isolatedHotelId;
    lowItem.propertyId = isolatedPropertyId;
    lowItem.currentStock = 3;
    lowItem.minStockThreshold = 10;
    await lowItem.save();
    const atThresholdItem = await createItem();
    atThresholdItem.hotelId = isolatedHotelId;
    atThresholdItem.propertyId = isolatedPropertyId;
    atThresholdItem.currentStock = 10;
    atThresholdItem.minStockThreshold = 10;
    await atThresholdItem.save();

    const response = await invoke(getReorderSuggestions, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: {}
    });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      _id: lowItem._id,
      availableStock: 3,
      minStockThreshold: 10,
      suggestedQuantity: 7,
      suggestedUnit: 'kg'
    });
  });

    it('creates and updates one pending-review requirement using desired stock without changing inventory', async () => {
      const isolatedHotelId = new mongoose.Types.ObjectId();
      const isolatedPropertyId = new mongoose.Types.ObjectId();
      const item = await createReorderItem({ currentStock: 6, isolatedHotelId, isolatedPropertyId });
      await runInventoryTransaction((session) => postStockMovement({
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'issue',
        quantity: 2,
        unit: 'kg',
        department: 'Kitchen',
        referenceNumber: 'AUTO-REORDER-FIRST-ISSUE',
        session
      }));

      let orders = await PurchaseOrder.find({ autoReorderItemId: item._id });
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        status: 'draft',
        autoGenerated: true,
        vendorId: null
      });
      expect(orders[0].items[0].quantity).toBe(16);
      expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(4);

      await runInventoryTransaction((session) => postStockMovement({
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'issue',
        quantity: 1,
        unit: 'kg',
        department: 'Kitchen',
        referenceNumber: 'AUTO-REORDER-SECOND-ISSUE',
        session
      }));

      orders = await PurchaseOrder.find({ autoReorderItemId: item._id });
      expect(orders).toHaveLength(1);
      expect(orders[0].items[0].quantity).toBe(17);
      expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(3);
    });

    it('cancels an unreviewed reorder requirement when restored stock rises above the threshold', async () => {
      const isolatedHotelId = new mongoose.Types.ObjectId();
      const isolatedPropertyId = new mongoose.Types.ObjectId();
      const item = await createReorderItem({ currentStock: 4, isolatedHotelId, isolatedPropertyId });
      await runInventoryTransaction((session) => postStockMovement({
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'issue',
        quantity: 1,
        unit: 'kg',
        department: 'Kitchen',
        referenceNumber: 'AUTO-REORDER-RESTORE-ISSUE',
        session
      }));
      const requirement = await PurchaseOrder.findOne({ autoReorderItemId: item._id });
      expect(requirement).toBeTruthy();

      await runInventoryTransaction((session) => postStockMovement({
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'return',
        quantity: 3,
        unit: 'kg',
        referenceNumber: 'AUTO-REORDER-RESTORE',
        session
      }));

      const cancelled = await PurchaseOrder.findById(requirement._id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.autoReorderItemId).toBeNull();
      expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(6);
    });

    it('accounts for partial goods receipts and requires supplier review before approval', async () => {
      const isolatedHotelId = new mongoose.Types.ObjectId();
      const isolatedPropertyId = new mongoose.Types.ObjectId();
      const item = await createReorderItem({ currentStock: 4, isolatedHotelId, isolatedPropertyId });
      await runInventoryTransaction((session) => postStockMovement({
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'issue',
        quantity: 0.1,
        unit: 'kg',
        department: 'Kitchen',
        referenceNumber: 'AUTO-REORDER-PARTIAL-ISSUE',
        session
      }));
      const requirement = await PurchaseOrder.findOne({ autoReorderItemId: item._id });
      const vendor = await Vendor.create({
        hotelId: isolatedHotelId,
        name: 'Reorder test supplier',
        phone: '1234567890'
      });
      const req = {
        ...requestFor({ vendorId: String(vendor._id), quantity: requirement.items[0].quantity }),
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        params: { id: String(requirement._id) },
        user: { _id: actorId, role: 'hotel_admin', name: 'Inventory manager' }
      };

      const review = await invoke(reviewAutomaticReorder, req);
      expect(review.statusCode).toBe(200);
      expect(review.body.data.status).toBe('pending_approval');
      const approved = await invoke(approvePurchaseOrder, {
        ...req,
        body: {}
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.body.data.status).toBe('ordered');

      const receipt = await invoke(receivePurchaseOrderGoods, {
        ...req,
        body: {
          items: [{
            itemId: String(item._id),
            receivedQuantity: 5,
            acceptedQuantity: 4,
            damagedQuantity: 1,
            rejectedQuantity: 0
          }]
        }
      });
      expect(receipt.statusCode).toBe(200);
      expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBeCloseTo(7.9);
      const partiallyReceived = await PurchaseOrder.findById(requirement._id);
      expect(partiallyReceived.status).toBe('partially_received');
      expect(partiallyReceived.items[0].receivedQuantity).toBe(5);
      expect(await PurchaseOrder.countDocuments({ autoReorderItemId: item._id })).toBe(0);
      expect(await PurchaseOrder.countDocuments({
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        'items.itemId': item._id,
        status: { $in: ['ordered', 'partially_received'] }
      })).toBe(1);
    });

  it('does not show stock without a recorded batch as a batch entry', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.currentStock = 7;
    await item.save();
    await InventoryBalance.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      location: 'Main Store',
      quantity: 7
    });

    const response = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id), location: 'Main Store' }
    });

    expect(response.body.data).toHaveLength(0);
  });

  it('filters stock locations to the selected inventory item', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    await item.save();
    const otherItem = await createItem();
    otherItem.hotelId = isolatedHotelId;
    otherItem.propertyId = isolatedPropertyId;
    await otherItem.save();
    await InventoryBalance.create([
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        location: 'Restaurant Store',
        quantity: 2
      },
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: otherItem._id,
        location: 'Main Store',
        quantity: 8
      }
    ]);

    const response = await invoke(getStockLocations, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id) }
    });

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      itemId: { _id: item._id },
      location: 'Restaurant Store',
      quantity: 2
    });
  });

  it('classifies recipe consumption as profitable and separately allocates wastage and physical counts', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.currentStock = 3;
    await item.save();
    const batch = await InventoryBatch.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      location: 'Main Store',
      batchNumber: 'BATCH-LEDGER-01',
      quantity: 10,
      remainingQuantity: 3,
      unitCost: 5,
      purchaseQuantity: 10,
      purchaseUnit: 'kg',
      purchaseUnitCost: 5,
      purchaseAmount: 50
    });
    const orderId = new mongoose.Types.ObjectId();
    const menuItemId = new mongoose.Types.ObjectId();
    await FoodOrder.create({
      _id: orderId,
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      orderNumber: `BATCH-PL-${new mongoose.Types.ObjectId()}`,
      items: [{ menuItemId, name: 'Batch dish', quantity: 1, unitPrice: 100, amount: 100 }],
      subtotal: 100,
      discountAmount: 10,
      totalAmount: 90,
      status: 'served',
      paymentStatus: 'paid'
    });
    await StockMovement.create([
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'recipe_consumption',
        quantity: 4,
        location: 'Restaurant Store',
        previousStock: 10,
        newStock: 6,
        totalValue: 20,
        orderId,
        metadata: { recipeSources: [{ menuItemId, quantity: 4 }] },
        batchAllocations: [{ batchId: null, quantity: 4, unitCost: 5, totalCost: 20, source: 'legacy' }]
      },
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'wastage',
        quantity: 2,
        location: 'Main Store',
        previousStock: 6,
        newStock: 4,
        totalValue: 10,
        batchAllocations: [{ batchId: null, quantity: 2, unitCost: 5, totalCost: 10, source: 'legacy' }]
      },
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        movementType: 'physical_count',
        quantity: 1,
        location: 'Main Store',
        previousStock: 4,
        newStock: 3,
        totalValue: 5,
        batchAllocations: [{ batchId: null, quantity: 1, unitCost: 5, totalCost: 5, source: 'legacy' }]
      }
    ]);

    const response = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id) }
    });

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      batchNumber: 'BATCH-LEDGER-01',
      materialName: item.name,
      expectedStock: 10,
      actualUsableStock: 3,
      unrecordedConsumptionQuantity: 0,
      consumedProfitablyQuantity: 4,
      uploadedQuantity: 10,
      consumedQuantity: 0,
      wastageQuantity: 2,
      unrecordedQuantity: 1,
      remainingQuantity: 3,
      salesRevenue: 20,
      loss: 15,
      wastageLoss: 10,
      unrecordedLoss: 5
    });
  });

  it('reconciles verified physical counts against batches at the same stock location', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.unit = 'L';
    item.baseUnit = 'L';
    item.purchaseUnit = 'L';
    await item.save();
    await runInventoryTransaction((session) => postStockMovement({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 7,
      unit: 'L',
      unitCost: 10,
      location: 'Restaurant Store',
      referenceNumber: 'VERIFY-BATCH-RECEIPT',
      session
    }));

    const today = new Date().toISOString().slice(0, 10);
    const verification = await invoke(createStockVerification, {
      ...requestFor({
        itemId: String(item._id),
        location: 'Restaurant Store',
        actualStock: 2,
        unit: 'L',
        periodStart: today,
        periodEnd: today,
        consumptionQuantity: 0.5,
        consumptionUnit: 'L',
        consumptionReason: 'Used',
        wastageQuantity: 0.5,
        wastageUnit: 'L',
        wastageReason: 'Spoiled'
      }),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(verification.body.data.verification.discrepancyQuantity).toBe(4);
    expect(verification.body.data.verification.location).toBe('Restaurant Store');

    const response = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id), location: 'Restaurant Store' }
    });

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      uploadedQuantity: 7,
      consumedQuantity: 0.5,
      wastageQuantity: 0.5,
      consumedProfitablyQuantity: 4,
      unrecordedQuantity: 0,
      salesRevenue: 40,
      loss: 5,
      wastageLoss: 5,
      unrecordedLoss: 0,
      actualUsableStock: 2,
      remainingQuantity: 2
    });
  });

  it('prices profitable consumption as sales revenue and excludes it from batch loss', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.unit = 'kg';
    item.baseUnit = 'kg';
    item.purchaseUnit = 'kg';
    await item.save();
    await runInventoryTransaction((session) => postStockMovement({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 10,
      unit: 'kg',
      unitCost: 1,
      location: 'Main Store',
      referenceNumber: 'PROFITABLE-CONSUMPTION-RECEIPT',
      session
    }));

    const today = new Date().toISOString().slice(0, 10);
    await invoke(createStockVerification, {
      ...requestFor({
        itemId: String(item._id),
        location: 'Main Store',
        actualStock: 0.9,
        unit: 'kg',
        periodStart: today,
        periodEnd: today,
        wastageQuantity: 0.1,
        wastageUnit: 'kg',
        wastageReason: 'Spoiled'
      }),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      user: { _id: actorId, role: 'hotel_admin' }
    });

    const response = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id), location: 'Main Store' }
    });
    const [batch] = response.body.data;

    expect(batch).toMatchObject({
      consumedProfitablyQuantity: 9,
      wastageQuantity: 0.1,
      unrecordedQuantity: 0,
      salesRevenue: 9,
      wastageLoss: 0.1,
      unrecordedLoss: 0,
      loss: 0.1
    });
    expect(batch).not.toHaveProperty('profit');
  });

  it('uses the current balance for batch usable stock after a later receipt and retains fractional base-unit cost', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.unit = 'g';
    item.baseUnit = 'g';
    item.purchaseUnit = 'kg';
    item.purchaseConversionFactor = 1000;
    await item.save();

    await runInventoryTransaction((session) => postStockMovement({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 10,
      unit: 'kg',
      purchaseUnitPrice: 1,
      batchNumber: 'THE_beetroot_B1',
      location: 'Main Store',
      referenceNumber: 'BEETROOT-FIRST-BATCH',
      session
    }));

    const today = new Date().toISOString().slice(0, 10);
    await invoke(createStockVerification, {
      ...requestFor({
        itemId: String(item._id),
        location: 'Main Store',
        actualStock: 500,
        unit: 'g',
        periodStart: today,
        periodEnd: today
      }),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      user: { _id: actorId, role: 'hotel_admin' }
    });

    await runInventoryTransaction((session) => postStockMovement({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 20,
      unit: 'kg',
      purchaseUnitPrice: 2,
      batchNumber: 'THE_beetroot_B2',
      location: 'Main Store',
      referenceNumber: 'BEETROOT-SECOND-BATCH',
      session
    }));

    const response = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id), location: 'Main Store' }
    });
    const secondBatch = response.body.data.find((batch) => batch.batchNumber === 'THE_beetroot_B2');

    expect(secondBatch).toMatchObject({
      quantity: 20000,
      remainingQuantity: 20000,
      actualUsableStock: 20000,
      purchaseUnitCost: 2,
      purchaseAmount: 40
    });
    expect(secondBatch.unitCost).toBe(0.002);
  });

  it('records an authorized stock adjustment immediately and rejects unauthorized changes', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.currentStock = 4;
    await item.save();

    const denied = await invoke(createStockAdjustment, {
      ...requestFor({
        itemId: String(item._id),
        quantity: 1,
        unit: 'kg',
        reason: 'food_wastage'
      }),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId
    });
    expect(denied.statusCode).toBe(403);
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(4);
    expect(await StockAdjustment.countDocuments({ itemId: item._id })).toBe(0);

    const response = await invoke(createStockAdjustment, {
      ...requestFor({
        itemId: String(item._id),
        quantity: 1,
        unit: 'kg',
        reason: 'food_wastage',
        remarks: 'Spoiled'
      }),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      user: { _id: actorId, role: 'hotel_admin' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.status).toBe('approved');
    expect(response.body.data.movementId).toBeTruthy();
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(3);
    expect(await StockMovement.findOne({ itemId: item._id, movementType: 'wastage' })).toBeTruthy();
  });

  it('does not duplicate tracked batch stock or include another location', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    item.currentStock = 7;
    await item.save();
    await InventoryBatch.create([
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        location: 'Main Store',
        batchNumber: 'MAIN-001',
        quantity: 5,
        remainingQuantity: 5,
        unitCost: 60
      },
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        location: 'Kitchen',
        batchNumber: 'KITCHEN-001',
        quantity: 2,
        remainingQuantity: 2,
        unitCost: 60
      }
    ]);
    await InventoryBalance.create([
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        location: 'Main Store',
        quantity: 5
      },
      {
        hotelId: isolatedHotelId,
        propertyId: isolatedPropertyId,
        itemId: item._id,
        location: 'Kitchen',
        quantity: 2
      }
    ]);

    const response = await invoke(getInventoryBatches, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: { itemId: String(item._id), location: 'Main Store' }
    });

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].batchNumber).toBe('MAIN-001');
    expect(response.body.data[0].legacyStock).toBeUndefined();
  });

  it('calculates inventory profit and loss from settled recipe-linked sales and stock losses', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await createItem();
    item.hotelId = isolatedHotelId;
    item.propertyId = isolatedPropertyId;
    await item.save();
    const menuItemId = new mongoose.Types.ObjectId();
    const order = await FoodOrder.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      orderNumber: `PL-${new mongoose.Types.ObjectId()}`,
      items: [{
        menuItemId,
        name: 'Test dish',
        quantity: 2,
        unitPrice: 100,
        amount: 200
      }],
      subtotal: 200,
      taxAmount: 9,
      discountAmount: 20,
      totalAmount: 189,
      status: 'served',
      paymentStatus: 'paid'
    });
    await RecipeConsumption.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      status: 'deducted',
      deductedAt: new Date('2025-01-15T12:00:00.000Z'),
      ingredients: [{
        itemId: item._id,
        menuItemId,
        menuItemName: 'Test dish',
        recipeVersion: 1,
        quantity: 2,
        unit: 'kg',
        unitCost: 30,
        totalCost: 60
      }],
      totalCost: 60
    });
    await StockMovement.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      movementType: 'wastage',
      transactionDate: new Date('2025-01-15T12:00:00.000Z'),
      quantity: 1,
      previousStock: 10,
      newStock: 9,
      unitCost: 10,
      totalValue: 10
    });
    await StockMovement.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      movementType: 'receipt',
      transactionDate: new Date('2025-01-15T12:00:00.000Z'),
      quantity: 10,
      previousStock: 0,
      newStock: 10,
      unitCost: 30,
      totalValue: 300
    });

    const response = await invoke(getInventoryReport, {
      ...requestFor({}),
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      query: {
        type: 'profit-loss',
        from: '2025-01-15',
        to: '2025-01-15'
      }
    });

    expect(response.body.data[0]).toMatchObject({
      salesRevenue: 180,
      costOfGoodsSold: 60,
      grossProfit: 120,
      inventoryLoss: 10,
      totalInventoryExpenses: 70,
      netProfit: 110,
      stockPurchasesNotExpensed: 300,
      settledOrderCount: 1
    });
    expect(response.body.data[0].menuItemBreakdown[0]).toMatchObject({
      menuItemId: String(menuItemId),
      name: 'Test dish',
      quantitySold: 2,
      salesRevenue: 180,
      foodCost: 60,
      grossProfit: 120,
      grossMarginPercent: 66.67
    });
  });

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

  it('returns logged wastage with one batch allocation for each affected batch', async () => {
    const item = await createItem();
    for (const [batchNumber, quantity] of [['BATCH-1', 2], ['BATCH-2', 2]]) {
      await runInventoryTransaction((session) => postStockMovement({
        hotelId,
        propertyId,
        itemId: item._id,
        movementType: 'receipt',
        quantity,
        unit: 'kg',
        batchNumber,
        recordedBy: actorId,
        session
      }));
    }

    const batches = await InventoryBatch.find({ itemId: item._id }).sort({ receivedAt: 1, _id: 1 });
    const { movement } = await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: item._id,
      movementType: 'wastage',
      quantity: 3,
      unit: 'kg',
      batchIds: batches.map((batch) => batch._id),
      notes: 'Spoiled during storage',
      recordedBy: actorId,
      session
    }));

    const response = await invoke(getStockAdjustments, requestFor({}));
    const wastage = response.body.data.find((entry) => String(entry._id) === String(movement._id));

    expect(wastage).toMatchObject({
      recordType: 'wastage',
      movementType: 'wastage',
      itemId: { name: item.name },
      createdAt: movement.createdAt
    });
    expect(wastage.batchAllocations.map((allocation) => ({
      batchNumber: allocation.batchId.batchNumber,
      quantity: allocation.quantity
    }))).toEqual([
      { batchNumber: 'BATCH-1', quantity: 2 },
      { batchNumber: 'BATCH-2', quantity: 1 }
    ]);
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

  it('records direct restock deductions and wastage across existing batches', async () => {
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

    const firstReceipt = await invoke(recordStockMovement, {
      ...requestFor({
        itemId: String(item._id),
        movementType: 'receipt',
        quantity: 2,
        unit: 'kg',
        purchaseUnitPrice: 200,
        autoGenerateBatchNumber: true,
        location: 'Main Store'
      }),
      hotelId: hotel._id,
      user: { _id: actorId, role: 'hotel_admin' }
    });
    expect(firstReceipt.statusCode).toBe(201);
    const firstBatch = await InventoryBatch.findOne({ itemId: item._id });

    const nonAdminReceipt = await invoke(recordStockMovement, {
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
      user: { _id: actorId, role: 'inventory_staff' }
    });
    expect(nonAdminReceipt.statusCode).toBe(403);

    const result = await invoke(recordStockMovement, {
      ...requestFor({
        itemId: String(item._id),
        movementType: 'receipt',
        quantity: 2,
        unit: 'kg',
        purchaseUnitPrice: 220,
        autoGenerateBatchNumber: true,
        existingStockDeductionQuantity: 1,
        existingStockDeductionUnit: 'kg',
        wastageQuantity: 1500,
        wastageUnit: 'g',
        wastageReason: 'Damaged while unpacking',
        location: 'Main Store'
      }),
      hotelId: hotel._id,
      user: { _id: actorId, role: 'hotel_admin' }
    });

    expect(result.statusCode).toBe(201);
    expect(result.body.data.wastageMovement.movementType).toBe('wastage');
    expect(result.body.data.wastageMovement.quantity).toBe(1.5);
    expect(result.body.data.item.currentStock).toBe(1.5);
    expect(result.body.data.deductionMovement.movementType).toBe('issue');
    expect(result.body.data.deductionMovement.quantity).toBe(1);
    const batches = await InventoryBatch.find({ itemId: item._id }).sort({ receivedAt: 1, _id: 1 });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ quantity: 2, remainingQuantity: 0 });
    expect(batches[1]).toMatchObject({ quantity: 2, remainingQuantity: 1.5 });
    expect(result.body.data.wastageMovement.batchAllocations).toMatchObject([
      { batchId: firstBatch._id, quantity: 1 },
      { batchId: batches[1]._id, quantity: 0.5 }
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
    const incorrectStart = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await expect(invoke(createStockVerification, {
      ...requestFor({
      itemId: String(item._id),
      actualStock: 2,
      unit: 'kg',
      periodStart: incorrectStart,
      periodEnd: today,
      consumptionQuantity: 1,
      wastageQuantity: 1
      }),
      user: { _id: actorId, role: 'hotel_admin' }
    })).rejects.toMatchObject({ statusCode: 400 });

    const response = await invoke(createStockVerification, {
      ...requestFor({
      itemId: String(item._id),
      actualStock: 2,
      unit: 'kg',
      periodStart: today,
      periodEnd: today,
      consumptionQuantity: 1000,
      consumptionUnit: 'g',
      consumptionReason: 'Used for staff meals',
      wastageQuantity: 1,
      wastageUnit: 'kg',
      wastageReason: 'Spoiled during storage'
      }),
      user: { _id: actorId, role: 'hotel_admin' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.verification.expectedStock).toBe(7);
    expect(response.body.data.verification.actualStock).toBe(2);
    expect(response.body.data.verification.consumptionQuantity).toBe(1);
    expect(response.body.data.verification.consumptionReason).toBe('Used for staff meals');
    expect(response.body.data.verification.wastageReason).toBe('Spoiled during storage');
    expect(response.body.data.verification.discrepancyQuantity).toBe(3);
    expect(response.body.data.verification.discrepancyReason).toBe('');
    expect(response.body.data.verification.status).toBe('approved');
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(2);
    expect(await StockMovement.findOne({ itemId: item._id, movementType: 'issue' }).then((movement) => movement.notes))
      .toContain('Used for staff meals');
    expect(await StockMovement.findOne({ itemId: item._id, movementType: 'wastage' }).then((movement) => movement.notes))
      .toContain('Spoiled during storage');
    const adjustment = await StockAdjustment.findById(response.body.data.verification.adjustmentId);
    expect(adjustment.status).toBe('approved');
    expect(adjustment.movementId).toBeTruthy();
    expect(await StockVerification.findById(response.body.data.verification._id).then((entry) => entry.status)).toBe('approved');
    expect(await StockMovement.countDocuments({
      itemId: item._id,
      movementType: { $in: ['issue', 'wastage', 'physical_count'] }
    })).toBe(3);
  });

  it('records a stock gain without requiring or storing a reason', async () => {
    const item = await createItem();
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 2,
      unit: 'kg',
      unitCost: 60,
      location: 'Main Store',
      referenceNumber: 'GAIN-WITHOUT-REASON',
      session
    }));
    const today = new Date().toISOString().slice(0, 10);

    const response = await invoke(createStockVerification, {
      ...requestFor({
        itemId: String(item._id),
        actualStock: 3,
        unit: 'kg',
        periodStart: today,
        periodEnd: today
      }),
      user: { _id: actorId, role: 'hotel_admin' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.verification.stockGain).toBe(1);
    expect(response.body.data.verification.discrepancyReason).toBe('');
    expect(await StockVerification.countDocuments({ itemId: item._id })).toBe(1);
  });

  it('allows multiple stock verifications for the same item and date', async () => {
    const item = await createItem();
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: item._id,
      movementType: 'receipt',
      quantity: 2,
      unit: 'kg',
      unitCost: 60,
      location: 'Main Store',
      referenceNumber: 'SAME-DAY-VERIFY-RECEIPT',
      session
    }));
    const today = new Date().toISOString().slice(0, 10);
    const verificationBody = {
      itemId: String(item._id),
      location: 'Main Store',
      actualStock: 2,
      unit: 'kg',
      periodStart: today,
      periodEnd: today
    };

    const first = await invoke(createStockVerification, {
      ...requestFor(verificationBody),
      user: { _id: actorId, role: 'hotel_admin' }
    });
    const second = await invoke(createStockVerification, {
      ...requestFor(verificationBody),
      user: { _id: actorId, role: 'hotel_admin' }
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body.data.verification._id).not.toBe(first.body.data.verification._id);
    expect(await StockVerification.countDocuments({ itemId: item._id, periodEnd: new Date(today) })).toBe(2);
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
