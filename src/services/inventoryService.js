import mongoose from 'mongoose';
import {
  Hotel, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, RecipeConsumption, StockMovement, Unit
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
  batchIds,
  unitId,
  conversionFactor,
  purchasePackageId = null,
  purchasePackageName = '',
  purchasePackageSnapshot = false,
  packageQuantity = null,
  looseQuantity = 0,
  unitCost: unitCostOverride,
  purchaseUnitPrice = null,
  vendorId = null,
  autoGenerateBatchNumber = false,
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
  let numericQuantity = Number(quantity);
  const isStockCount = movementType === 'adjustment' || movementType === 'physical_count';

  if (idempotencyKey) {
    const existing = await StockMovement.findOne({ hotelId, propertyId, idempotencyKey }).session(session);
    if (existing) return { movement: existing, duplicate: true };
  }

  const item = await InventoryItem.findOne({ _id: itemId, hotelId, propertyId, isActive: true }).session(session);
  if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
  const hasPackageQuantity = packageQuantity !== null && packageQuantity !== undefined;
  if ((purchasePackageId && !hasPackageQuantity && !purchasePackageSnapshot)
    || (hasPackageQuantity && !purchasePackageId)) {
    throw Object.assign(new Error('A configured package and package quantity must be provided together.'), { statusCode: 400 });
  }
  const purchasePackage = purchasePackageId && hasPackageQuantity
    ? item.supportedUnits.id(String(purchasePackageId))
    : null;
  let enteredQuantity = numericQuantity;
  let enteredUnit = purchasePackageName || unit || item.baseUnit || item.unit;
  let conversionFactorOverride = conversionFactor;
  let recordedLooseQuantity = 0;
  let configuredUnitId = unitId || unitIdForSymbol(item, enteredUnit);
  if (purchasePackageId && hasPackageQuantity) {
    const packageCount = Number(packageQuantity);
    recordedLooseQuantity = Number(looseQuantity);
    if (movementType !== 'receipt' || item.inventoryType !== 'raw_material'
      || !purchasePackage || purchasePackage.isActive === false
      || !(Number(purchasePackage.packageSize) > 0)
      || !purchasePackage.packageMeasurementUnitId
      || !Number.isFinite(packageCount) || packageCount < 0
      || !Number.isFinite(recordedLooseQuantity) || recordedLooseQuantity < 0
      || (packageCount === 0 && recordedLooseQuantity === 0)
      || !(Number(purchasePackage.conversionFactorToBase) > 0)) {
      throw Object.assign(new Error('Choose a configured package and enter a positive package or loose quantity.'), { statusCode: 400 });
    }
    enteredQuantity = packageCount;
    enteredUnit = purchasePackage.packageName || purchasePackage.unitNameSnapshot;
    conversionFactorOverride = Number(purchasePackage.conversionFactorToBase);
    numericQuantity = packageCount * conversionFactorOverride + recordedLooseQuantity;
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      throw Object.assign(new Error('Converted stock quantity must be greater than zero.'), { statusCode: 400 });
    }
    configuredUnitId = purchasePackage.unitId;
    unit = item.baseUnit || item.unit;
    conversionFactorOverride = 1;
  }
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0 || (numericQuantity === 0 && !isStockCount)) {
    throw Object.assign(new Error(isStockCount ? 'Counted stock cannot be negative.' : 'Quantity must be a positive number.'), { statusCode: 400 });
  }
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
  const converted = convertQuantityToBase(item, numericQuantity, unit || enteredUnit, conversionFactorOverride);
  const purchasePrice = purchaseUnitPrice === null || purchaseUnitPrice === undefined
    ? null
    : Number(purchaseUnitPrice);
  if (purchasePrice !== null && (!Number.isFinite(purchasePrice) || purchasePrice < 0)) {
    throw Object.assign(new Error('Purchase price must be a non-negative number.'), { statusCode: 400 });
  }
  if (autoGenerateBatchNumber && movementType === 'receipt' && !batchNumber) {
    const hotel = await Hotel.findById(hotelId).select('name').session(session);
    if (!hotel?.name) {
      throw Object.assign(new Error('Hotel name is required to generate a stock batch number.'), { statusCode: 400 });
    }
    const hotelCode = hotel.name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'HTL';
    const itemCode = item.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';
    const existingBatchNumbers = await InventoryBatch.find({ hotelId, propertyId, itemId: item._id })
      .select('batchNumber')
      .session(session)
      .lean();
    const latestSequence = existingBatchNumbers.reduce((latest, batch) => {
      const match = String(batch.batchNumber || '').match(/_B(\d+)$/i);
      return match ? Math.max(latest, Number(match[1])) : latest;
    }, 0);
    let nextSequence = latestSequence + 1;
    const existingNumbers = new Set(existingBatchNumbers.map((batch) => batch.batchNumber));
    batchNumber = `${hotelCode}_${itemCode}_B${nextSequence}`;
    while (existingNumbers.has(batchNumber)) {
      nextSequence += 1;
      batchNumber = `${hotelCode}_${itemCode}_B${nextSequence}`;
    }
  }
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
  const receiptUnitCost = purchasePrice !== null
    ? purchasePrice / converted.factor
    : Number.isFinite(Number(unitCostOverride)) ? Number(unitCostOverride) : item.unitCost;
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
      ...(Array.isArray(batchIds) ? { _id: { $in: batchIds } } : {}),
      ...(movementType === 'expiry'
        ? { expiryDate: { $lte: now } }
        : { $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] })
    };
    batchesToDeduct = await InventoryBatch.find(batchFilter)
      .sort({ receivedAt: 1, _id: 1 })
      .session(session);
    if (movementType === 'recipe_consumption' && (item.trackExpiry || hasExpiryBatches)) {
      batchesToDeduct.sort((left, right) => {
        const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
        const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
        return leftExpiry - rightExpiry
          || new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime()
          || String(left._id).localeCompare(String(right._id));
      });
    }
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
      ...(vendorId ? { vendorId } : {}),
      ...(purchasePrice !== null ? {
        purchaseQuantity: enteredQuantity,
        purchaseUnit: enteredUnit,
        purchaseUnitCost: purchasePrice,
        purchaseAmount: round(enteredQuantity * purchasePrice)
      } : {}),
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
    vendorId,
    purchaseUnitPrice: purchasePrice,
    idempotencyKey,
    orderId,
    batchNumber,
    expiryDate,
    batchAllocations,
    enteredQuantity,
    enteredUnit: purchasePackage || purchasePackageName ? enteredUnit : converted.unit,
    enteredUnitId,
    purchasePackageId: purchasePackage?._id || purchasePackageId || null,
    purchasePackageName: purchasePackage?.packageName || purchasePackageName || '',
    looseQuantity: recordedLooseQuantity,
    conversionFactor: purchasePackage ? Number(purchasePackage.conversionFactorToBase) : converted.factor,
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

