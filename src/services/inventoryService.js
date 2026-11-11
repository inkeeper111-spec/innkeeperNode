import mongoose from 'mongoose';
import {
  Hotel, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, MenuItem,
  PreparedFoodMovement, ProductionBatch, PurchaseOrder, RecipeConsumption, StockMovement, Unit, Vendor
} from '../models/index.js';
import { convertQuantityToBase, normalizeInventoryUnit } from '../config/inventoryUnits.js';
import { generateReference } from '../utils/reference.js';

const round = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;
const roundQuantity = (value) => Math.round((value + Number.EPSILON) * 100000000) / 100000000;
const OPEN_PURCHASE_ORDER_STATUSES = [
  'draft', 'pending_approval', 'approved', 'ordered', 'partially_received'
];
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
export const getInventoryBatchAverageCosts = async ({ hotelId, propertyId, itemIds, session }) => {
  const validItemIds = [...new Set(itemIds.map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!validItemIds.length) return new Map();

  const pipeline = [
    {
      $match: {
        hotelId,
        ...(propertyId ? { propertyId } : {}),
        itemId: { $in: validItemIds },
        remainingQuantity: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: '$itemId',
        quantity: { $sum: '$remainingQuantity' },
        value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
      }
    }
  ];
  const aggregation = InventoryBatch.aggregate(pipeline);
  if (session) aggregation.session(session);
  const batchCosts = await aggregation;
  return new Map(batchCosts.map((batch) => [
    String(batch._id),
    batch.quantity > 0 ? batch.value / batch.quantity : null
  ]));
};
const DEPARTMENT_STOCK_LOCATIONS = {
  Kitchen: 'Kitchen Store',
  Restaurant: 'Restaurant Store',
  Housekeeping: 'Housekeeping Store',
  Maintenance: 'Maintenance Store',
  Minibar: 'Minibar Store'
};

const recordPreparedFoodMovement = async ({
  batch, movementType, quantity, idempotencyKey, recordedBy, session, order = null,
  reason = '', notes = '', unitSellingPrice = null
}) => {
  const qty = roundQuantity(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error('Prepared food quantity must be greater than zero.'), { statusCode: 400 });
  }
  const counterField = {
    sale: 'soldQuantity',
    wastage: 'wastedQuantity',
    complimentary: 'complimentaryQuantity',
    staff_consumption: 'staffConsumptionQuantity',
    transfer_out: 'transferredOutQuantity'
  }[movementType];
  if (!counterField) {
    throw Object.assign(new Error('Unsupported prepared food movement.'), { statusCode: 400 });
  }
  const updated = await ProductionBatch.findOneAndUpdate({
    _id: batch._id,
    status: 'active',
    availableQuantity: { $gte: qty }
  }, {
    $inc: { availableQuantity: -qty, [counterField]: qty }
  }, { new: true, session });
  if (!updated) {
    throw Object.assign(new Error(`Insufficient prepared portions for ${batch.menuItemName} in batch ${batch.batchNumber}.`), { statusCode: 409 });
  }
  const totalCost = roundMoney(qty * batch.costPerPortion);
  const unitPrice = Number(batch.sellingPrice) || 0;
  const [movement] = await PreparedFoodMovement.create([{
    hotelId: batch.hotelId,
    propertyId: batch.propertyId,
    productionBatchId: batch._id,
    menuItemId: batch.menuItemId,
    movementType,
    quantity: qty,
    unitCost: batch.costPerPortion,
    totalCost,
    salesRevenue: movementType === 'sale'
      ? roundMoney(qty * (unitSellingPrice !== null && Number.isFinite(Number(unitSellingPrice))
        ? Number(unitSellingPrice)
        : unitPrice))
      : 0,
    orderId: order?._id || null,
    orderNumber: order?.orderNumber || '',
    idempotencyKey,
    reason,
    location: batch.location,
    recordedBy,
    notes
  }], { session });
  return { batch: updated, movement, totalCost };
};

