import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInventoryReport, getRecipes, saveRecipe, setRecipeStatus } from '../controllers/inventoryAdvancedController.js';
import { getInventoryBatches } from '../controllers/inventoryController.js';
import { createOrder, getMenu, settleOrder, updateOrderStatus } from '../controllers/restaurantController.js';
import {
  cancelProductionEntry, createProductionEntry, getProductionDashboard, transferProductionBatch
} from '../controllers/productionController.js';
import {
  FoodOrder, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, InventorySettings,
  MenuCategory, MenuItem, PreparedFoodMovement, ProductionBatch, Property, RecipeConsumption, StockMovement
} from '../models/index.js';
import {
  consumePreparedFoodForOrder, consumeRecipesForOrder, postStockMovement, recordPreparedFoodUse, runInventoryTransaction
} from '../services/inventoryService.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
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
  let error;
  await controller(req, res, (caught) => { error = caught; });
  return { ...res, error };
};

describe('recipe-based inventory management', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('deducts recipe ingredients at the configured stage, uses FEFO batches, and reverses cancellation', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Recipe Test Property',
      code: `RCP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Test Recipes' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Recipe Test Dish',
      price: 5
    });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Recipe Test Ingredient',
      code: `RTI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0,
      unitCost: 0.01,
      trackExpiry: true
    });
    const firstExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const secondExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    for (const [expiryDate, batchNumber, quantity] of [
      [firstExpiry, 'FEFO-1', 100],
      [secondExpiry, 'FEFO-2', 500]
    ]) {
      await runInventoryTransaction((session) => postStockMovement({
        hotelId,
        propertyId: property._id,
        itemId: ingredient._id,
        movementType: 'receipt',
        quantity,
        unit: 'g',
        unitCost: 0.01,
        location: 'Restaurant Store',
        expiryDate,
        batchNumber,
        recordedBy: actorId,
        session
      }));
    }

    const recipeResponse = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(menuItem._id),
        recipeName: 'Test Dish Recipe',
        description: 'One serving',
        servingSize: '1 plate',
        preparationTimeMinutes: 12,
        ingredients: [{ itemId: String(ingredient._id), quantity: 33, unit: 'g' }]
      }
    }));
    expect(recipeResponse.statusCode).toBe(201);
    const recipeId = recipeResponse.body.data._id;

    const recipes = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    expect(recipes.body.data[0]).toMatchObject({
      recipeName: 'Test Dish Recipe',
      servingSize: '1 plate',
      preparationTimeMinutes: 12,
      estimatedRecipeCost: 0.33,
      totalRecipeCost: 0.33,
      sellingPrice: 5,
      estimatedGrossProfit: 4.67,
      estimatedProfitWhole: 4.67,
      expectedProductionYield: 1,
      expectedPreparationLossQuantity: 0,
      expectedUsableQuantity: 1,
      expectedPreparationLossPercent: 0,
      foodCostPercent: 6.6
    });

    const bulkMenuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Bulk Recipe Test Dish',
      price: 5
    });
    const bulkRecipeResponse = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(bulkMenuItem._id),
        recipeName: 'Bulk Dish Recipe',
        servingSize: '3 plates',
        productionMode: 'batch_production',
        expectedProductionYield: 3,
        expectedPreparationLossPercent: 10,
        ingredients: [{ itemId: String(ingredient._id), quantity: 33, unit: 'g' }]
      }
    }));
    expect(bulkRecipeResponse.statusCode).toBe(201);
    const recipesWithBulk = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const bulkRecipe = recipesWithBulk.body.data.find(
      (recipe) => String(recipe._id) === String(bulkRecipeResponse.body.data._id)
    );
    expect(bulkRecipe).toMatchObject({
      estimatedRecipeCost: 0.12,
      totalRecipeCost: 0.33,
      sellingPrice: 5,
      expectedProductionYield: 3,
      expectedPreparationLossQuantity: 0.3,
      expectedUsableQuantity: 2.7,
      expectedPreparationLossPercent: 10,
      estimatedGrossProfit: 4.88,
      estimatedProfitWhole: 13.17
    });

    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `RCP-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 6, unitPrice: 5, amount: 30 }],
      subtotal: 30,
      totalAmount: 30,
      status: 'preparing',
      createdBy: actorId
    });
    const prepared = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(prepared.error).toBeUndefined();
    expect(prepared.body.data.status).toBe('ready');

    const movement = await StockMovement.findOne({ orderId: order._id, movementType: 'recipe_consumption' });
    expect(movement.quantity).toBe(198);
    expect(movement.batchAllocations.map((allocation) => String(allocation.batchId))).toEqual(
      (await InventoryBatch.find({ itemId: ingredient._id }).sort({ expiryDate: 1 })).map((batch) => String(batch._id))
    );
    expect((await InventoryBalance.findOne({ itemId: ingredient._id, location: 'Restaurant Store' })).quantity).toBe(402);
    const batchLedger = await invoke(getInventoryBatches, requestFor({
      propertyId: property._id,
      query: { itemId: String(ingredient._id), location: 'Restaurant Store' }
    }));
    expect(batchLedger.body.data.reduce((sum, batch) => sum + batch.consumedProfitablyQuantity, 0)).toBe(198);
    expect(batchLedger.body.data.reduce((sum, batch) => sum + batch.unrecordedConsumptionQuantity, 0)).toBe(0);
    expect(batchLedger.body.data.reduce((sum, batch) => sum + batch.salesRevenue, 0)).toBe(1.98);

    await runInventoryTransaction((session) => consumeRecipesForOrder(order, session));
    expect(await StockMovement.countDocuments({ orderId: order._id, movementType: 'recipe_consumption' })).toBe(1);
    const usage = await invoke(getInventoryReport, requestFor({
      propertyId: property._id,
      query: { type: 'recipe-usage' }
    }));
    expect(usage.body.data).toHaveLength(1);
    expect(usage.body.data[0]).toMatchObject({ itemName: ingredient.name, quantity: 198, menuItemName: menuItem.name });
    const monthlyUsage = await invoke(getInventoryReport, requestFor({
      propertyId: property._id,
      query: { type: 'recipe-monthly-usage' }
    }));
    expect(monthlyUsage.body.data).toHaveLength(1);
    expect(monthlyUsage.body.data[0].month).toMatch(/^\d{4}-\d{2}$/);

    const cancelled = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status: 'cancelled' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(cancelled.error).toBeUndefined();
    expect((await RecipeConsumption.findOne({ orderId: order._id })).status).toBe('reversed');
    expect((await InventoryBalance.findOne({ itemId: ingredient._id, location: 'Restaurant Store' })).quantity).toBe(600);
    expect(await StockMovement.countDocuments({ orderId: order._id, movementType: 'sale_reversal' })).toBe(1);
    const reversedBatchLedger = await invoke(getInventoryBatches, requestFor({
      propertyId: property._id,
      query: { itemId: String(ingredient._id), location: 'Restaurant Store' }
    }));
    expect(reversedBatchLedger.body.data.reduce((sum, batch) => sum + batch.consumedProfitablyQuantity, 0)).toBe(0);
    expect(reversedBatchLedger.body.data.reduce((sum, batch) => sum + batch.salesRevenue, 0)).toBe(0);
    expect(reversedBatchLedger.body.data.reduce((sum, batch) => sum + batch.remainingQuantity, 0)).toBe(600);

    const recipeFreeMenuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Recipe-free Test Dish',
      price: 4
    });
    const recipeFreeOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `RF-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: recipeFreeMenuItem._id, name: recipeFreeMenuItem.name, quantity: 1, unitPrice: 4, amount: 4 }],
      subtotal: 4,
      totalAmount: 4,
      status: 'preparing',
      createdBy: actorId
    });
    const recipeFreeStatus = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(recipeFreeOrder._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(recipeFreeStatus.error).toBeUndefined();
    expect(recipeFreeStatus.body.data.status).toBe('ready');
    expect(await RecipeConsumption.countDocuments({ orderId: recipeFreeOrder._id })).toBe(0);

    await invoke(setRecipeStatus, requestFor({
      propertyId: property._id,
      params: { id: String(recipeId) },
      body: { isActive: false }
    }));
    expect(await InventoryRecipe.findById(recipeId).then((recipe) => recipe.isActive)).toBe(false);
  });

  it('leaves the kitchen order unchanged when recipe stock is insufficient', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Insufficient Recipe Property',
      code: `IRP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Insufficient Recipes' });
    const menuItem = await MenuItem.create({ hotelId, categoryId: category._id, name: 'Unavailable Dish', price: 10 });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Unavailable Ingredient',
      code: `UI${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0
    });
    await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      version: 1,
      ingredients: [{ itemId: ingredient._id, quantity: 10, unit: 'g', conversionFactor: 1, baseUnit: 'g' }],
      createdBy: actorId
    });
    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `IRP-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 1, unitPrice: 10, amount: 10 }],
      subtotal: 10,
      totalAmount: 10,
      status: 'preparing',
      createdBy: actorId
    });

    const result = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(result.error?.statusCode).toBe(409);
    expect((await FoodOrder.findById(order._id)).status).toBe('preparing');
    expect(await RecipeConsumption.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('uses the served deduction stage when configured and does not affect orders without recipes', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Served Stage Property',
      code: `SSP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    await InventorySettings.create({
      hotelId,
      propertyId: property._id,
      verificationIntervalDays: 1,
      recipeDeductionStage: 'served',
      updatedBy: actorId
    });
    const category = await MenuCategory.create({ hotelId, name: 'Served Stage Recipes' });
    const menuItem = await MenuItem.create({ hotelId, categoryId: category._id, name: 'Served Dish', price: 8 });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Served Ingredient',
      code: `SI${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId: property._id,
      itemId: ingredient._id,
      movementType: 'receipt',
      quantity: 100,
      unit: 'g',
      location: 'Restaurant Store',
      recordedBy: actorId,
      session
    }));
    await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      version: 1,
      ingredients: [{ itemId: ingredient._id, quantity: 20, unit: 'g', conversionFactor: 1, baseUnit: 'g' }],
      createdBy: actorId
    });
    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `SSP-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 1, unitPrice: 8, amount: 8 }],
      subtotal: 8,
      totalAmount: 8,
      status: 'preparing',
      createdBy: actorId
    });
    const restaurantRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, restaurantRequest('ready'));
    expect(await RecipeConsumption.countDocuments({ orderId: order._id })).toBe(0);
    await invoke(updateOrderStatus, restaurantRequest('served'));
    expect(await RecipeConsumption.countDocuments({ orderId: order._id, status: 'deducted' })).toBe(1);

    const recipeFreeOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `NRC-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Recipe-free item', quantity: 1, unitPrice: 3, amount: 3 }],
      subtotal: 3,
      totalAmount: 3,
      status: 'preparing',
      createdBy: actorId
    });
    const noRecipeResult = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(recipeFreeOrder._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(noRecipeResult.error).toBeUndefined();
    expect(noRecipeResult.body.data.status).toBe('ready');
    expect(await RecipeConsumption.countDocuments({ orderId: recipeFreeOrder._id })).toBe(0);
  });

  it('records batch production once, allocates prepared portions at serving, and keeps wastage separate', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Production Test Property',
      code: `PRD${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Production Recipes' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Batch Production Dish',
      price: 12
    });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Production Ingredient',
      code: `PRI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0,
      trackExpiry: true
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId: property._id,
      itemId: ingredient._id,
      movementType: 'receipt',
      quantity: 1000,
      unit: 'g',
      unitCost: 0.02,
      location: 'Main Store',
      expiryDate: new Date(Date.now() + 30 * 86400000),
      batchNumber: 'PRODUCTION-INGREDIENT-1',
      recordedBy: actorId,
      session
    }));
    const recipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      recipeName: 'Production Dish Recipe',
      productionMode: 'batch_production',
      version: 1,
      ingredients: [{ itemId: ingredient._id, quantity: 10, unit: 'g', conversionFactor: 1, baseUnit: 'g' }],
      createdBy: actorId
    });
    const productionInput = {
      hotelId,
      propertyId: property._id,
      recipeId: recipe._id,
      productionQuantity: 20,
      acceptedQuantity: 18,
      productionMethod: 'recipe_based',
      location: 'Kitchen Store',
      rawMaterialLocation: 'Main Store',
      wastage: [{ itemId: String(ingredient._id), quantity: 5, unit: 'g', reason: 'Trimming' }],
      recordedBy: actorId,
      idempotencyKey: `production-test:${new mongoose.Types.ObjectId()}`
    };
    const productionResponse = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: productionInput
    }));
    expect(productionResponse.statusCode).toBe(201);
    const production = productionResponse.body.data;
    expect(production.duplicate).toBe(false);
    expect(production.batch.acceptedQuantity).toBe(18);
    expect(production.batch.productionCost).toBe(4);
    expect(production.batch.rawMaterialWastageCost).toBe(0.1);
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(795);

    const retry = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: productionInput
    }));
    expect(retry.statusCode).toBe(200);
    expect(retry.body.data.duplicate).toBe(true);
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(795);

    const secondProductionResponse = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        ...productionInput,
        productionQuantity: 3,
        acceptedQuantity: 3,
        wastage: [],
        expiryDate: new Date(Date.now() + 86400000),
        idempotencyKey: `production-test:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(secondProductionResponse.statusCode).toBe(201);
    const secondProduction = secondProductionResponse.body.data;
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(765);

    const menuResponse = await invoke(getMenu, requestFor({
      propertyId: property._id,
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    const bulkMenuProduct = menuResponse.body.data.items.find(
      (item) => String(item._id) === String(menuItem._id)
    );
    expect(bulkMenuProduct).toMatchObject({
      fulfillmentSource: 'batch_production',
      availablePreparedPortions: 21
    });

    const bulkOrderResponse = await invoke(createOrder, requestFor({
      propertyId: property._id,
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id },
      body: {
        orderType: 'takeaway',
        items: [{ menuItemId: String(menuItem._id), quantity: 2 }]
      }
    }));
    expect(bulkOrderResponse.statusCode).toBe(201);
    expect(bulkOrderResponse.body.data.items[0].fulfillmentSource).toBe('batch_production');
    expect(bulkOrderResponse.body.data.preparedFoodAllocations).toHaveLength(1);
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).availableQuantity).toBe(19);
    expect((await ProductionBatch.findById(production.batch._id)).reservedQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).reservedQuantity).toBe(2);
    expect((await ProductionBatch.findById(production.batch._id)).soldQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).soldQuantity).toBe(0);
    const cancelBulkOrder = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(bulkOrderResponse.body.data._id) },
      body: { status: 'cancelled' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(cancelBulkOrder.error).toBeUndefined();
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).availableQuantity).toBe(21);
    expect((await ProductionBatch.findById(production.batch._id)).reservedQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).reservedQuantity).toBe(0);

    const reversibleProduction = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        ...productionInput,
        productionQuantity: 2,
        acceptedQuantity: 2,
        wastage: [],
        idempotencyKey: `production-test:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(reversibleProduction.statusCode).toBe(201);
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(745);
    const cancelRequest = () => requestFor({
      propertyId: property._id,
      params: { id: String(reversibleProduction.body.data.batch._id) },
      body: { idempotencyKey: 'cancel-before-use-test' }
    });
    const cancelledProduction = await invoke(cancelProductionEntry, cancelRequest());
    expect(cancelledProduction.error).toBeUndefined();
    expect(cancelledProduction.body.data.batch.status).toBe('cancelled');
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(765);
    const repeatedCancellation = await invoke(cancelProductionEntry, cancelRequest());
    expect(repeatedCancellation.statusCode).toBe(200);
    expect(repeatedCancellation.body.data.duplicate).toBe(true);

    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `PRD-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [
        { menuItemId: menuItem._id, name: menuItem.name, quantity: 2, unitPrice: 11, amount: 22 },
        { menuItemId: menuItem._id, name: menuItem.name, quantity: 3, unitPrice: 10, amount: 30 }
      ],
      subtotal: 52,
      totalAmount: 52,
      status: 'preparing',
      createdBy: actorId
    });
    const cancelledOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `PRD-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 1, unitPrice: 12, amount: 12 }],
      subtotal: 12,
      totalAmount: 12,
      status: 'preparing',
      createdBy: actorId
    });
    const cancelledOrderRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(cancelledOrder._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, cancelledOrderRequest('ready'));
    await invoke(updateOrderStatus, cancelledOrderRequest('cancelled'));
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity).toBe(18);

    const restaurantRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, restaurantRequest('ready'));
    const served = await invoke(updateOrderStatus, restaurantRequest('served'));
    expect(served.error).toBeUndefined();
    expect(served.body.data.status).toBe('served');
    const orderAllocation = served.body.data.preparedFoodAllocations;
    expect(orderAllocation).toHaveLength(3);
    expect(orderAllocation.reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(5);
    expect(orderAllocation.filter((allocation) => String(allocation.productionBatchId) === String(secondProduction.batch._id))
      .reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(3);
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity).toBe(16);
    expect((await ProductionBatch.findById(secondProduction.batch._id)).availableQuantity).toBe(0);
    const rejectUsedBatchCancellation = await invoke(cancelProductionEntry, requestFor({
      propertyId: property._id,
      params: { id: String(production.batch._id) },
      body: { idempotencyKey: 'cancel-after-sale-test' }
    }));
    expect(rejectUsedBatchCancellation.error?.statusCode).toBe(409);

    const repeatedAllocation = await runInventoryTransaction(async (session) => {
      const currentOrder = await FoodOrder.findById(order._id).session(session);
      return consumePreparedFoodForOrder(currentOrder, session, actorId);
    });
    expect(repeatedAllocation).toHaveLength(3);
    expect((await ProductionBatch.findById(production.batch._id)).soldQuantity).toBe(2);
    expect((await ProductionBatch.findById(secondProduction.batch._id)).soldQuantity).toBe(3);
    expect(await PreparedFoodMovement.countDocuments({
      orderId: order._id,
      movementType: 'sale'
    })).toBe(3);
    const saleMovements = await PreparedFoodMovement.find({ orderId: order._id, movementType: 'sale' }).lean();
    expect(saleMovements.reduce((sum, movement) => sum + movement.salesRevenue, 0)).toBe(0);
    const settledOrder = await invoke(settleOrder, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { paymentMethod: 'cash' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(settledOrder.error).toBeUndefined();
    expect(settledOrder.body.data.paymentStatus).toBe('paid');
    const paidSaleMovements = await PreparedFoodMovement.find({
      orderId: order._id,
      movementType: 'sale'
    }).lean();
    expect(paidSaleMovements.reduce((sum, movement) => sum + movement.salesRevenue, 0)).toBe(52);
    const dashboard = await invoke(getProductionDashboard, requestFor({
      propertyId: property._id,
      query: {
        from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10)
      }
    }));
    expect(dashboard.error).toBeUndefined();
    expect(dashboard.body.data.totals).toMatchObject({
      acceptedQuantity: 21,
      soldQuantity: 5,
      salesRevenue: 52,
      soldFoodCost: 1.04,
      grossProfit: 50.96,
      foodCostPercent: expect.any(Number)
    });
    expect(dashboard.body.data.batches.find(
      (batch) => String(batch._id) === String(production.batch._id)
    )).toMatchObject({
      productionCost: 4,
      costPerPortion: 0.22
    });

    const insufficientOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `PRD-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 17, unitPrice: 12, amount: 204 }],
      subtotal: 204,
      totalAmount: 204,
      status: 'preparing',
      createdBy: actorId
    });
    const insufficientRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(insufficientOrder._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, insufficientRequest('ready'));
    const insufficientServe = await invoke(updateOrderStatus, insufficientRequest('served'));
    expect(insufficientServe.error?.statusCode).toBe(409);
    expect((await FoodOrder.findById(insufficientOrder._id)).status).toBe('ready');
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity).toBe(16);

    const transferRequest = (key) => requestFor({
      propertyId: property._id,
      params: { id: String(production.batch._id) },
      body: {
        quantity: 4,
        destinationLocation: 'Dining Outlet',
        idempotencyKey: key
      }
    });
    const transfer = await invoke(transferProductionBatch, transferRequest('production-transfer-test'));
    expect(transfer.error).toBeUndefined();
    expect(transfer.statusCode).toBe(201);
    expect(transfer.body.data.sourceBatch.availableQuantity).toBe(12);
    expect(transfer.body.data.targetBatch).toMatchObject({
      availableQuantity: 4,
      location: 'Dining Outlet',
      isTransferBatch: true
    });
    const duplicateTransfer = await invoke(transferProductionBatch, transferRequest('production-transfer-test'));
    expect(duplicateTransfer.statusCode).toBe(200);
    expect(duplicateTransfer.body.data.duplicate).toBe(true);
    expect(await PreparedFoodMovement.countDocuments({
      idempotencyKey: 'production-transfer-test',
      movementType: 'transfer_out'
    })).toBe(1);

    await runInventoryTransaction((session) => recordPreparedFoodUse({
      hotelId,
      propertyId: property._id,
      productionBatchId: production.batch._id,
      movementType: 'wastage',
      quantity: 2,
      reason: 'End-of-day spoilage',
      recordedBy: actorId,
      idempotencyKey: `wastage-test:${new mongoose.Types.ObjectId()}`
    }, session));
    const closedBatch = await ProductionBatch.findById(production.batch._id);
    expect(closedBatch.availableQuantity).toBe(10);
    expect(closedBatch.wastedQuantity).toBe(2);
    expect(await PreparedFoodMovement.countDocuments({ productionBatchId: production.batch._id, movementType: 'wastage' })).toBe(1);
    const closingDashboard = await invoke(getProductionDashboard, requestFor({
      propertyId: property._id,
      query: {
        from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10)
      }
    }));
    expect(closingDashboard.body.data.totals).toMatchObject({
      acceptedQuantity: 21,
      soldQuantity: 5,
      transferredOutQuantity: 4,
      wastedQuantity: 2,
      availableQuantity: 14
    });
  });

  it('calculates full-recipe costs from purchase prices and inventory batches, and reports missing costs as pending', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Recipe Cost Test Property',
      code: `RCT${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '2 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234568'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Recipe Cost Tests' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Costed Recipe Test Dish',
      price: 20
    });
    const purchasePriceIngredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Purchase Price Ingredient',
      code: `PPI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0,
      purchasePrice: 40,
      purchaseConversionFactor: 4,
      unitCost: 0
    });
    const batchCostIngredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Batch Cost Ingredient',
      code: `BCI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0,
      unitCost: 0
    });
    await InventoryBatch.create([
      {
        hotelId, propertyId: property._id, itemId: batchCostIngredient._id,
        location: 'Main Store', quantity: 1, remainingQuantity: 1, unitCost: 6
      },
      {
        hotelId, propertyId: property._id, itemId: batchCostIngredient._id,
        location: 'Main Store', quantity: 3, remainingQuantity: 3, unitCost: 10
      }
    ]);

    const recipeResponse = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(menuItem._id),
        recipeName: 'Costed Recipe',
        expectedProductionYield: 10,
        expectedPreparationLossPercent: 20,
        ingredients: [
          { itemId: String(purchasePriceIngredient._id), quantity: 2, unit: 'g' },
          { itemId: String(batchCostIngredient._id), quantity: 2, unit: 'g' }
        ]
      }
    }));
    expect(recipeResponse.statusCode).toBe(201);

    const recipes = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const recipe = recipes.body.data.find((entry) => String(entry._id) === String(recipeResponse.body.data._id));
    expect(recipe).toMatchObject({
      totalRecipeCost: 38,
      estimatedRecipeCost: 4.75,
      costPerServing: 4.75,
      sellingPrice: 20,
      expectedProductionYield: 10,
      expectedPreparationLossPercent: 20,
      expectedPreparationLossQuantity: 2,
      expectedUsableQuantity: 8,
      estimatedGrossProfit: 15.25,
      estimatedProfitWhole: 122,
      foodCostPercent: 23.75,
      costPending: false
    });

    const unpricedMenuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Unpriced Recipe Test Dish',
      price: 20
    });
    const unpricedIngredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Unpriced Ingredient',
      code: `UPI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0,
      unitCost: 0,
      purchasePrice: null
    });
    const unpricedRecipe = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(unpricedMenuItem._id),
        ingredients: [{ itemId: String(unpricedIngredient._id), quantity: 1, unit: 'g' }]
      }
    }));
    const recipesWithUnpriced = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const pendingRecipe = recipesWithUnpriced.body.data.find(
      (entry) => String(entry._id) === String(unpricedRecipe.body.data._id)
    );
    expect(pendingRecipe).toMatchObject({
      totalRecipeCost: null,
      estimatedRecipeCost: null,
      estimatedGrossProfit: null,
      estimatedProfitWhole: null,
      foodCostPercent: null,
      costPending: true
    });

    const missingYieldRecipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: unpricedMenuItem._id,
      recipeName: 'Recipe Without Yield',
      servingSize: '1 serving',
      expectedProductionYield: null,
      expectedPreparationLossPercent: 10,
      productionMode: 'made_to_order',
      version: 2,
      ingredients: [{
        itemId: purchasePriceIngredient._id,
        quantity: 2,
        unit: 'g',
        conversionFactor: 1
      }],
      createdBy: actorId
    });
    const recipesWithoutYield = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const yieldPendingRecipe = recipesWithoutYield.body.data.find(
      (entry) => String(entry._id) === String(missingYieldRecipe._id)
    );
    expect(yieldPendingRecipe).toMatchObject({
      totalRecipeCost: 20,
      estimatedRecipeCost: null,
      expectedPreparationLossQuantity: null,
      expectedUsableQuantity: null,
      estimatedGrossProfit: null,
      estimatedProfitWhole: null,
      foodCostPercent: null
    });
  });
});
