import mongoose from 'mongoose';
import {
  InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, RecipeConsumption, StockMovement, Unit
} from '../models/index.js';
import { convertQuantityToBase } from '../config/inventoryUnits.js';

const round = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;
const roundQuantity = (value) => Math.round((value + Number.EPSILON) * 100000000) / 100000000;
const unitIdForSymbol = (item, symbol) => {
  if (item.baseUnit === symbol) return item.baseUnitId || null;
  if (item.purchaseUnit === symbol) return item.purchaseUnitId || null;
  const packageOption = (item.packagingOptions || []).find((option) => option.unit === symbol);
  return packageOption?.unitId || (item.additionalPackagingOptions || [])
    .find((option) => String(option.unitId?.symbol || '') === symbol)?.unitId || null;
};

const updateBalance = async ({ hotelId, propertyId, item, location, delta, session }) => {
  let balance = await InventoryBalance.findOne({
    hotelId, propertyId, itemId: item._id, location
  }).session(session);

  if (!balance) {
    balance = await InventoryBalance.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location,
      quantity: location === 'Main Store' ? item.currentStock : 0
    }], { session }).then(([created]) => created);
  }

  const updated = await InventoryBalance.findOneAndUpdate({
    _id: balance._id,
    quantity: delta < 0 ? { $gte: Math.abs(delta) } : { $gte: 0 }
  }, { $inc: { quantity: delta } }, { new: true, session });
  if (!updated) {
    throw Object.assign(new Error(`Insufficient stock at ${location} for ${item.name}.`), { statusCode: 409 });
  }
  return { previous: roundQuantity(updated.quantity - delta), current: roundQuantity(updated.quantity) };
};