export const createProductionBatch = async ({
  hotelId,
  propertyId,
  recipeId,
  productionQuantity,
  acceptedQuantity = productionQuantity,
  productionMethod = 'recipe_based',
  ingredients = [],
  wastage = [],
  location = 'Kitchen Store',
  rawMaterialLocation = 'Main Store',
  productionDate = new Date(),
  expiryDate = null,
  preparedBy = null,
  receivedBy = null,
  recordedBy,
  idempotencyKey,
  notes = ''
}, session) => {
  if (idempotencyKey) {
    const duplicate = await ProductionBatch.findOne({ hotelId, propertyId, idempotencyKey }).session(session);
    if (duplicate) return { batch: duplicate, duplicate: true };
  }
  const quantity = Number(productionQuantity);
  const accepted = Number(acceptedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(accepted)
    || accepted <= 0 || accepted > quantity
    || !['recipe_based', 'actual_consumption'].includes(productionMethod)
    || !Array.isArray(ingredients) || !Array.isArray(wastage)) {
    throw Object.assign(new Error('Enter valid production and accepted quantities and a supported production method.'), { statusCode: 400 });
  }
  const recipe = await InventoryRecipe.findOne({
    _id: recipeId,
    hotelId,
    propertyId,
    isActive: true,
    productionMode: 'batch_production'
  }).session(session);
  if (!recipe) {
    throw Object.assign(new Error('Select an active batch-production recipe.'), { statusCode: 404 });
  }
  const menuItem = await MenuItem.findOne({
    _id: recipe.menuItemId,
    hotelId
  }).session(session);
  if (!menuItem) throw Object.assign(new Error('The recipe menu item no longer exists.'), { statusCode: 409 });

  const productionAt = productionDate instanceof Date ? productionDate : new Date(productionDate);
  const expiryAt = expiryDate ? new Date(expiryDate) : null;
  if (Number.isNaN(productionAt.getTime()) || (expiryAt && Number.isNaN(expiryAt.getTime()))
    || (expiryAt && expiryAt < productionAt)) {
    throw Object.assign(new Error('Production and use-by dates must be valid; use-by cannot precede production.'), { statusCode: 400 });
  }
  const actualByItem = new Map(ingredients.map((line) => [String(line.itemId), line]));
  const wastageByItem = new Map(wastage.map((line) => [String(line.itemId), line]));
  if (actualByItem.size !== ingredients.length || wastageByItem.size !== wastage.length) {
    throw Object.assign(new Error('Each ingredient may be entered only once.'), { statusCode: 400 });
  }
  const recipeItemIds = new Set(recipe.ingredients.map((line) => String(line.itemId)));
  if ([...actualByItem.keys(), ...wastageByItem.keys()].some((itemId) => !recipeItemIds.has(itemId))) {
    throw Object.assign(new Error('Production quantities and wastage must refer only to ingredients in the selected recipe.'), { statusCode: 400 });
  }
  const batchNumber = generateReference('PRD');
  const consumedLines = [];
  const recipeBatchCosts = productionMethod === 'recipe_based'
    ? await getInventoryBatchAverageCosts({
      hotelId,
      propertyId,
      itemIds: recipe.ingredients.filter((line) => !line.optional).map((line) => line.itemId),
      session
    })
    : new Map();
  let productionCost = 0;
  let rawMaterialWastageCost = 0;
  for (const recipeIngredient of recipe.ingredients) {
    if (recipeIngredient.optional) continue;
    const item = await InventoryItem.findOne({
      _id: recipeIngredient.itemId,
      hotelId,
      propertyId,
      isActive: true
    }).session(session);
    if (!item) throw Object.assign(new Error('A recipe ingredient is no longer active.'), { statusCode: 409 });
    const enteredLine = actualByItem.get(String(item._id));
    if (productionMethod === 'actual_consumption' && !enteredLine) {
      throw Object.assign(new Error(`Enter actual consumption for ${item.name}.`), { statusCode: 400 });
    }
    const unit = normalizeInventoryUnit(enteredLine?.unit || recipeIngredient.unit || item.baseUnit || item.unit);
    // Scale by portions vs recipe yield only. Expected preparation loss must NOT inflate
    // raw-material deductions — recipe ingredient qty is exact consumption per full yield.
    const yieldScale = 1 / Number(recipe.expectedProductionYield || 1);
    const enteredQuantity = productionMethod === 'actual_consumption'
      ? Number(enteredLine.quantity)
      : Number(recipeIngredient.quantity) * quantity * yieldScale;
    if (!Number.isFinite(enteredQuantity) || enteredQuantity < 0
      || (productionMethod === 'actual_consumption' && enteredQuantity <= 0)) {
      throw Object.assign(new Error(`Enter a valid actual quantity for ${item.name}.`), { statusCode: 400 });
    }
    const actualBase = convertQuantityToBase(
      item,
      enteredQuantity,
      unit,
      productionMethod === 'recipe_based' ? recipeIngredient.conversionFactor : undefined
    ).quantity;
    const theoreticalBase = roundQuantity(
      Number(recipeIngredient.quantity)
        * quantity * yieldScale
        * Number(recipeIngredient.conversionFactor || 1)
    );
    const purchaseConversionFactor = Number(item.purchaseConversionFactor);
    const purchaseUnitCost = item.purchasePrice !== null && item.purchasePrice !== undefined
      && Number.isFinite(Number(item.purchasePrice))
      && Number.isFinite(purchaseConversionFactor)
      && purchaseConversionFactor > 0
      ? Number(item.purchasePrice) / purchaseConversionFactor
      : null;
    const storedUnitCost = Number(item.unitCost);
    const recipeUnitCost = recipeBatchCosts.has(String(item._id))
      ? recipeBatchCosts.get(String(item._id))
      : purchaseUnitCost ?? (
        Number.isFinite(storedUnitCost) && storedUnitCost > 0 ? storedUnitCost : null
      );
    const wastageLine = wastageByItem.get(String(item._id));
    const wastageEntered = Number(wastageLine?.quantity || 0);
    const wastageReason = String(wastageLine?.reason || '').trim();
    if (!Number.isFinite(wastageEntered) || wastageEntered < 0
      || (wastageEntered > 0 && !wastageReason)) {
      throw Object.assign(new Error(`A reason is required for raw material wastage of ${item.name}.`), { statusCode: 400 });
    }
    const wastageUnit = normalizeInventoryUnit(wastageLine?.unit || unit);
    const wastageBase = wastageEntered > 0
      ? convertQuantityToBase(item, wastageEntered, wastageUnit).quantity
      : 0;
    const consumptionMovement = await postStockMovement({
      hotelId,
      propertyId,
      itemId: item._id,
      movementType: 'issue',
      quantity: enteredQuantity,
      unit,
      location: String(rawMaterialLocation).trim() || 'Main Store',
      department: 'Production',
      referenceNumber: batchNumber,
      notes: `Raw material consumed for ${recipe.recipeName || menuItem.name} production.`,
      recordedBy,
      idempotencyKey: idempotencyKey ? `production:${idempotencyKey}:${item._id}:consumption` : undefined,
      metadata: { source: 'food_production', recipeId: String(recipe._id), recipeVersion: recipe.version },
      session
    });
    let wastageMovement = null;
    let wastageCost = 0;
    if (wastageBase > 0) {
      const wastageResult = await postStockMovement({
        hotelId,
        propertyId,
        itemId: item._id,
        movementType: 'wastage',
        quantity: wastageEntered,
        unit: wastageUnit,
        location: String(rawMaterialLocation).trim() || 'Main Store',
        department: 'Production',
        referenceNumber: `${batchNumber}-WASTE`,
        notes: `Production raw material wastage: ${wastageReason}`,
        recordedBy,
        idempotencyKey: idempotencyKey ? `production:${idempotencyKey}:${item._id}:wastage` : undefined,
        metadata: { source: 'food_production', recipeId: String(recipe._id), recipeVersion: recipe.version, reason: wastageReason },
        session
      });
      wastageMovement = wastageResult.movement;
      wastageCost = wastageResult.movement.totalValue;
    }
    const actualCost = consumptionMovement.movement.totalValue;
    const ingredientCost = productionMethod === 'recipe_based' && recipeUnitCost !== null
      ? theoreticalBase * recipeUnitCost
      : actualCost;
    productionCost += ingredientCost;
    rawMaterialWastageCost += wastageCost;
    consumedLines.push({
      itemId: item._id,
      itemName: item.name,
      theoreticalQuantity: theoreticalBase,
      actualQuantity: consumptionMovement.movement.quantity,
      wastageQuantity: wastageBase,
      unit: item.baseUnit || item.unit,
      conversionFactor: 1,
      unitCost: consumptionMovement.movement.quantity > 0
        ? ingredientCost / consumptionMovement.movement.quantity
        : 0,
      totalCost: roundMoney(ingredientCost),
      wastageCost,
      movementId: consumptionMovement.movement._id,
      wastageMovementId: wastageMovement?._id || null,
      wastageReason
    });
  }
  if (actualByItem.size !== recipe.ingredients.filter((line) => !line.optional).length
    && productionMethod === 'actual_consumption') {
    throw Object.assign(new Error('Actual consumption includes an ingredient not required by the active recipe.'), { statusCode: 400 });
  }
  const costPerPortion = accepted > 0 ? roundMoney(productionCost / accepted) : 0;
  const now = new Date();
  const [batch] = await ProductionBatch.create([{
    hotelId,
    propertyId,
    batchNumber,
    idempotencyKey,
    menuItemId: menuItem._id,
    menuItemName: menuItem.name,
    recipeId: recipe._id,
    recipeVersion: recipe.version,
    recipeName: recipe.recipeName,
    servingSize: recipe.servingSize,
    productionMethod,
    productionQuantity: quantity,
    acceptedQuantity: accepted,
    availableQuantity: accepted,
    ingredients: consumedLines,
    productionCost: roundMoney(productionCost),
    rawMaterialWastageCost: roundMoney(rawMaterialWastageCost),
    costPerPortion,
    sellingPrice: Number(menuItem.price) || 0,
    location: String(location).trim() || 'Kitchen Store',
    productionDate: productionAt,
    receivedAt: now,
    expiryDate: expiryAt,
    preparedBy: preparedBy || recordedBy,
    receivedBy: receivedBy || recordedBy,
    notes
  }], { session });
  await PreparedFoodMovement.create([{
    hotelId,
    propertyId,
    productionBatchId: batch._id,
    menuItemId: menuItem._id,
    movementType: 'production_receipt',
    quantity: accepted,
    unitCost: costPerPortion,
    totalCost: roundMoney(accepted * costPerPortion),
    idempotencyKey: idempotencyKey ? `production:${idempotencyKey}:receipt` : undefined,
    location: batch.location,
    recordedBy: recordedBy || null
  }], { session });
  return { batch, duplicate: false };
};

