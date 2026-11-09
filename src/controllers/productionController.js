import mongoose from 'mongoose';
import { logAudit } from '../services/auditService.js';
import {
  cancelProductionBatch, createProductionBatch, recordPreparedFoodUse, runInventoryTransaction,
  transferPreparedFood
} from '../services/inventoryService.js';
import { PreparedFoodMovement, ProductionBatch, Property } from '../models/index.js';

const isAllowed = (req, res) => {
  if (['hotel_admin', 'restaurant_staff', 'super_admin'].includes(req.user?.role)) return true;
  res.status(403).json({ success: false, message: 'Restaurant production access is required.' });
  return false;
};

const tenantFilter = (req) => ({ hotelId: req.hotelId, propertyId: req.propertyId });
const resolvePropertyId = async (req, res) => {
  const propertyId = req.user?.role === 'super_admin'
    ? req.query.propertyId || req.body?.propertyId || req.propertyId
    : req.propertyId || req.user?.propertyId;
  if (!mongoose.isValidObjectId(propertyId)) {
    res.status(400).json({ success: false, message: 'A valid property is required for food production.' });
    return null;
  }
  const property = await Property.findOne({
    _id: propertyId,
    hotelId: req.hotelId,
    status: 'active'
  }).select('_id').lean();
  if (!property) {
    res.status(404).json({ success: false, message: 'The production property was not found or is inactive.' });
    return null;
  }
  req.propertyId = property._id;
  return property._id;
};
const redactProductionCosts = (batch, user) => {
  if (!batch) return batch;
  const result = batch?.toObject ? batch.toObject() : { ...batch };
  if (!['hotel_admin', 'super_admin'].includes(user?.role)) {
    for (const field of ['productionCost', 'rawMaterialWastageCost', 'costPerPortion', 'sellingPrice', 'ingredients']) {
      delete result[field];
    }
  }
  return result;
};