export const postStockMovement = async ({
  hotelId,
  propertyId,
  itemId,
  movementType,
  quantity,
  unit,
  unitId,
  conversionFactor,
  unitCost: unitCostOverride,
  location = 'Main Store',
  department = '',
  referenceNumber = '',
  notes = '',
  recordedBy,
  transactionDate = null,
  idempotencyKey,
  orderId = null,
  batchNumber = '',
  expiryDate = null,
  batchDetails = {},
  receivedAt = null,
  metadata = {},
  session
}) => {
  const numericQuantity = Number(quantity);
  const isStockCount = movementType === 'adjustment' || movementType === 'physical_count';
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0 || (numericQuantity === 0 && !isStockCount)) {
    throw Object.assign(new Error(isStockCount ? 'Counted stock cannot be negative.' : 'Quantity must be a positive number.'), { statusCode: 400 });
  }

  if (idempotencyKey) {
    const existing = await StockMovement.findOne({ hotelId, propertyId, idempotencyKey }).session(session);
    if (existing) return { movement: existing, duplicate: true };
  }

  const item = await InventoryItem.findOne({ _id: itemId, hotelId, propertyId, isActive: true }).session(session);
  if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
  const enteredUnit = unit || item.baseUnit || item.unit;
  const configuredUnitId = unitId || unitIdForSymbol(item, enteredUnit);
  let enteredUnitRecord;
  if (configuredUnitId) {
    enteredUnitRecord = await Unit.findOne({ _id: configuredUnitId, hotelId }).session(session);
  } else {
    enteredUnitRecord = await Unit.findOne({
      hotelId,
      symbolKey: String(enteredUnit).trim().toLocaleLowerCase(),
      ...(conversionFactor === undefined ? { isActive: true } : {})
    }).session(session);
  }
  if (item.baseUnitId) {
    const baseUnitRecord = await Unit.findOne({ _id: item.baseUnitId, hotelId }).session(session);
    if (!enteredUnitRecord || !baseUnitRecord) {
      throw Object.assign(new Error('Stock movement unit is not registered for this hotel.'), { statusCode: 400 });
    }
    if (!configuredUnitId && enteredUnitRecord.category !== baseUnitRecord.category) {
      throw Object.assign(new Error('Stock movement units must be compatible with the inventory item base unit.'), { statusCode: 400 });
    }
  }
  const converted = convertQuantityToBase(item, numericQuantity, enteredUnit, conversionFactor);
  const enteredUnitId = enteredUnitRecord?._id || configuredUnitId || null;
  const baseQuantity = roundQuantity(converted.quantity);
  const locationBalance = isStockCount
    ? await InventoryBalance.findOne({ hotelId, propertyId, itemId: item._id, location }).session(session)
    : null;
  const currentLocationStock = locationBalance?.quantity ?? (location === 'Main Store' ? item.currentStock : 0);
  const delta = ['receipt', 'return', 'opening'].includes(movementType) ? baseQuantity
    : movementType === 'adjustment' || movementType === 'physical_count'
      ? baseQuantity - currentLocationStock
      : -baseQuantity;
  const receiptUnitCost = Number.isFinite(Number(unitCostOverride)) ? Number(unitCostOverride) : item.unitCost;
  if (delta > 0 && item.trackExpiry && !expiryDate) {
    throw Object.assign(new Error(`An expiry date is required for ${item.name}.`), { statusCode: 400 });
  }
  if (delta > 0 && item.trackBatchNumber && !batchNumber) {
    throw Object.assign(new Error(`A batch number is required for ${item.name}.`), { statusCode: 400 });
  }

  let batchesToDeduct = [];
  let batchAllocations = [];
  const hasExpiryBatches = delta < 0 && await InventoryBatch.exists({
    hotelId, propertyId, itemId: item._id, location, expiryDate: { $ne: null }
  }).session(session);
  if (delta < 0) {
    const now = new Date();
    const batchFilter = {
      hotelId,
      propertyId,
      itemId: item._id,
      location,
      remainingQuantity: { $gt: 0 },
      ...(movementType === 'expiry'
        ? { expiryDate: { $lte: now } }
        : { $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] })
    };
    batchesToDeduct = await InventoryBatch.find(batchFilter)
      .sort({ receivedAt: 1, _id: 1 })
      .session(session);
    const usableQuantity = batchesToDeduct.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
    if ((item.trackExpiry || item.trackBatchNumber || hasExpiryBatches || movementType === 'expiry')
      && usableQuantity < Math.abs(delta)) {
      throw Object.assign(new Error(
        movementType === 'expiry'
          ? `Expired batch stock for ${item.name} is less than the adjustment quantity.`
          : `Insufficient unexpired batch stock for ${item.name} at ${location}.`
      ), { statusCode: 409 });
    }
  }
  const previousStock = item.currentStock;
  const nextStock = roundQuantity(previousStock + delta);
  if (nextStock < 0) {
    throw Object.assign(new Error(`Insufficient stock. Current stock is ${previousStock} ${item.unit}.`), { statusCode: 409 });
  }

  if (delta !== 0) {
    const itemUpdate = await InventoryItem.updateOne({
      _id: item._id,
      hotelId,
      propertyId,
      currentStock: delta < 0 ? { $gte: Math.abs(delta) } : previousStock
    }, { $inc: { currentStock: delta } }, { session });
    if (itemUpdate.modifiedCount !== 1) {
      throw Object.assign(new Error('Stock changed concurrently. Refresh and retry.'), { statusCode: 409 });
    }
  }

  const balanceMovement = await updateBalance({
    hotelId, propertyId, item, location, delta, session
  });
  let remainingToDeduct = Math.abs(delta);
  let movementTotalValue = 0;
  for (const batch of batchesToDeduct) {
    if (remainingToDeduct <= 0) break;
    const deduction = Math.min(batch.remainingQuantity, remainingToDeduct);
    const updatedBatch = await InventoryBatch.updateOne({
      _id: batch._id,
      remainingQuantity: { $gte: deduction }
    }, { $inc: { remainingQuantity: -deduction } }, { session });
    if (updatedBatch.modifiedCount !== 1) {
      throw Object.assign(new Error('Inventory batch changed concurrently; retry the stock operation.'), { statusCode: 409 });
    }
    const allocationCost = round(deduction * batch.unitCost);
    batchAllocations.push({
      batchId: batch._id,
      quantity: deduction,
      unitCost: batch.unitCost,
      totalCost: allocationCost,
      source: 'batch'
    });
    movementTotalValue += allocationCost;
    remainingToDeduct = roundQuantity(remainingToDeduct - deduction);
  }
  if (remainingToDeduct > 0) {
    const legacyCost = round(remainingToDeduct * item.unitCost);
    batchAllocations.push({
      batchId: null,
      quantity: remainingToDeduct,
      unitCost: item.unitCost,
      totalCost: legacyCost,
      source: 'legacy'
    });
    movementTotalValue += legacyCost;
  }
  if (delta > 0) {
    await InventoryBatch.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location,
      batchNumber,
      quantity: delta,
      remainingQuantity: delta,
      unitCost: receiptUnitCost,
      expiryDate,
      ...batchDetails,
      ...(receivedAt ? { receivedAt } : {})
    }], { session });
  }
  if (delta >= 0) movementTotalValue = round(Math.abs(delta) * receiptUnitCost);
  else movementTotalValue = round(movementTotalValue);
  const movementUnitCost = Math.abs(delta) > 0
    ? round(movementTotalValue / Math.abs(delta))
    : receiptUnitCost;
  const movement = await StockMovement.create([{
    hotelId,
    propertyId,
    itemId: item._id,
    movementType,
    transactionDate: transactionDate || new Date(),
    quantity: roundQuantity(Math.abs(delta)),
    previousStock,
    newStock: nextStock,
    unitCost: movementUnitCost,
    totalValue: movementTotalValue,
    referenceNumber,
    notes,
    recordedBy,
    location,
    department,
    idempotencyKey,
    orderId,
    batchNumber,
    expiryDate,
    batchAllocations,
    enteredQuantity: numericQuantity,
    enteredUnit: converted.unit,
    enteredUnitId,
    conversionFactor: converted.factor,
    baseUnit: item.baseUnit || item.unit,
    baseUnitId: item.baseUnitId || null,
    metadata: { ...metadata, locationPreviousStock: balanceMovement.previous, locationNewStock: balanceMovement.current }
  }], { session }).then(([created]) => created);

  return { movement, item: { ...item.toObject(), currentStock: nextStock }, duplicate: false };
};