export const recordPreparedFoodUse = async ({
  hotelId, propertyId, productionBatchId, movementType, quantity, reason = '', notes = '', recordedBy,
  idempotencyKey
}, session) => {
  if (!['wastage', 'complimentary', 'staff_consumption', 'transfer_out'].includes(movementType)) {
    throw Object.assign(new Error('Unsupported prepared food use type.'), { statusCode: 400 });
  }
  if (movementType === 'wastage' && !String(reason).trim()) {
    throw Object.assign(new Error('A reason is required when recording prepared food wastage.'), { statusCode: 400 });
  }
  if (idempotencyKey) {
    const existing = await PreparedFoodMovement.findOne({
      hotelId, propertyId, idempotencyKey
    }).session(session);
    if (existing) return { movement: existing, duplicate: true };
  }
  const batch = await ProductionBatch.findOne({
    _id: productionBatchId,
    hotelId,
    propertyId,
    status: 'active'
  }).session(session);
  if (!batch) throw Object.assign(new Error('Active production batch not found.'), { statusCode: 404 });
  return { ...(await recordPreparedFoodMovement({
    batch,
    movementType,
    quantity,
    idempotencyKey,
    recordedBy,
    session,
    reason,
    notes
  })), duplicate: false };
};

export const transferPreparedFood = async ({
  hotelId, propertyId, productionBatchId, quantity, destinationLocation, recordedBy, idempotencyKey, notes = ''
}, session) => {
  const existingMovement = await PreparedFoodMovement.findOne({
    hotelId,
    propertyId,
    idempotencyKey,
    movementType: 'transfer_out'
  }).session(session);
  if (existingMovement) {
    const incoming = await PreparedFoodMovement.findOne({
      hotelId,
      propertyId,
      idempotencyKey: `${idempotencyKey}:in`,
      movementType: 'transfer_in'
    }).session(session);
    const sourceBatch = await ProductionBatch.findOne({ _id: productionBatchId, hotelId, propertyId }).session(session);
    const targetBatch = incoming
      ? await ProductionBatch.findOne({
        _id: incoming.productionBatchId,
        hotelId,
        propertyId
      }).session(session)
      : null;
    return { sourceBatch, targetBatch, duplicate: true };
  }
  const transferQuantity = roundQuantity(Number(quantity));
  const destination = String(destinationLocation || '').trim();
  if (!Number.isFinite(transferQuantity) || transferQuantity <= 0 || !destination) {
    throw Object.assign(new Error('Enter a positive transfer quantity and destination location.'), { statusCode: 400 });
  }
  const sourceBatch = await ProductionBatch.findOne({
    _id: productionBatchId,
    hotelId,
    propertyId,
    status: 'active'
  }).session(session);
  if (!sourceBatch) throw Object.assign(new Error('Active production batch not found.'), { statusCode: 404 });
  if (sourceBatch.location === destination) {
    throw Object.assign(new Error('Choose a destination different from the current batch location.'), { statusCode: 400 });
  }
  const movedSource = await ProductionBatch.findOneAndUpdate({
    _id: sourceBatch._id,
    status: 'active',
    availableQuantity: { $gte: transferQuantity }
  }, {
    $inc: { availableQuantity: -transferQuantity, transferredOutQuantity: transferQuantity }
  }, { new: true, session });
  if (!movedSource) {
    throw Object.assign(new Error(`Insufficient prepared portions in batch ${sourceBatch.batchNumber}.`), { statusCode: 409 });
  }
  const receivedAt = new Date();
  const [targetBatch] = await ProductionBatch.create([{
    hotelId,
    propertyId,
    batchNumber: generateReference('PRD'),
    idempotencyKey: `transfer:${idempotencyKey}`,
    menuItemId: sourceBatch.menuItemId,
    menuItemName: sourceBatch.menuItemName,
    recipeId: sourceBatch.recipeId,
    recipeVersion: sourceBatch.recipeVersion,
    recipeName: sourceBatch.recipeName,
    servingSize: sourceBatch.servingSize,
    productionMethod: sourceBatch.productionMethod,
    productionQuantity: transferQuantity,
    acceptedQuantity: transferQuantity,
    availableQuantity: transferQuantity,
    ingredients: [],
    productionCost: 0,
    costPerPortion: sourceBatch.costPerPortion,
    sellingPrice: sourceBatch.sellingPrice,
    location: destination,
    productionDate: sourceBatch.productionDate,
    receivedAt,
    expiryDate: sourceBatch.expiryDate,
    preparedBy: sourceBatch.preparedBy,
    receivedBy: recordedBy,
    isTransferBatch: true,
    transferredFromBatchId: sourceBatch._id,
    notes: notes || `Transferred from ${sourceBatch.location}.`
  }], { session });
  const unitCost = sourceBatch.costPerPortion;
  const totalCost = roundMoney(transferQuantity * unitCost);
  const movements = await PreparedFoodMovement.create([
    {
      hotelId,
      propertyId,
      productionBatchId: sourceBatch._id,
      menuItemId: sourceBatch.menuItemId,
      movementType: 'transfer_out',
      quantity: transferQuantity,
      unitCost,
      totalCost,
      idempotencyKey,
      reason: notes,
      location: sourceBatch.location,
      destinationLocation: destination,
      recordedBy
    },
    {
      hotelId,
      propertyId,
      productionBatchId: targetBatch._id,
      menuItemId: sourceBatch.menuItemId,
      movementType: 'transfer_in',
      quantity: transferQuantity,
      unitCost,
      totalCost,
      idempotencyKey: `${idempotencyKey}:in`,
      reason: notes,
      location: destination,
      destinationLocation: sourceBatch.location,
      recordedBy
    }
  ], { session, ordered: true });
  return { sourceBatch: movedSource, targetBatch, movements, duplicate: false };
};

