import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInventoryItem,
  createPurchaseOrder,
  recordStockMovement,
  receivePurchaseOrderGoods
} from '../controllers/inventoryController.js';
import {
  createRawMaterial,
  createRawMaterialCategory,
  createRawMaterialSubcategory,
  getRawMaterials,
  updateRawMaterial,
  getRawMaterialSubcategories
} from '../controllers/rawMaterialController.js';
import { createDefaultInventoryUnits, createInventoryUnit } from '../controllers/inventoryUnitController.js';
import { GoodsReceipt, InventoryItem, PurchaseOrder, StockMovement, Unit, Vendor } from '../models/index.js';
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
  get: () => undefined,
  ...overrides
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

describe('raw material master API', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('creates hotel-scoped categories and filters subcategories by category', async () => {
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Bulb Root Vegetables', description: 'Fresh vegetables' }
    }));
    expect(category.statusCode).toBe(201);
    expect(category.body.data.categoryCode).toMatch(/^BRV\d{3}$/);

    const otherCategory = await invoke(createRawMaterialCategory, requestFor({
      hotelId: otherHotelId,
      body: { name: 'Groceries' }
    }));
    await invoke(createRawMaterialSubcategory, requestFor({
      hotelId: otherHotelId,
      body: { categoryId: String(otherCategory.body.data._id), name: 'Other Subcategory' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(category.body.data._id), name: 'Bulb Vegetables' }
    }));
    expect(subcategory.statusCode).toBe(201);

    const filtered = await invoke(getRawMaterialSubcategories, requestFor({
      query: { categoryId: String(category.body.data._id) }
    }));
    expect(filtered.body.data.map((entry) => entry.name)).toEqual(['Bulb Vegetables']);
    expect(filtered.body.data.some((entry) => String(entry.hotelId) === String(otherCategory.body.data.hotelId))).toBe(false);
  });

  it('validates material-specific package conversions and snapshots purchase conversion history', async () => {
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Raw Vegetables' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(category.body.data._id), name: 'Root Vegetables' }
    }));
    await invoke(createDefaultInventoryUnits, requestFor());
    const units = await Unit.find({ hotelId });
    const unitBySymbol = new Map(units.map((unit) => [unit.symbol, unit]));
    const gram = unitBySymbol.get('g');
    const kilogram = unitBySymbol.get('kg');
    const bag = unitBySymbol.get('bag');
    const millilitre = unitBySymbol.get('ml');
    const piece = unitBySymbol.get('pcs');
    const tray = unitBySymbol.get('tray');
    const carton = unitBySymbol.get('carton');
    expect(gram && kilogram && bag && millilitre && piece && tray && carton).toBeTruthy();

    const customUnit = await invoke(createInventoryUnit, requestFor({
      body: {
        name: 'Scoop',
        symbol: 'scoop',
        category: 'quantity',
        baseUnitId: String(piece._id),
        conversionFactor: 2
      }
    }));
    expect(customUnit.statusCode).toBe(201);
    const invalidCustomUnit = await invoke(createInventoryUnit, requestFor({
      body: {
        name: 'Invalid Scoop',
        symbol: 'invalid-scoop',
        category: 'quantity',
        baseUnitId: String(piece._id),
        conversionFactor: -1
      }
    }));
    expect(invalidCustomUnit.statusCode).toBe(400);

    const countCategory = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Test Count Items' }
    }));
    const countSubcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(countCategory.body.data._id), name: 'Count Units' }
    }));
    const customMaterial = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Eggs',
        categoryId: String(countCategory.body.data._id),
        subcategoryId: String(countSubcategory.body.data._id),
        baseUnitId: String(piece._id),
        supportedUnits: [
          {
            unitId: String(carton._id),
            packageSize: 12,
            packageMeasurementUnitId: String(tray._id)
          },
          {
            unitId: String(tray._id),
            packageSize: 30,
            packageMeasurementUnitId: String(piece._id)
          },
          {
            unitId: String(customUnit.body.data._id),
            conversionFactorToBase: 7,
            isDefaultPurchaseUnit: true
          }
        ]
      }
    }));
    expect(customMaterial.statusCode).toBe(201);
    expect(customMaterial.body.data.supportedUnits.find((entry) => (
      String(entry.unitId) === String(customUnit.body.data._id)
    )).conversionFactorToBase).toBe(2);
    expect(customMaterial.body.data.supportedUnits.find((entry) => (
      String(entry.unitId) === String(carton._id)
    )).conversionFactorToBase).toBe(360);

    const created = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Onion',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        minimumStockLevel: 250,
        reorderLevel: 500,
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 25,
            packageMeasurementUnitId: String(kilogram._id),
            isDefaultPurchaseUnit: true
          },
          {
            unitId: String(bag._id),
            packageName: 'Small Bag',
            packageSize: 5,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(created.statusCode).toBe(201);
    expect(created.body.data.code).toMatch(/^RV\d{3}-0001$/);
    expect(created.body.data).toMatchObject({ minStockThreshold: 250, reorderLevel: 500 });
    expect(created.body.data.supportedUnits.find((entry) => String(entry.unitId) === String(bag._id)))
      .toMatchObject({ packageSize: 25, conversionFactorToBase: 25000 });
    expect(created.body.data.supportedUnits.filter((entry) => String(entry.unitId) === String(bag._id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ packageName: 'Big Bag', conversionFactorToBase: 25000 }),
        expect.objectContaining({ packageName: 'Small Bag', conversionFactorToBase: 5000 })
      ]));
    const duplicatePackageName = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Duplicate Package Name',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(bag._id), packageName: 'Bag', packageSize: 5, packageMeasurementUnitId: String(kilogram._id) },
          { unitId: String(bag._id), packageName: 'Bag', packageSize: 25, packageMeasurementUnitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    expect(duplicatePackageName.statusCode).toBe(400);
    const listed = await invoke(getRawMaterials, requestFor());
    expect(listed.body.data.map((entry) => entry.name)).toContain('Onion');
    const otherProperty = await invoke(getRawMaterials, requestFor({
      propertyId: new mongoose.Types.ObjectId()
    }));
    expect(otherProperty.body.data).toHaveLength(0);
    const missingScope = await invoke(getRawMaterials, requestFor({ propertyId: null }));
    expect(missingScope.statusCode).toBe(400);

    const invalid = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Invalid Onion',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [{
          unitId: String(bag._id),
          packageSize: 1,
          packageMeasurementUnitId: String(millilitre._id)
        }]
      }
    }));
    expect(invalid.statusCode).toBe(400);
    const bypassMaster = await invoke(createInventoryItem, requestFor({
      body: { name: 'Unconfigured', code: 'UNCONFIGURED', inventoryType: 'raw_material' }
    }));
    expect(bypassMaster.statusCode).toBe(400);

    const vendor = await Vendor.create({
      hotelId,
      name: 'Vegetable Supplier',
      phone: '1234567890'
    });
    const purchase = await invoke(createPurchaseOrder, requestFor({
      body: {
        vendorId: String(vendor._id),
        items: [{
          itemId: String(created.body.data._id),
          unitId: String(bag._id),
          unit: 'bag',
          quantity: 2,
          unitCost: 500
        }]
      }
    }));
    expect(purchase.statusCode).toBe(201);
    const purchaseOrder = await PurchaseOrder.findById(purchase.body.data._id);
    expect(purchaseOrder.items[0]).toMatchObject({
      unit: 'bag',
      unitNameSnapshot: 'Big Bag',
      packageNameSnapshot: 'Big Bag',
      baseUnit: 'g',
      baseUnitNameSnapshot: 'Gram',
      conversionFactor: 25000
    });
    const smallBagConfig = created.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag');
    const smallBagPurchase = await invoke(createPurchaseOrder, requestFor({
      body: {
        vendorId: String(vendor._id),
        items: [{
          itemId: String(created.body.data._id),
          unitId: String(bag._id),
          purchasePackageId: String(smallBagConfig._id),
          unit: 'bag',
          quantity: 3,
          unitCost: 100
        }]
      }
    }));
    expect(smallBagPurchase.statusCode).toBe(201);
    expect(smallBagPurchase.body.data.items[0]).toMatchObject({
      purchasePackageId: smallBagConfig._id,
      packageNameSnapshot: 'Small Bag',
      conversionFactor: 5000
    });

    const baseUnitChange = await invoke(updateRawMaterial, requestFor({
      params: { id: String(created.body.data._id) },
      body: {
        baseUnitId: String(kilogram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            _id: created.body.data.supportedUnits.find((entry) => entry.packageName === 'Big Bag')._id,
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 25,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(baseUnitChange.statusCode).toBe(409);

    const updated = await invoke(updateRawMaterial, requestFor({
      params: { id: String(created.body.data._id) },
      body: {
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            _id: created.body.data.supportedUnits.find((entry) => entry.packageName === 'Big Bag')._id,
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 30,
            packageMeasurementUnitId: String(kilogram._id),
            isDefaultPurchaseUnit: true
          },
          {
            _id: created.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag')._id,
            unitId: String(bag._id),
            packageName: 'Small Bag',
            packageSize: 5,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(updated.statusCode).toBe(200);
    expect(updated.body.data.supportedUnits.find((entry) => String(entry.unitId) === String(bag._id)).conversionFactorToBase)
      .toBe(30000);
    expect((await PurchaseOrder.findById(purchaseOrder._id)).items[0].conversionFactor).toBe(25000);

    const received = await invoke(receivePurchaseOrderGoods, requestFor({
      params: { id: String(purchaseOrder._id) },
      body: {
        items: [{
          itemId: String(created.body.data._id),
          receivedQuantity: 2,
          acceptedQuantity: 2
        }]
      }
    }));
    expect(received.statusCode).toBe(200);
    const receipt = await GoodsReceipt.findOne({ purchaseOrderId: purchaseOrder._id });
    expect(receipt.lines[0]).toMatchObject({
      unitNameSnapshot: 'Big Bag',
      packageNameSnapshot: 'Big Bag',
      baseUnitNameSnapshot: 'Gram',
      conversionFactor: 25000
    });
    const stockMovement = await StockMovement.findOne({ itemId: created.body.data._id, movementType: 'receipt' });
    expect(stockMovement.conversionFactor).toBe(25000);
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(50000);
    const reconfigured = await invoke(updateRawMaterial, requestFor({
      params: { id: String(created.body.data._id) },
      body: {
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            _id: updated.body.data.supportedUnits.find((entry) => entry.packageName === 'Big Bag')._id,
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 35,
            packageMeasurementUnitId: String(kilogram._id),
            isDefaultPurchaseUnit: true
          },
          {
            _id: updated.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag')._id,
            unitId: String(bag._id),
            packageName: 'Small Bag',
            packageSize: 5,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(reconfigured.statusCode).toBe(200);
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(50000);
    const smallBag = updated.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag');
    const stockAdded = await invoke(recordStockMovement, requestFor({
      body: {
        itemId: String(created.body.data._id),
        movementType: 'receipt',
        purchasePackageId: String(smallBag._id),
        packageQuantity: 4,
        looseQuantity: 500
      }
    }));
    expect(stockAdded.statusCode).toBe(201);
    const packageMovement = await StockMovement.findOne({
      itemId: created.body.data._id,
      purchasePackageId: smallBag._id
    });
    expect(String(packageMovement.purchasePackageId)).toBe(String(smallBag._id));
    expect(packageMovement).toMatchObject({
      quantity: 20500,
      enteredQuantity: 4,
      enteredUnit: 'Small Bag',
      purchasePackageName: 'Small Bag',
      looseQuantity: 500,
      conversionFactor: 5000
    });
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(70500);
    expect(await InventoryItem.countDocuments({ hotelId, propertyId, inventoryType: 'raw_material' })).toBe(2);
  });
});