export const runInventoryTransaction = async (operation) => {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

export const transferStock = async ({
  hotelId, propertyId, itemId, quantity, unit, conversionFactor, fromLocation, toLocation, department = '',
  recordedBy, referenceNumber, idempotencyKey, notes = '', session
}) => {
  const enteredQuantity = Number(quantity);
  if (!Number.isFinite(enteredQuantity) || enteredQuantity <= 0 || !fromLocation || !toLocation || fromLocation === toLocation) {
    throw Object.assign(new Error('Transfer requires a positive quantity and two different stock locations.'), { statusCode: 400 });
  }
  const existing = idempotencyKey
    ? await StockMovement.findOne({ hotelId, propertyId, idempotencyKey: `${idempotencyKey}:out` }).session(session)
    : null;
  if (existing) return { movement: existing, duplicate: true };

  const item = await InventoryItem.findOne({ _id: itemId, hotelId, propertyId, isActive: true }).session(session);
  if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
  const converted = convertQuantityToBase(item, enteredQuantity, unit || item.baseUnit || item.unit, conversionFactor);
  const qty = roundQuantity(converted.quantity);
  const allSourceBatches = await InventoryBatch.find({
    hotelId, propertyId, itemId: item._id, location: fromLocation, remainingQuantity: { $gt: 0 }
  }).sort({ receivedAt: 1, _id: 1 }).session(session);
  const now = new Date();
  const hasExpiryBatches = allSourceBatches.some((batch) => Boolean(batch.expiryDate));
  const sourceBatches = item.trackExpiry || hasExpiryBatches
    ? allSourceBatches.filter((batch) => !batch.expiryDate || batch.expiryDate > now)
    : allSourceBatches;
  const sourceBatchQuantity = sourceBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
  if ((item.trackExpiry || item.trackBatchNumber || hasExpiryBatches) && sourceBatchQuantity < qty) {
    throw Object.assign(new Error(`Insufficient tracked stock at ${fromLocation} for ${item.name}.`), { statusCode: 409 });
  }
  const source = await updateBalance({
    hotelId, propertyId, item, location: fromLocation, delta: -qty, session
  });
  const destination = await updateBalance({
    hotelId, propertyId, item, location: toLocation, delta: qty, session
  });
  let batchQuantityToMove = Math.min(qty, sourceBatchQuantity);
  for (const batch of sourceBatches) {
    if (batchQuantityToMove <= 0) break;
    const movedQuantity = Math.min(batch.remainingQuantity, batchQuantityToMove);
    const update = await InventoryBatch.updateOne({
      _id: batch._id,
      remainingQuantity: { $gte: movedQuantity }
    }, { $inc: { remainingQuantity: -movedQuantity } }, { session });
    if (update.modifiedCount !== 1) {
      throw Object.assign(new Error('Inventory batch changed concurrently; retry the stock transfer.'), { statusCode: 409 });
    }
    await InventoryBatch.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location: toLocation,
      batchNumber: batch.batchNumber,
      quantity: movedQuantity,
      remainingQuantity: movedQuantity,
      unitCost: batch.unitCost,
      expiryDate: batch.expiryDate,
      receivedAt: batch.receivedAt
    }], { session });
    batchQuantityToMove = roundQuantity(batchQuantityToMove - movedQuantity);
  }
  const common = {
    hotelId, propertyId, itemId: item._id, movementType: 'transfer', quantity: qty,
    enteredQuantity, enteredUnit: converted.unit, conversionFactor: converted.factor,
    baseUnit: item.baseUnit || item.unit,
    previousStock: item.currentStock, newStock: item.currentStock,
    unitCost: item.unitCost, totalValue: round(qty * item.unitCost), referenceNumber,
    notes, recordedBy, department,
    metadata: { fromLocation, toLocation }
  };
  const movements = await StockMovement.create([
    {
      ...common,
      location: fromLocation,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:out` : undefined,
      metadata: { ...common.metadata, locationPreviousStock: source.previous, locationNewStock: source.current }
    },
    {
      ...common,
      location: toLocation,
      destinationLocation: toLocation,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:in` : undefined,
      metadata: { ...common.metadata, locationPreviousStock: destination.previous, locationNewStock: destination.current }
    }
  ], { session });
  return { movements, item, duplicate: false };
};