const reverseProductionStockMovement = async (movement, batch, recordedBy, session) => {
  const item = await InventoryItem.findOneAndUpdate({
    _id: movement.itemId,
    hotelId: batch.hotelId,
    propertyId: batch.propertyId
  }, { $inc: { currentStock: movement.quantity } }, { new: true, session });
  if (!item) {
    throw Object.assign(new Error('A production ingredient could not be restored because its inventory item is missing.'), { statusCode: 409 });
  }
  const balance = await updateBalance({
    hotelId: batch.hotelId,
    propertyId: batch.propertyId,
    item,
    location: movement.location,
    delta: movement.quantity,
    session
  });
  for (const allocation of movement.batchAllocations || []) {
    if (!allocation.batchId) continue;
    const restoredBatch = await InventoryBatch.findOneAndUpdate({
      _id: allocation.batchId,
      hotelId: batch.hotelId,
      propertyId: batch.propertyId,
      itemId: movement.itemId,
      location: movement.location,
      $expr: { $lte: [{ $add: ['$remainingQuantity', allocation.quantity] }, '$quantity'] }
    }, { $inc: { remainingQuantity: allocation.quantity } }, { new: true, session });
    if (!restoredBatch) {
      throw Object.assign(new Error('A consumed raw-material batch could not be restored safely.'), { statusCode: 409 });
    }
  }
  await StockMovement.create([{
    hotelId: batch.hotelId,
    propertyId: batch.propertyId,
    itemId: movement.itemId,
    movementType: 'sale_reversal',
    quantity: movement.quantity,
    previousStock: roundQuantity(item.currentStock - movement.quantity),
    newStock: item.currentStock,
    unitCost: movement.unitCost,
    totalValue: movement.totalValue,
    referenceNumber: batch.batchNumber,
    notes: `Raw material restored after cancelling production batch ${batch.batchNumber}.`,
    recordedBy,
    location: movement.location,
    department: 'Production',
    idempotencyKey: `production-reversal:${batch._id}:${movement._id}`,
    batchAllocations: movement.batchAllocations,
    metadata: {
      source: 'food_production_reversal',
      reversedMovementId: movement._id,
      locationPreviousStock: balance.previous,
      locationNewStock: balance.current
    }
  }], { session });
  if (item.inventoryType === 'raw_material') {
    await evaluateAutomaticReorder({
      hotelId: batch.hotelId,
      propertyId: batch.propertyId,
      itemId: item._id,
      recordedBy,
      session
    });
  }
};