export const getProductionDashboard = async (req, res, next) => {
  try {
    if (!isAllowed(req, res)) return;
    if (!await resolvePropertyId(req, res)) return;
    const filter = { ...tenantFilter(req), status: 'active' };
    if (req.query.menuItemId) {
      if (!mongoose.isValidObjectId(req.query.menuItemId)) {
        return res.status(400).json({ success: false, message: 'Menu item ID is invalid.' });
      }
      filter.menuItemId = req.query.menuItemId;
    }
    if (req.query.location) filter.location = String(req.query.location).trim();
    if (req.query.productionBatchId) {
      if (!mongoose.isValidObjectId(req.query.productionBatchId)) {
        return res.status(400).json({ success: false, message: 'Production batch ID is invalid.' });
      }
      filter._id = req.query.productionBatchId;
    }
    if (req.query.from || req.query.to) {
      filter.productionDate = {};
      if (req.query.from) {
        const from = new Date(req.query.from);
        if (Number.isNaN(from.getTime())) return res.status(400).json({ success: false, message: 'Invalid start date.' });
        filter.productionDate.$gte = from;
      }
      if (req.query.to) {
        const to = new Date(req.query.to);
        if (Number.isNaN(to.getTime())) return res.status(400).json({ success: false, message: 'Invalid end date.' });
        to.setHours(23, 59, 59, 999);
        filter.productionDate.$lte = to;
      }
    }
    const batches = await ProductionBatch.find(filter)
      .populate('preparedBy receivedBy', 'name')
      .sort({ productionDate: -1, createdAt: -1 })
      .limit(Math.min(500, Math.max(1, Number(req.query.limit) || 200)))
      .lean();
    const salesSummary = batches.length ? await PreparedFoodMovement.aggregate([
      {
        $match: {
          ...tenantFilter(req),
          productionBatchId: { $in: batches.map((batch) => batch._id) },
          movementType: 'sale'
        }
      },
      { $group: { _id: '$productionBatchId', salesRevenue: { $sum: '$salesRevenue' } } }
    ]) : [];
    const movementSummary = new Map(salesSummary.map((entry) => [
      String(entry._id),
      { salesRevenue: Number(entry.salesRevenue || 0) }
    ]));
    const data = batches.map((batch) => {
      const salesRevenue = Math.round((movementSummary.get(String(batch._id))?.salesRevenue || 0) * 100) / 100;
      const soldFoodCost = Math.round(Number(batch.soldQuantity || 0) * Number(batch.costPerPortion || 0) * 100) / 100;
      const result = {
        ...batch,
        remainingQuantity: batch.availableQuantity
      };
      if (['hotel_admin', 'super_admin'].includes(req.user?.role)) {
        Object.assign(result, {
          salesRevenue,
          soldFoodCost,
          grossProfit: Math.round((salesRevenue - soldFoodCost) * 100) / 100,
          wastageCost: Math.round(Number(batch.wastedQuantity || 0) * Number(batch.costPerPortion || 0) * 100) / 100,
          complimentaryCost: Math.round(Number(batch.complimentaryQuantity || 0) * Number(batch.costPerPortion || 0) * 100) / 100,
          staffConsumptionCost: Math.round(Number(batch.staffConsumptionQuantity || 0) * Number(batch.costPerPortion || 0) * 100) / 100,
          remainingInventoryValue: Math.round(Number(batch.availableQuantity || 0) * Number(batch.costPerPortion || 0) * 100) / 100
        });
      } else {
        delete result.productionCost;
        delete result.rawMaterialWastageCost;
        delete result.costPerPortion;
        delete result.sellingPrice;
        delete result.ingredients;
      }
      return result;
    });
    const totals = data.reduce((result, batch) => {
      for (const field of [
        'productionQuantity', 'acceptedQuantity', 'availableQuantity', 'reservedQuantity', 'remainingQuantity',
        'soldQuantity', 'wastedQuantity', 'complimentaryQuantity', 'staffConsumptionQuantity', 'transferredOutQuantity',
        'productionCost', 'rawMaterialWastageCost', 'salesRevenue', 'soldFoodCost', 'grossProfit',
        'wastageCost', 'complimentaryCost', 'staffConsumptionCost', 'remainingInventoryValue'
      ]) {
        if (batch.isTransferBatch && [
          'productionQuantity', 'acceptedQuantity', 'productionCost', 'rawMaterialWastageCost'
        ].includes(field)) continue;
        result[field] = (result[field] || 0) + Number(batch[field] || 0);
      }
      return result;
    }, {});
    for (const [field, value] of Object.entries(totals)) totals[field] = Math.round(value * 100) / 100;
    if (['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      totals.wastagePercent = totals.acceptedQuantity > 0
        ? Math.round((totals.wastedQuantity / totals.acceptedQuantity) * 10000) / 100
        : 0;
      totals.foodCostPercent = totals.salesRevenue > 0
        ? Math.round((totals.soldFoodCost / totals.salesRevenue) * 10000) / 100
        : 0;
      totals.rawMaterialWastagePercent = totals.productionCost > 0
        ? Math.round((totals.rawMaterialWastageCost / totals.productionCost) * 10000) / 100
        : 0;
    } else {
      for (const field of [
        'productionCost', 'rawMaterialWastageCost', 'salesRevenue', 'soldFoodCost', 'grossProfit',
        'wastageCost', 'complimentaryCost', 'staffConsumptionCost', 'remainingInventoryValue'
      ]) delete totals[field];
    }
    const selectedBatchIds = batches.map((batch) => batch._id);
    let movementQuery = PreparedFoodMovement.find({
      ...tenantFilter(req),
      productionBatchId: { $in: selectedBatchIds }
    });
    if (!['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      movementQuery = movementQuery.select('-salesRevenue -unitCost -totalCost');
    }
    const recentMovements = await movementQuery.populate('recordedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, data: { batches: data, totals, movements: recentMovements } });
  } catch (error) {
    next(error);
  }
};

export const createProductionEntry = async (req, res, next) => {
  try {
    if (!isAllowed(req, res)) return;
    const propertyId = await resolvePropertyId(req, res);
    if (!propertyId) return;
    const idempotencyKey = String(req.body.idempotencyKey || req.get('Idempotency-Key') || '');
    if (!idempotencyKey.trim()) {
      return res.status(400).json({ success: false, message: 'A production request key is required to prevent duplicate stock deductions.' });
    }
    if (idempotencyKey.length > 120) {
      return res.status(400).json({ success: false, message: 'Production request key is too long.' });
    }
    const result = await runInventoryTransaction((session) => createProductionBatch({
      ...req.body,
      hotelId: req.hotelId,
      propertyId,
      recordedBy: req.user._id,
      preparedBy: req.body.preparedBy || req.user._id,
      receivedBy: req.body.receivedBy || req.user._id,
      idempotencyKey
    }, session));
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'CREATE_FOOD_PRODUCTION_BATCH',
        entity: 'ProductionBatch',
        entityId: result.batch._id,
        details: {
          batchNumber: result.batch.batchNumber,
          menuItemId: String(result.batch.menuItemId),
          productionQuantity: result.batch.productionQuantity,
          acceptedQuantity: result.batch.acceptedQuantity,
          productionCost: result.batch.productionCost
        },
        req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      data: { ...result, batch: redactProductionCosts(result.batch, req.user) }
    });
  } catch (error) {
    next(error);
  }
};

export const recordPreparedFoodMovement = async (req, res, next) => {
  try {
    if (!isAllowed(req, res)) return;
    const propertyId = await resolvePropertyId(req, res);
    if (!propertyId) return;
    const { movementType, quantity, reason = '', notes = '' } = req.body;
    const idempotencyKey = String(req.body.idempotencyKey || req.get('Idempotency-Key') || '');
    if (!idempotencyKey.trim()) {
      return res.status(400).json({ success: false, message: 'A movement request key is required to prevent duplicate stock updates.' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Production batch ID is invalid.' });
    }
    if (idempotencyKey.length > 120) {
      return res.status(400).json({ success: false, message: 'Prepared-food movement key is too long.' });
    }
    const result = await runInventoryTransaction((session) => recordPreparedFoodUse({
      hotelId: req.hotelId,
      propertyId,
      productionBatchId: req.params.id,
      movementType,
      quantity,
      reason,
      notes,
      recordedBy: req.user._id,
      idempotencyKey
    }, session));
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: movementType === 'wastage' ? 'RECORD_PREPARED_FOOD_WASTAGE' : 'RECORD_PREPARED_FOOD_USE',
        entity: 'PreparedFoodMovement',
        entityId: result.movement._id,
        details: { productionBatchId: req.params.id, movementType, quantity: result.movement.quantity, reason },
        req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      data: { ...result, batch: redactProductionCosts(result.batch, req.user) }
    });
  } catch (error) {
    next(error);
  }
};

export const transferProductionBatch = async (req, res, next) => {
  try {
    if (!isAllowed(req, res)) return;
    const propertyId = await resolvePropertyId(req, res);
    if (!propertyId) return;
    const idempotencyKey = String(req.body.idempotencyKey || req.get('Idempotency-Key') || '');
    if (!idempotencyKey.trim()) {
      return res.status(400).json({ success: false, message: 'A transfer request key is required to prevent duplicate stock movement.' });
    }
    if (idempotencyKey.length > 120 || !mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'The transfer request key or production batch ID is invalid.' });
    }
    const result = await runInventoryTransaction((session) => transferPreparedFood({
      hotelId: req.hotelId,
      propertyId,
      productionBatchId: req.params.id,
      quantity: req.body.quantity,
      destinationLocation: req.body.destinationLocation,
      notes: req.body.notes || '',
      recordedBy: req.user._id,
      idempotencyKey
    }, session));
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'TRANSFER_PREPARED_FOOD_BATCH',
        entity: 'ProductionBatch',
        entityId: result.targetBatch._id,
        details: {
          sourceBatchId: req.params.id,
          targetBatchNumber: result.targetBatch.batchNumber,
          quantity: result.targetBatch.acceptedQuantity,
          destinationLocation: result.targetBatch.location
        },
        req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      data: {
        ...result,
        sourceBatch: redactProductionCosts(result.sourceBatch, req.user),
        targetBatch: redactProductionCosts(result.targetBatch, req.user)
      }
    });
  } catch (error) {
    next(error);
  }
};

export const cancelProductionEntry = async (req, res, next) => {
  try {
    if (!['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can cancel production batches.' });
    }
    const propertyId = await resolvePropertyId(req, res);
    if (!propertyId) return;
    const idempotencyKey = String(req.body.idempotencyKey || req.get('Idempotency-Key') || '');
    if (!idempotencyKey.trim()) {
      return res.status(400).json({ success: false, message: 'A cancellation request key is required to prevent duplicate reversals.' });
    }
    if (idempotencyKey.length > 120 || !mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'The cancellation request key or production batch ID is invalid.' });
    }
    const result = await runInventoryTransaction((session) => cancelProductionBatch({
      hotelId: req.hotelId,
      propertyId,
      productionBatchId: req.params.id,
      recordedBy: req.user._id,
      idempotencyKey
    }, session));
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'CANCEL_FOOD_PRODUCTION_BATCH',
        entity: 'ProductionBatch',
        entityId: req.params.id,
        details: { batchNumber: result.batch.batchNumber, restoredCost: result.movement.totalCost },
        req
      });
    }
    res.status(200).json({
      success: true,
      data: { ...result, batch: redactProductionCosts(result.batch, req.user) }
    });
  } catch (error) {
    next(error);
  }
};
