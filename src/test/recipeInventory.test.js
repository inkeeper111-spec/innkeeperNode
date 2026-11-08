import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInventoryReport, getRecipes, saveRecipe, setRecipeStatus } from '../controllers/inventoryAdvancedController.js';
import { getInventoryBatches } from '../controllers/inventoryController.js';
import { updateOrderStatus } from '../controllers/restaurantController.js';
import {
  FoodOrder, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, InventorySettings,
  MenuCategory, MenuItem, Property, RecipeConsumption, StockMovement
} from '../models/index.js';
import {
  consumeRecipesForOrder, postStockMovement, runInventoryTransaction
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
      sellingPrice: 5,
      estimatedGrossProfit: 4.67,
      foodCostPercent: 6.6
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
});