export const consumeRecipesForOrder = async (order, session, {
  skipEmpty = false,
  recordedBy = order.createdBy
} = {}) => {
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

  if (!required.size && skipEmpty) return null;

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
      recordedBy,
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

export const reverseRecipeConsumptionForOrder = async (order, session, recordedBy) => {
  const consumption = await RecipeConsumption.findOne({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    orderId: order._id
  }).session(session);
  if (!consumption || consumption.status === 'reversed') return consumption;

  const movements = await StockMovement.find({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    orderId: order._id,
    movementType: 'recipe_consumption'
  }).session(session);

  for (const movement of movements) {
    const item = await InventoryItem.findOneAndUpdate(
      { _id: movement.itemId, hotelId: order.hotelId, propertyId: order.propertyId },
      { $inc: { currentStock: movement.quantity } },
      { new: true, session }
    );
    if (!item) {
      throw Object.assign(new Error('A recipe ingredient could not be restored because its inventory item is missing.'), { statusCode: 409 });
    }

    const balance = await updateBalance({
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      item,
      location: movement.location,
      delta: movement.quantity,
      session
    });

    const restoredAllocations = [];
    for (const allocation of movement.batchAllocations || []) {
      if (!allocation.batchId) {
        restoredAllocations.push({
          batchId: null,
          quantity: allocation.quantity,
          unitCost: allocation.unitCost,
          totalCost: allocation.totalCost,
          source: allocation.source
        });
        continue;
      }
      const restoredBatch = await InventoryBatch.findOneAndUpdate({
        _id: allocation.batchId,
        hotelId: order.hotelId,
        propertyId: order.propertyId,
        itemId: movement.itemId,
        location: movement.location,
        $expr: {
          $lte: [
            { $add: ['$remainingQuantity', allocation.quantity] },
            '$quantity'
          ]
        }
      }, { $inc: { remainingQuantity: allocation.quantity } }, { new: true, session });
      if (!restoredBatch) {
        throw Object.assign(new Error('A consumed inventory batch could not be restored safely.'), { statusCode: 409 });
      }
      restoredAllocations.push({
        batchId: allocation.batchId,
        quantity: allocation.quantity,
        unitCost: allocation.unitCost,
        totalCost: allocation.totalCost,
        source: allocation.source
      });
    }

    const previousStock = roundQuantity(item.currentStock - movement.quantity);
    await StockMovement.create([{
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      itemId: movement.itemId,
      movementType: 'sale_reversal',
      quantity: movement.quantity,
      previousStock,
      newStock: item.currentStock,
      unitCost: movement.unitCost,
      totalValue: movement.totalValue,
      referenceNumber: order.orderNumber,
      notes: `Recipe consumption reversal for cancelled restaurant order ${order.orderNumber}`,
      recordedBy,
      location: movement.location,
      department: movement.department,
      orderId: order._id,
      idempotencyKey: `recipe-sale-reversal:${order._id}:${movement.itemId}`,
      batchAllocations: restoredAllocations,
      metadata: {
        reversedMovementId: movement._id,
        locationPreviousStock: balance.previous,
        locationNewStock: balance.current
      }
    }], { session });
  }

  consumption.status = 'reversed';
  consumption.reversedAt = new Date();
  await consumption.save({ session });
  return consumption;
};