export const cancelProductionBatch = async ({
  hotelId, propertyId, productionBatchId, recordedBy, idempotencyKey
}, session) => {
  const priorReversal = await PreparedFoodMovement.findOne({
    hotelId,
    propertyId,
    productionBatchId,
    movementType: 'reversal',
    idempotencyKey
  }).session(session);
  const batch = await ProductionBatch.findOne({ _id: productionBatchId, hotelId, propertyId }).session(session);
  if (!batch) throw Object.assign(new Error('Production batch not found.'), { statusCode: 404 });
  if (priorReversal) return { batch, movement: priorReversal, duplicate: true };
  if (batch.status !== 'active') {
    throw Object.assign(new Error('Only active production batches can be cancelled.'), { statusCode: 409 });
  }
  const portionsWereUsed = Number(batch.reservedQuantity || 0) > 0
    || Number(batch.soldQuantity || 0) > 0
    || Number(batch.wastedQuantity || 0) > 0
    || Number(batch.complimentaryQuantity || 0) > 0
    || Number(batch.staffConsumptionQuantity || 0) > 0
    || Number(batch.transferredOutQuantity || 0) > 0
    || Number(batch.availableQuantity) !== Number(batch.acceptedQuantity);
  if (portionsWereUsed) {
    throw Object.assign(new Error('A production batch cannot be cancelled after portions were sold, wasted, consumed, or transferred.'), { statusCode: 409 });
  }
  const stockMovements = [];
  for (const ingredient of batch.ingredients) {
    for (const movementId of [ingredient.movementId, ingredient.wastageMovementId].filter(Boolean)) {
      const movement = await StockMovement.findOne({
        _id: movementId,
        hotelId,
        propertyId,
        'metadata.source': 'food_production'
      }).session(session);
      if (!movement) {
        throw Object.assign(new Error('Production stock history is incomplete; the batch cannot be safely reversed.'), { statusCode: 409 });
      }
      stockMovements.push(movement);
    }
  }
  for (const movement of stockMovements) {
    await reverseProductionStockMovement(movement, batch, recordedBy, session);
  }
  batch.status = 'cancelled';
  batch.availableQuantity = 0;
  await batch.save({ session });
  const [reversal] = await PreparedFoodMovement.create([{
    hotelId,
    propertyId,
    productionBatchId: batch._id,
    menuItemId: batch.menuItemId,
    movementType: 'reversal',
    quantity: batch.acceptedQuantity,
    unitCost: batch.costPerPortion,
    totalCost: roundMoney(batch.productionCost + batch.rawMaterialWastageCost),
    idempotencyKey,
    reason: 'Production cancelled before prepared portions were used.',
    location: batch.location,
    recordedBy
  }], { session });
  return { batch, movement: reversal, duplicate: false };
};