export const consumeRecipesForOrder = async (order, session) => {
  const existing = await RecipeConsumption.findOne({
    hotelId: order.hotelId, propertyId: order.propertyId, orderId: order._id
  }).session(session);
  if (existing) return existing;

  const menuItemIds = [...new Set(order.items.map((line) => String(line.menuItemId)))];
  const recipes = await InventoryRecipe.find({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    menuItemId: { $in: menuItemIds },
    isActive: true
  }).sort({ version: -1 }).session(session);
  const latestRecipes = new Map();
  for (const recipe of recipes) {
    if (!latestRecipes.has(String(recipe.menuItemId))) latestRecipes.set(String(recipe.menuItemId), recipe);
  }

  const required = new Map();
  for (const soldLine of order.items) {
    const recipe = latestRecipes.get(String(soldLine.menuItemId));
    if (!recipe) continue;
    for (const ingredient of recipe.ingredients) {
      if (ingredient.optional) continue;
      const requestedSubstitution = (soldLine.ingredientSubstitutions || []).find(
        (substitution) => String(substitution.ingredientItemId) === String(ingredient.itemId)
      );
      const selectedSubstitution = requestedSubstitution && ingredient.substitutions.find(
        (substitution) => String(substitution.itemId) === String(requestedSubstitution.substituteItemId)
      );
      if (requestedSubstitution && !selectedSubstitution) {
        throw Object.assign(new Error('The selected ingredient substitution is not allowed by the active recipe.'), { statusCode: 400 });
      }
      const consumedItemId = selectedSubstitution?.itemId || ingredient.itemId;
      const unit = selectedSubstitution?.unit || ingredient.unit;
      const enteredQuantity = (selectedSubstitution?.quantity ?? ingredient.quantity) * soldLine.quantity;
      const conversionFactor = selectedSubstitution?.conversionFactor ?? ingredient.conversionFactor;
      const itemId = String(consumedItemId);
      const item = await InventoryItem.findOne({
        _id: consumedItemId, hotelId: order.hotelId, propertyId: order.propertyId, isActive: true
      }).session(session);
      if (!item) throw Object.assign(new Error('A recipe ingredient is no longer an active inventory item.'), { statusCode: 409 });
      const converted = convertQuantityToBase(item, enteredQuantity, unit, conversionFactor || undefined);
      const quantity = roundQuantity(converted.quantity);
      const source = {
        menuItemId: soldLine.menuItemId,
        menuItemName: soldLine.name,
        version: recipe.version,
        quantity,
        unit: item.baseUnit || item.unit,
        enteredQuantity,
        enteredUnit: converted.unit,
        conversionFactor: converted.factor
      };
      const prior = required.get(itemId);
      if (prior) {
        prior.quantity = roundQuantity(prior.quantity + quantity);
        prior.sources.push(source);
      } else {
        required.set(itemId, {
          item, quantity, menuItemId: soldLine.menuItemId, menuItemName: soldLine.name,
          version: recipe.version, unit: item.unit, sources: [source]
        });
      }
    }
  }

  const entries = [];
  for (const requirement of required.values()) {
    const movementResult = await postStockMovement({
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      itemId: requirement.item._id,
      movementType: 'recipe_consumption',
      quantity: requirement.quantity,
      location: 'Restaurant Store',
      department: 'Restaurant',
      referenceNumber: order.orderNumber,
      notes: `Recipe consumption for finalized restaurant order ${order.orderNumber}`,
      recordedBy: order.createdBy,
      orderId: order._id,
      idempotencyKey: `recipe-sale:${order._id}:${requirement.item._id}`,
      metadata: { recipeSources: requirement.sources },
      session
    });
    let remainingCost = movementResult.movement.totalValue;
    for (const [index, source] of requirement.sources.entries()) {
      const sourceCost = index === requirement.sources.length - 1
        ? round(remainingCost)
        : round(movementResult.movement.totalValue * (source.quantity / requirement.quantity));
      remainingCost = round(remainingCost - sourceCost);
      entries.push({
        itemId: requirement.item._id,
        menuItemId: source.menuItemId,
        menuItemName: source.menuItemName,
        recipeVersion: source.version,
        quantity: source.quantity,
        unit: source.unit,
        enteredQuantity: source.enteredQuantity,
        enteredUnit: source.enteredUnit,
        conversionFactor: source.conversionFactor,
        baseUnit: source.unit,
        unitCost: source.quantity > 0 ? round(sourceCost / source.quantity) : 0,
        totalCost: sourceCost
      });
    }
  }

  return RecipeConsumption.create([{
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    ingredients: entries,
    totalCost: round(entries.reduce((sum, entry) => sum + entry.totalCost, 0))
  }], { session }).then(([created]) => created);
};