export const reservePreparedFoodForOrder = async (
  order, session, recordedBy = order.createdBy, startLineIndex = 0
) => {
  const menuItemIds = [...new Set(order.items.map((line) => String(line.menuItemId)))];
  const recipes = await InventoryRecipe.find({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    menuItemId: { $in: menuItemIds },
    isActive: true,
    productionMode: 'batch_production'
  }).sort({ version: -1 }).session(session);
  const batchRecipeIds = new Set(recipes.map((recipe) => String(recipe.menuItemId)));
  for (const [orderLineIndex, orderLine] of order.items.entries()) {
    if (orderLineIndex < startLineIndex
      || (orderLine.fulfillmentSource !== 'batch_production'
        && !batchRecipeIds.has(String(orderLine.menuItemId)))) continue;
    const alreadyAllocated = (order.preparedFoodAllocations || [])
      .filter((allocation) => allocation.orderLineIndex === orderLineIndex)
      .reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0);
    let remaining = roundQuantity(Number(orderLine.quantity) - alreadyAllocated);
    if (remaining <= 0) continue;
    const eligibleBatches = await ProductionBatch.find({
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      menuItemId: orderLine.menuItemId,
      status: 'active',
      availableQuantity: { $gt: 0 },
      $or: [{ expiryDate: null }, { expiryDate: { $gt: new Date() } }]
    }).session(session);
    eligibleBatches.sort((left, right) => {
      const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      return leftExpiry - rightExpiry
        || new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime()
        || String(left._id).localeCompare(String(right._id));
    });
    const totalAvailable = eligibleBatches.reduce((sum, batch) => sum + batch.availableQuantity, 0);
    if (totalAvailable < remaining) {
      throw Object.assign(new Error(
        `Insufficient bulk-production portions of ${orderLine.name}. Available: ${totalAvailable}; requested: ${remaining}.`
      ), { statusCode: 409 });
    }
    for (const batch of eligibleBatches) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, batch.availableQuantity);
      const reservedBatch = await ProductionBatch.findOneAndUpdate({
        _id: batch._id,
        hotelId: order.hotelId,
        propertyId: order.propertyId,
        status: 'active',
        availableQuantity: { $gte: quantity }
      }, {
        $inc: { availableQuantity: -quantity, reservedQuantity: quantity }
      }, { new: true, session });
      if (!reservedBatch) {
        throw Object.assign(new Error(
          `Bulk-production portions of ${orderLine.name} were just reserved by another order. Refresh and retry.`
        ), { statusCode: 409 });
      }
      await PreparedFoodMovement.create([{
        hotelId: batch.hotelId,
        propertyId: batch.propertyId,
        productionBatchId: batch._id,
        menuItemId: batch.menuItemId,
        movementType: 'reservation',
        quantity,
        orderId: order._id,
        orderNumber: order.orderNumber,
        orderLineIndex,
        idempotencyKey: `prepared-food-reservation:${order._id}:${orderLineIndex}:${batch._id}`,
        reason: 'Prepared portion reserved for a restaurant order.',
        location: batch.location,
        recordedBy
      }], { session });
      order.preparedFoodAllocations.push({
        menuItemId: orderLine.menuItemId,
        productionBatchId: batch._id,
        quantity,
        orderLineIndex,
        status: 'reserved'
      });
      remaining = roundQuantity(remaining - quantity);
    }
  }
  if ((order.preparedFoodAllocations || []).some((allocation) => allocation.status === 'reserved')) {
    order.preparedFoodReservedAt ||= new Date();
  }
  return order.preparedFoodAllocations || [];
};

export const releasePreparedFoodReservationsForOrder = async (order, session, recordedBy = order.createdBy) => {
  for (const [allocationIndex, allocation] of (order.preparedFoodAllocations || []).entries()) {
    if (!['reserved', 'sold'].includes(allocation.status)) continue;
    const wasSold = allocation.status === 'sold';
    const batch = await ProductionBatch.findOneAndUpdate({
      _id: allocation.productionBatchId,
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      status: 'active',
      [wasSold ? 'soldQuantity' : 'reservedQuantity']: { $gte: allocation.quantity }
    }, {
      $inc: {
        [wasSold ? 'soldQuantity' : 'reservedQuantity']: -allocation.quantity,
        availableQuantity: allocation.quantity
      }
    }, { new: true, session });
    if (!batch) {
      throw Object.assign(new Error('A prepared-food portion could not be restored safely.'), { statusCode: 409 });
    }
    await PreparedFoodMovement.create([{
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      productionBatchId: allocation.productionBatchId,
      menuItemId: allocation.menuItemId,
      movementType: wasSold ? 'sale_reversal' : 'reservation_release',
      quantity: allocation.quantity,
      unitCost: wasSold ? batch.costPerPortion : 0,
      totalCost: wasSold ? roundMoney(allocation.quantity * batch.costPerPortion) : 0,
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderLineIndex: allocation.orderLineIndex,
      idempotencyKey: `prepared-food-order-reversal:${order._id}:${allocationIndex}`,
      reason: wasSold
        ? 'Previously served prepared portion restored after order cancellation.'
        : 'Prepared portion reservation released after order cancellation.',
      location: batch.location,
      recordedBy
    }], { session });
    allocation.status = wasSold ? 'reversed' : 'released';
  }
};

export const consumePreparedFoodForOrder = async (order, session, recordedBy = order.createdBy) => {
  if (order.preparedFoodDeductedAt) return order.preparedFoodAllocations || [];
  if (!(order.preparedFoodAllocations || []).some((allocation) => allocation.status === 'reserved')) {
    await reservePreparedFoodForOrder(order, session, recordedBy);
  }
  for (const [allocationIndex, allocation] of (order.preparedFoodAllocations || []).entries()) {
    if (allocation.status !== 'reserved') continue;
    const batch = await ProductionBatch.findOneAndUpdate({
      _id: allocation.productionBatchId,
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      status: 'active',
      reservedQuantity: { $gte: allocation.quantity }
    }, {
      $inc: { reservedQuantity: -allocation.quantity, soldQuantity: allocation.quantity }
    }, { new: true, session });
    if (!batch) {
      throw Object.assign(new Error('A reserved prepared-food portion could not be marked as sold safely.'), { statusCode: 409 });
    }
    await PreparedFoodMovement.create([{
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      productionBatchId: allocation.productionBatchId,
      menuItemId: allocation.menuItemId,
      movementType: 'sale',
      quantity: allocation.quantity,
      unitCost: batch.costPerPortion,
      totalCost: roundMoney(allocation.quantity * batch.costPerPortion),
      salesRevenue: 0,
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderLineIndex: allocation.orderLineIndex,
      idempotencyKey: `prepared-food-sale:${order._id}:${allocationIndex}:${allocation.productionBatchId}`,
      reason: 'Reserved prepared portions served to the restaurant order.',
      location: batch.location,
      recordedBy
    }], { session });
    allocation.status = 'sold';
  }
  order.preparedFoodDeductedAt = new Date();
  return order.preparedFoodAllocations || [];
};

export const evaluateAutomaticReorder = async ({
  hotelId, propertyId, itemId, recordedBy = null, session
}) => {
  const item = await InventoryItem.findOne({
    _id: itemId,
    hotelId,
    propertyId,
    isActive: true,
    inventoryType: 'raw_material'
  }).session(session);
  if (!item) return null;

  const reorderLevel = Number(item.reorderLevel) > 0
    ? Number(item.reorderLevel)
    : Number(item.minStockThreshold || 0);
  if (reorderLevel <= 0) return null;

  const expiredBatches = await InventoryBatch.find({
    hotelId,
    propertyId,
    itemId: item._id,
    expiryDate: { $lte: new Date() },
    remainingQuantity: { $gt: 0 }
  }).select('remainingQuantity').session(session).lean();
  const openOrders = await PurchaseOrder.find({
    hotelId,
    propertyId,
    status: { $in: OPEN_PURCHASE_ORDER_STATUSES },
    'items.itemId': item._id
  }).select('items autoReorderItemId').session(session).lean();
  const currentAutoOrder = await PurchaseOrder.findOne({
    hotelId,
    propertyId,
    autoReorderItemId: item._id,
    status: 'draft'
  }).session(session);
  const expiredQuantity = expiredBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
  const availableStock = Math.max(0, Number(item.currentStock || 0) - expiredQuantity);
  const pendingPurchaseQuantity = openOrders.reduce((sum, order) => {
    if (currentAutoOrder && String(order._id) === String(currentAutoOrder._id)) return sum;
    return sum + order.items.reduce((lineTotal, line) => (
      String(line.itemId) === String(item._id)
        ? lineTotal + Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0))
          * Number(line.conversionFactor || 1)
        : lineTotal
    ), 0);
  }, 0);
  const targetStock = Math.max(
    reorderLevel,
    Number(item.maxStockLevel) > 0
      ? Number(item.maxStockLevel)
      : Number(item.reorderQuantity || 0)
  );
  const neededBaseQuantity = Math.max(0, targetStock - availableStock - pendingPurchaseQuantity);

  if (availableStock > reorderLevel || neededBaseQuantity <= 0) {
    if (currentAutoOrder) {
      currentAutoOrder.status = 'cancelled';
      currentAutoOrder.autoReorderItemId = null;
      currentAutoOrder.notes = `${currentAutoOrder.notes || ''}\nAutomatically cancelled after stock was re-evaluated.`.trim();
      await currentAutoOrder.save({ session });
    }
    return null;
  }

  const activeSupportedUnits = (item.supportedUnits || []).filter((unit) => unit.isActive !== false);
  const preferredUnitId = String(item.preferredPurchaseUnitId || item.purchaseUnitId || '');
  const configuredPurchaseUnit = activeSupportedUnits.find((unit) => (
    unit.isActive !== false
    && String(unit.unitId?._id || unit.unitId || '') === preferredUnitId
    && unit.isDefaultPurchaseUnit
  )) || activeSupportedUnits.find((unit) => (
    String(unit.unitId?._id || unit.unitId || '') === preferredUnitId
  )) || activeSupportedUnits.find((unit) => unit.isDefaultPurchaseUnit);
  const purchaseUnit = configuredPurchaseUnit?.unitSymbolSnapshot
    || item.purchaseUnit
    || item.baseUnit
    || item.unit;
  const conversionFactor = Number(configuredPurchaseUnit?.conversionFactorToBase)
    || Number(item.purchaseConversionFactor)
    || 1;
  const packageConfigured = Number(configuredPurchaseUnit?.packageSize) > 0
    && Boolean(configuredPurchaseUnit?.packageMeasurementUnitId);
  const purchaseQuantity = packageConfigured
    ? Math.ceil(neededBaseQuantity / conversionFactor)
    : roundQuantity(neededBaseQuantity / conversionFactor);
  const unitCost = Number(item.purchasePrice ?? (Number(item.unitCost || 0) * conversionFactor));
  const totalAmount = round(purchaseQuantity * unitCost);
  const line = {
    itemId: item._id,
    itemName: item.name,
    quantity: purchaseQuantity,
    receivedQuantity: 0,
    unit: purchaseUnit,
    unitId: configuredPurchaseUnit?.unitId?._id || configuredPurchaseUnit?.unitId || item.preferredPurchaseUnitId || item.purchaseUnitId || null,
    purchasePackageId: packageConfigured ? configuredPurchaseUnit._id : null,
    packageNameSnapshot: packageConfigured ? configuredPurchaseUnit.packageName || configuredPurchaseUnit.unitNameSnapshot : '',
    unitNameSnapshot: packageConfigured
      ? configuredPurchaseUnit.packageName || configuredPurchaseUnit.unitNameSnapshot
      : configuredPurchaseUnit?.unitNameSnapshot || purchaseUnit,
    unitSymbolSnapshot: purchaseUnit,
    conversionFactor,
    baseUnit: item.baseUnit || item.unit,
    baseUnitId: item.baseUnitId || null,
    baseUnitNameSnapshot: item.baseUnit || item.unit,
    baseUnitSymbolSnapshot: item.baseUnit || item.unit,
    unitCost,
    totalAmount
  };
  const preferredVendor = item.vendorId
    ? await Vendor.findOne({ _id: item.vendorId, hotelId, status: 'active' }).select('_id').session(session)
    : await Vendor.findOne({
      hotelId,
      status: 'active',
      suppliedItems: item._id
    }).select('_id').session(session);
  const poNumber = generateReference('PO');
  const update = {
    $set: {
      ...(preferredVendor ? { vendorId: preferredVendor._id } : {}),
      items: [line],
      subtotal: totalAmount,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount,
      notes: 'Automatically generated from the reorder level. Pending manager review.',
      autoGenerated: true
    },
    $setOnInsert: {
      hotelId,
      propertyId,
      poNumber,
      autoReorderItemId: item._id,
      createdBy: recordedBy,
      department: ''
    }
  };
  if (!preferredVendor) update.$unset = { vendorId: 1 };
  const po = await PurchaseOrder.findOneAndUpdate({
    hotelId,
    propertyId,
    autoReorderItemId: item._id,
    status: 'draft'
  }, update, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
    session
  });
  return po;
};
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
    if (item.trackExpiry || hasExpiryBatches || movementType === 'expiry') {
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

  if (item.inventoryType === 'raw_material') {
    await evaluateAutomaticReorder({
      hotelId,
      propertyId,
      itemId: item._id,
      recordedBy,
      session
    });
  }

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
  transferMode = 'location', fromDepartment = '', toDepartment = '',
  recordedBy, referenceNumber, idempotencyKey, notes = '', session
}) => {
  let sourceLocation = fromLocation;
  let destinationLocation = toLocation;
  let sourceDepartment = '';
  let destinationDepartment = '';
  if (transferMode === 'department') {
    sourceDepartment = String(fromDepartment || '').trim();
    destinationDepartment = String(toDepartment || '').trim();
    sourceLocation = DEPARTMENT_STOCK_LOCATIONS[sourceDepartment];
    destinationLocation = DEPARTMENT_STOCK_LOCATIONS[destinationDepartment];
    if (!sourceLocation || !destinationLocation) {
      throw Object.assign(new Error('Choose a valid source and destination department.'), { statusCode: 400 });
    }
    if (sourceDepartment === destinationDepartment) {
      throw Object.assign(new Error('Choose two different departments for the transfer.'), { statusCode: 400 });
    }
  } else if (transferMode !== 'location') {
    throw Object.assign(new Error('Transfer type must be location or department.'), { statusCode: 400 });
  }
  const enteredQuantity = Number(quantity);
  if (!Number.isFinite(enteredQuantity) || enteredQuantity <= 0
    || !sourceLocation || !destinationLocation || sourceLocation === destinationLocation) {
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
    hotelId, propertyId, itemId: item._id, location: sourceLocation, remainingQuantity: { $gt: 0 }
  }).sort({ receivedAt: 1, _id: 1 }).session(session);
  const now = new Date();
  const hasExpiryBatches = allSourceBatches.some((batch) => Boolean(batch.expiryDate));
  const sourceBatches = item.trackExpiry || hasExpiryBatches
    ? allSourceBatches.filter((batch) => !batch.expiryDate || batch.expiryDate > now)
    : allSourceBatches;
  const sourceBatchQuantity = sourceBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
  if ((item.trackExpiry || item.trackBatchNumber || hasExpiryBatches) && sourceBatchQuantity < qty) {
    throw Object.assign(new Error(`Insufficient tracked stock at ${sourceLocation} for ${item.name}.`), { statusCode: 409 });
  }
  const source = await updateBalance({
    hotelId, propertyId, item, location: sourceLocation, delta: -qty, session
  });
  const destination = await updateBalance({
    hotelId, propertyId, item, location: destinationLocation, delta: qty, session
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
      location: destinationLocation,
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
    notes, recordedBy,
    sourceDepartment,
    destinationDepartment,
    department: transferMode === 'department' ? '' : department,
    metadata: {
      fromLocation: sourceLocation,
      toLocation: destinationLocation,
      ...(transferMode === 'department' ? { sourceDepartment, destinationDepartment } : {})
    }
  };
  const movements = await StockMovement.create([
    {
      ...common,
      location: sourceLocation,
      department: transferMode === 'department' ? sourceDepartment : department,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:out` : undefined,
      metadata: { ...common.metadata, locationPreviousStock: source.previous, locationNewStock: source.current }
    },
    {
      ...common,
      location: destinationLocation,
      destinationLocation,
      department: transferMode === 'department' ? destinationDepartment : department,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:in` : undefined,
      metadata: { ...common.metadata, locationPreviousStock: destination.previous, locationNewStock: destination.current }
    }
  ], { session, ordered: true });
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
    if (!recipe || recipe.productionMode === 'batch_production') continue;
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
    if (item.inventoryType === 'raw_material') {
      await evaluateAutomaticReorder({
        hotelId: order.hotelId,
        propertyId: order.propertyId,
        itemId: movement.itemId,
        recordedBy,
        session
      });
    }
  }

  consumption.status = 'reversed';
  consumption.reversedAt = new Date();
  await consumption.save({ session });
  return consumption;
};
