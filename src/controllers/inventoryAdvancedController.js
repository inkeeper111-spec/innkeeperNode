import mongoose from 'mongoose';
import {
  DepartmentRequest, GoodsReceipt, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, InventorySettings,
  StockAdjustment, StockVerification, MinibarStock, MinibarTransaction, PurchaseOrder, RecipeConsumption,
  StockMovement, Room, Reservation, Invoice
} from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { postStockMovement, runInventoryTransaction, transferStock } from '../services/inventoryService.js';
import { convertQuantityToBase, getUnitConversionFactor, normalizeInventoryUnit } from '../config/inventoryUnits.js';

const adminOnly = (req, res) => {
  if (['hotel_admin', 'super_admin'].includes(req.user?.role)) return true;
  res.status(403).json({ success: false, message: 'Hotel administrator approval is required.' });
  return false;
};

const tenantFilter = (req) => ({
  hotelId: req.hotelId,
  ...(req.propertyId ? { propertyId: req.propertyId } : {})
});

const dateFilter = (query) => {
  const filter = {};
  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) throw Object.assign(new Error('Invalid start date.'), { statusCode: 400 });
    filter.$gte = from;
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) throw Object.assign(new Error('Invalid end date.'), { statusCode: 400 });
    to.setHours(23, 59, 59, 999);
    filter.$lte = to;
  }
  return Object.keys(filter).length ? filter : undefined;
};

export const getInventoryDashboard = async (req, res, next) => {
  try {
    const scope = tenantFilter(req);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const expiryEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const [items, expiredBatches, batchValues, pendingOrders, monthPurchases, recent, expiring, monthlyPurchases, departmentUse, monthlyCosts] = await Promise.all([
      InventoryItem.find({ ...scope, isActive: true })
        .select('name currentStock minStockThreshold unitCost unit baseUnit stockVerificationIntervalDays createdAt')
        .lean(),
      InventoryBatch.aggregate([
        { $match: { ...scope, expiryDate: { $lte: now }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ]),
      InventoryBatch.aggregate([
        { $match: { ...scope, remainingQuantity: { $gt: 0 } } },
        { $group: {
          _id: '$itemId',
          quantity: { $sum: '$remainingQuantity' },
          value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
        } }
      ]),
      PurchaseOrder.countDocuments({ ...scope, status: { $in: ['pending_approval', 'approved', 'ordered', 'partially_received'] } }),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: 'receipt' } },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: monthStart, $lt: nextMonth } } },
        { $group: { _id: null, total: { $sum: '$totalValue' }, count: { $sum: 1 } } }
      ]),
      StockMovement.find(scope).populate('itemId', 'name unit').populate('recordedBy', 'name')
        .sort({ createdAt: -1 }).limit(8).lean(),
      GoodsReceipt.aggregate([
        { $match: { ...scope, 'lines.expiryDate': { $gte: now, $lte: expiryEnd } } },
        { $unwind: '$lines' },
        { $match: { 'lines.expiryDate': { $gte: now, $lte: expiryEnd }, 'lines.acceptedQuantity': { $gt: 0 } } },
        { $lookup: { from: 'inventoryitems', localField: 'lines.itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        { $project: { _id: 0, item: '$item.name', batchNumber: '$lines.batchNumber', expiryDate: '$lines.expiryDate', quantity: '$lines.acceptedQuantity' } },
        { $sort: { expiryDate: 1 } },
        { $limit: 10 }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: 'receipt' } },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) } } },
        { $group: { _id: { year: { $year: '$effectiveDate' }, month: { $month: '$effectiveDate' } }, total: { $sum: '$totalValue' } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: { $in: ['issue', 'department_issue', 'recipe_consumption', 'wastage', 'expiry'] } } },
        { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, quantity: { $sum: '$quantity' }, expense: { $sum: '$totalValue' } } },
        { $sort: { expense: -1 } }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: { $in: ['receipt', 'issue', 'department_issue', 'recipe_consumption', 'wastage', 'expiry'] } } },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: monthStart, $lt: nextMonth } } },
        { $group: { _id: '$movementType', total: { $sum: '$totalValue' } } }
      ])
    ]);
    const [settings, latestVerifications] = await Promise.all([
      InventorySettings.findOne(scope).lean(),
      StockVerification.aggregate([
        { $match: scope },
        { $sort: { verifiedAt: -1 } },
        { $group: { _id: '$itemId', verifiedAt: { $first: '$verifiedAt' } } }
      ])
    ]);

    const expiredByItem = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    const batchValueByItem = new Map(batchValues.map((batch) => [String(batch._id), batch]));
    const verifiedAtByItem = new Map(latestVerifications.map((entry) => [String(entry._id), entry.verifiedAt]));
    const monthlyCostByType = Object.fromEntries(monthlyCosts.map(({ _id, total }) => [_id, total]));
    const pendingVerifications = items.filter((item) => {
      const lastVerified = verifiedAtByItem.get(String(item._id)) || item.createdAt;
      const intervalDays = item.stockVerificationIntervalDays || settings?.verificationIntervalDays || 1;
      return !lastVerified || now.getTime() - new Date(lastVerified).getTime() >= intervalDays * 86400000;
    }).map((item) => ({
      _id: item._id,
      name: item.name,
      unit: item.baseUnit || item.unit,
      currentStock: item.currentStock,
      createdAt: item.createdAt,
      lastVerifiedAt: verifiedAtByItem.get(String(item._id)) || null
    }));
    const availableByItem = items.map((item) => ({
      ...item,
      available: Math.max(0, item.currentStock - (expiredByItem.get(String(item._id)) || 0))
    }));
    res.json({
      success: true,
      data: {
        totalItems: items.length,
        totalStockValue: items.reduce((sum, item) => {
          const batch = batchValueByItem.get(String(item._id));
          const unbatchedQuantity = Math.max(0, item.currentStock - (batch?.quantity || 0));
          return sum + (batch?.value || 0) + unbatchedQuantity * item.unitCost;
        }, 0),
        availableStock: availableByItem.reduce((sum, item) => sum + item.available, 0),
        lowStockItems: availableByItem.filter((item) => item.available > 0 && item.available <= item.minStockThreshold).length,
        outOfStockItems: availableByItem.filter((item) => item.available <= 0).length,
        pendingPurchaseOrders: pendingOrders,
        purchasesThisMonth: monthPurchases[0]?.total || 0,
        consumptionCostThisMonth: ['issue', 'department_issue', 'recipe_consumption']
          .reduce((sum, type) => sum + (monthlyCostByType[type] || 0), 0),
        wastageCostThisMonth: (monthlyCostByType.wastage || 0) + (monthlyCostByType.expiry || 0),
        purchaseCountThisMonth: monthPurchases[0]?.count || 0,
        pendingStockVerifications: pendingVerifications.length,
        pendingVerificationItems: pendingVerifications,
        verificationIntervalDays: settings?.verificationIntervalDays || 1,
        monthlyPurchases,
        departmentConsumption: departmentUse,
        recentActivities: recent,
        expiringProducts: expiring
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getInventorySettings = async (req, res, next) => {
  try {
    const settings = await InventorySettings.findOne(tenantFilter(req)).lean();
    res.json({
      success: true,
      data: settings || {
        verificationIntervalDays: 1,
        hotelId: req.hotelId,
        propertyId: req.propertyId
      }
    });
  } catch (err) {
    next(err);
  }
};

export const updateInventorySettings = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const verificationIntervalDays = Number(req.body.verificationIntervalDays);
    if (!Number.isInteger(verificationIntervalDays) || verificationIntervalDays < 1 || verificationIntervalDays > 365) {
      return res.status(400).json({ success: false, message: 'Verification interval must be a whole number from 1 to 365 days.' });
    }
    const settings = await InventorySettings.findOneAndUpdate(
      tenantFilter(req),
      { $set: { verificationIntervalDays, updatedBy: req.user._id } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_INVENTORY_SETTINGS',
      entity: 'InventorySettings',
      entityId: settings._id,
      details: { verificationIntervalDays },
      req
    });
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
};

export const getStockVerifications = async (req, res, next) => {
  try {
    const data = await StockVerification.find(tenantFilter(req))
      .populate('itemId', 'name code unit baseUnit')
      .populate('verifiedBy', 'name')
      .sort({ verifiedAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createStockVerification = async (req, res, next) => {
  try {
    const {
      itemId, actualStock, unit, periodStart, periodEnd, location = 'Main Store',
      consumptionQuantity = 0, wastageQuantity = 0, discrepancyReason = '', remarks = ''
    } = req.body;
    if (!mongoose.isValidObjectId(itemId) || !String(location).trim()) {
      return res.status(400).json({ success: false, message: 'Select a valid raw material and stock location.' });
    }
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end || end > new Date()) {
      return res.status(400).json({ success: false, message: 'Enter a valid verification period that does not end in the future.' });
    }
    const numbers = [actualStock, consumptionQuantity, wastageQuantity].map(Number);
    if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ success: false, message: 'Stock and reconciliation quantities must be non-negative numbers.' });
    }
    const idempotencyKey = req.body.idempotencyKey || req.get('Idempotency-Key');
    const result = await runInventoryTransaction(async (session) => {
      if (idempotencyKey) {
        const duplicate = await StockVerification.findOne({
          ...tenantFilter(req), idempotencyKey
        }).session(session);
        if (duplicate) return { verification: duplicate, duplicate: true };
      }
      const item = await InventoryItem.findOne({
        _id: itemId, ...tenantFilter(req), isActive: true
      }).session(session);
      if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
      const selectedUnit = normalizeInventoryUnit(unit || item.baseUnit || item.unit);
      const convertedActual = convertQuantityToBase(item, numbers[0], selectedUnit);
      const convertedConsumption = convertQuantityToBase(item, numbers[1], selectedUnit);
      const convertedWastage = convertQuantityToBase(item, numbers[2], selectedUnit);
      const balance = await InventoryBalance.findOne({
        ...tenantFilter(req), itemId: item._id, location: String(location).trim()
      }).session(session);
      const expectedStock = balance?.quantity ?? (location === 'Main Store' ? item.currentStock : 0);
      const delta = Math.round((convertedActual.quantity - expectedStock + Number.EPSILON) * 1e8) / 1e8;
      const reduction = Math.max(0, -delta);
      if (convertedConsumption.quantity + convertedWastage.quantity > reduction + 1e-8) {
        throw Object.assign(new Error('Consumption and wastage cannot exceed the difference between expected and actual stock.'), { statusCode: 400 });
      }
      const discrepancyQuantity = Math.max(
        0,
        Math.round((reduction - convertedConsumption.quantity - convertedWastage.quantity + Number.EPSILON) * 1e8) / 1e8
      );
      const stockGain = Math.max(0, delta);
      if ((discrepancyQuantity > 0 || stockGain > 0) && !String(discrepancyReason).trim()) {
        throw Object.assign(new Error('A reason is required for stock discrepancies or gains.'), { statusCode: 400 });
      }
      const duplicatePeriod = await StockVerification.exists({
        ...tenantFilter(req),
        itemId: item._id,
        location: String(location).trim(),
        periodEnd: end
      }).session(session);
      if (duplicatePeriod) {
        throw Object.assign(new Error('This raw material already has a stock verification ending on that date.'), { statusCode: 409 });
      }
      const [verification] = await StockVerification.create([{
        ...tenantFilter(req),
        itemId: item._id,
        location: String(location).trim(),
        periodStart: start,
        periodEnd: end,
        expectedStock,
        actualStock: convertedActual.quantity,
        consumptionQuantity: convertedConsumption.quantity,
        wastageQuantity: convertedWastage.quantity,
        discrepancyQuantity,
        stockGain,
        unit: item.baseUnit || item.unit,
        discrepancyReason: String(discrepancyReason).trim(),
        remarks: String(remarks).trim(),
        status: discrepancyQuantity > 0 || stockGain > 0 ? 'pending' : 'verified',
        verifiedBy: req.user._id,
        idempotencyKey: idempotencyKey || undefined
      }], { session });
      const movements = [];
      if (convertedConsumption.quantity > 0) {
        const movement = await postStockMovement({
          hotelId: req.hotelId, propertyId: req.propertyId, itemId: item._id,
          movementType: 'issue', quantity: convertedConsumption.quantity, unit: item.baseUnit || item.unit,
          location: String(location).trim(), referenceNumber: `VER-${verification._id}`,
          notes: `Physical verification consumption. ${remarks}`.trim(),
          recordedBy: req.user._id, idempotencyKey: `verification:${verification._id}:consumption`, session
        });
        movements.push(movement.movement._id);
      }
      if (convertedWastage.quantity > 0) {
        const movement = await postStockMovement({
          hotelId: req.hotelId, propertyId: req.propertyId, itemId: item._id,
          movementType: 'wastage', quantity: convertedWastage.quantity, unit: item.baseUnit || item.unit,
          location: String(location).trim(), referenceNumber: `VER-${verification._id}`,
          notes: `Physical verification wastage. ${remarks}`.trim(),
          recordedBy: req.user._id, idempotencyKey: `verification:${verification._id}:wastage`, session
        });
        movements.push(movement.movement._id);
      }
      if (discrepancyQuantity > 0 || stockGain > 0) {
        const [adjustment] = await StockAdjustment.create([{
          ...tenantFilter(req),
          itemId: item._id,
          quantity: convertedActual.quantity,
          unit: item.baseUnit || item.unit,
          conversionFactor: 1,
          baseUnit: item.baseUnit || item.unit,
          reason: 'physical_mismatch',
          location: String(location).trim(),
          status: 'pending',
          reportedBy: req.user._id,
          remarks: `${String(discrepancyReason).trim()}. ${remarks}`.trim()
        }], { session });
        verification.adjustmentId = adjustment._id;
      }
      verification.movementIds = movements;
      await verification.save({ session });
      return { verification, duplicate: false };
    });
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'RECORD_STOCK_VERIFICATION',
        entity: 'StockVerification',
        entityId: result.verification._id,
        details: { itemId, expectedStock: result.verification.expectedStock, actualStock: result.verification.actualStock },
        req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const getStockLocations = async (req, res, next) => {
  try {
    const balances = await InventoryBalance.find(tenantFilter(req))
      .populate('itemId', 'name code unit currentStock unitCost')
      .sort({ location: 1 })
      .lean();
    res.json({ success: true, data: balances });
  } catch (err) {
    next(err);
  }
};

export const transferStockBetweenLocations = async (req, res, next) => {
  try {
    const { itemId, quantity, fromLocation, toLocation, department, notes } = req.body;
    const result = await runInventoryTransaction((session) => transferStock({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId,
      quantity,
      unit: req.body.unit,
      fromLocation,
      toLocation,
      department: department || '',
      recordedBy: req.user._id,
      referenceNumber: generateReference('TRF'),
      idempotencyKey: req.body.idempotencyKey || req.get('Idempotency-Key'),
      notes: notes || '',
      session
    }));
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      message: result.duplicate ? 'Stock transfer was already recorded.' : 'Stock transferred successfully.',
      data: result
    });
  } catch (err) {
    next(err);
  }
};

export const getStockLedger = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, itemId, movementType, department, location, from, to } = req.query;
    const filter = tenantFilter(req);
    if (itemId) filter.itemId = itemId;
    if (movementType) filter.movementType = movementType;
    if (department) filter.department = department;
    if (location) filter.location = location;
    const createdAt = dateFilter({ from, to });
    if (createdAt) filter.createdAt = createdAt;
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 50));
    const [data, total] = await Promise.all([
      StockMovement.find(filter)
        .populate('itemId', 'name code unit')
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      StockMovement.countDocuments(filter)
    ]);
    res.json({ success: true, data, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
  }
};

export const getGoodsReceipts = async (req, res, next) => {
  try {
    const data = await GoodsReceipt.find(tenantFilter(req))
      .populate('purchaseOrderId', 'poNumber vendorId')
      .populate('receivedBy', 'name')
      .populate('lines.itemId', 'name code unit')
      .sort({ receivedAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 50))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getStockAdjustments = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const data = await StockAdjustment.find(filter)
      .populate('itemId', 'name code unit')
      .populate('reportedBy approvedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 100))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createStockAdjustment = async (req, res, next) => {
  try {
    const { itemId, quantity, reason, department, location, remarks } = req.body;
    const amount = Number(quantity);
    const reasons = ['expired', 'damaged', 'food_wastage', 'spillage', 'missing', 'physical_mismatch', 'internal_usage'];
    if (!mongoose.isValidObjectId(itemId) || !Number.isFinite(amount) || amount < 0
      || (amount === 0 && reason !== 'physical_mismatch') || !reasons.includes(reason)) {
      return res.status(400).json({ success: false, message: 'Provide a valid item, non-negative physical count or positive adjustment quantity, and supported reason.' });
    }
    const item = await InventoryItem.findOne({ _id: itemId, ...tenantFilter(req), isActive: true })
      .select('name unit baseUnit packagingOptions unitConversions');
    if (!item) return res.status(404).json({ success: false, message: 'Active inventory item not found.' });
    const unit = normalizeInventoryUnit(req.body.unit || item.baseUnit || item.unit);
    const converted = convertQuantityToBase(item, amount, unit);
    const adjustment = await StockAdjustment.create({
      ...tenantFilter(req),
      itemId,
      quantity: amount,
      unit: converted.unit,
      baseUnit: item.baseUnit || item.unit,
      conversionFactor: converted.factor,
      reason,
      department: department || '',
      location: location || 'Main Store',
      remarks: remarks || '',
      reportedBy: req.user._id
    });
    res.status(201).json({ success: true, data: adjustment });
  } catch (err) {
    next(err);
  }
};

export const reviewStockAdjustment = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { decision } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
    }
    const result = await runInventoryTransaction(async (session) => {
      const adjustment = await StockAdjustment.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'pending'
      }).session(session);
      if (!adjustment) throw Object.assign(new Error('Pending stock adjustment not found.'), { statusCode: 404 });
      adjustment.status = decision === 'approve' ? 'approved' : 'rejected';
      adjustment.approvedBy = req.user._id;
      adjustment.approvedAt = new Date();
      if (decision === 'approve') {
        const movementType = {
          expired: 'expiry',
          damaged: 'wastage',
          food_wastage: 'wastage',
          spillage: 'wastage',
          missing: 'wastage',
          physical_mismatch: 'physical_count',
          internal_usage: 'issue'
        }[adjustment.reason];
        const movement = await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: adjustment.itemId,
          movementType,
          quantity: adjustment.quantity,
          unit: adjustment.unit || undefined,
          conversionFactor: adjustment.conversionFactor || undefined,
          location: adjustment.location,
          department: adjustment.department,
          referenceNumber: `ADJ-${adjustment._id}`,
          notes: `${adjustment.reason}: ${adjustment.remarks}`,
          recordedBy: req.user._id,
          idempotencyKey: `stock-adjustment:${adjustment._id}`,
          session
        });
        adjustment.movementId = movement.movement._id;
      }
      const verification = await StockVerification.findOne({
        ...tenantFilter(req), adjustmentId: adjustment._id
      }).session(session);
      if (verification) {
        verification.status = decision === 'approve' ? 'approved' : 'rejected';
        if (decision === 'approve') verification.movementIds.push(adjustment.movementId);
        await verification.save({ session });
      }
      await adjustment.save({ session });
      return adjustment;
    });
    await logAudit({
      hotelId: req.hotelId,
      action: `STOCK_ADJUSTMENT_${decision.toUpperCase()}`,
      entity: 'StockAdjustment',
      entityId: result._id,
      details: { itemId: String(result.itemId), quantity: result.quantity, reason: result.reason },
      req
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const resolveMinibarRoom = async (req, session) => {
  const room = await Room.findOne({
    _id: req.params.roomId,
    ...tenantFilter(req),
    isActive: true
  }).session(session);
  if (!room) throw Object.assign(new Error('Room not found in this property.'), { statusCode: 404 });
  return room;
};

export const getMinibarRooms = async (req, res, next) => {
  try {
    const rooms = await Room.find({ ...tenantFilter(req), isActive: true })
      .select('roomNumber roomStatus')
      .sort({ roomNumber: 1 })
      .lean();
    res.json({ success: true, data: rooms });
  } catch (err) {
    next(err);
  }
};

export const getMinibarRoomStock = async (req, res, next) => {
  try {
    const room = await resolveMinibarRoom(req);
    const [stock, transactions] = await Promise.all([
      MinibarStock.find({ ...tenantFilter(req), roomId: room._id })
        .populate('itemId', 'name code unit baseUnit baseUnitId purchaseUnit purchaseUnitId packagingOptions additionalPackagingOptions unitConversions sellingPrice unitCost')
        .sort({ 'itemId.name': 1 })
        .lean(),
      MinibarTransaction.find({ ...tenantFilter(req), roomId: room._id })
        .populate('itemId', 'name code unit')
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);
    res.json({ success: true, data: { room, stock, transactions } });
  } catch (err) {
    next(err);
  }
};

export const assignMinibarStock = async (req, res, next) => {
  try {
    const { items, idempotencyKey } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'At least one minibar item and quantity are required.' });
    }
    const requestKey = String(idempotencyKey || req.get('Idempotency-Key') || generateReference('MB'));
    if (requestKey.length > 120) return res.status(400).json({ success: false, message: 'Idempotency key is too long.' });
    const result = await runInventoryTransaction(async (session) => {
      const alreadyRecorded = await MinibarTransaction.findOne({
        ...tenantFilter(req),
        idempotencyKey: { $in: items.map((line) => `${requestKey}:${line.itemId}:record`) }
      }).session(session);
      if (alreadyRecorded) return { duplicate: true, transactions: [] };
      const room = await resolveMinibarRoom(req, session);
      const transactions = [];
      for (const line of items) {
        const quantity = Number(line.quantity);
        if (!mongoose.isValidObjectId(line.itemId) || !Number.isFinite(quantity) || quantity <= 0) {
          throw Object.assign(new Error('Minibar assignment quantities must be positive.'), { statusCode: 400 });
        }
        const item = await InventoryItem.findOne({
          _id: line.itemId, ...tenantFilter(req), isActive: true
        }).session(session);
        if (!item) throw Object.assign(new Error('Minibar item not found.'), { statusCode: 404 });
        const roomLocation = `Room ${room.roomNumber}`;
        const movement = await transferStock({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: item._id,
          quantity,
          unit: line.unit || undefined,
          fromLocation: line.fromLocation || 'Minibar Store',
          toLocation: roomLocation,
          department: 'Minibar',
          recordedBy: req.user._id,
          referenceNumber: `MINIBAR-${room.roomNumber}`,
          idempotencyKey: `${requestKey}:${item._id}:transfer`,
          session
        });
        let stock = await MinibarStock.findOne({
          ...tenantFilter(req), roomId: room._id, itemId: item._id
        }).session(session);
        if (stock) {
          stock.quantity += movement.movements[0].quantity;
          await stock.save({ session });
        } else {
          [stock] = await MinibarStock.create([{
            ...tenantFilter(req), roomId: room._id, itemId: item._id,
            openingQuantity: movement.movements[0].quantity, quantity: movement.movements[0].quantity
          }], { session });
        }
        const [transaction] = await MinibarTransaction.create([{
          ...tenantFilter(req),
          roomId: room._id,
          itemId: item._id,
          type: 'replenishment',
          quantity: movement.movements[0].quantity,
          enteredQuantity: quantity,
          unit: line.unit || item.baseUnit || item.unit,
          conversionFactor: movement.movements[0].conversionFactor,
          idempotencyKey: `${requestKey}:${item._id}:record`,
          recordedBy: req.user._id
        }], { session });
        transactions.push({ transaction, stock, movement });
      }
      return { duplicate: false, transactions };
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const reconcileMinibar = async (req, res, next) => {
  try {
    const { items, idempotencyKey, notes = '' } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'At least one minibar reconciliation line is required.' });
    }
    const requestKey = String(idempotencyKey || req.get('Idempotency-Key') || generateReference('MB'));
    if (requestKey.length > 120) return res.status(400).json({ success: false, message: 'Idempotency key is too long.' });
    const result = await runInventoryTransaction(async (session) => {
      const alreadyRecorded = await MinibarTransaction.findOne({
        ...tenantFilter(req),
        idempotencyKey: {
          $in: items.flatMap((line) => ['consumption', 'complimentary', 'damaged', 'missing']
            .map((type) => `${requestKey}:${line.itemId}:${type}:record`))
        }
      }).session(session);
      if (alreadyRecorded) return { duplicate: true, transactions: [] };
      const room = await resolveMinibarRoom(req, session);
      const reservation = await Reservation.findOne({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        status: 'checked_in',
        'rooms.roomId': room._id
      }).session(session);
      const invoice = reservation
        ? await Invoice.findOne({ hotelId: req.hotelId, propertyId: req.propertyId, reservationId: reservation._id }).session(session)
        : null;
      const recorded = [];
      for (const line of items) {
        const stock = await MinibarStock.findOne({
          ...tenantFilter(req), roomId: room._id, itemId: line.itemId
        }).session(session);
        if (!stock) throw Object.assign(new Error('Minibar stock item is not assigned to this room.'), { statusCode: 404 });
        const item = await InventoryItem.findOne({
          _id: stock.itemId, ...tenantFilter(req), isActive: true
        }).session(session);
        if (!item) throw Object.assign(new Error('Minibar item is no longer active.'), { statusCode: 409 });
        const enteredQuantities = {
          consumption: Number(line.consumedQuantity || 0),
          complimentary: Number(line.complimentaryQuantity || 0),
          damaged: Number(line.damagedQuantity || 0),
          missing: Number(line.missingQuantity || 0)
        };
        const unit = normalizeInventoryUnit(line.unit || item.baseUnit || item.unit);
        const conversionFactor = getUnitConversionFactor(item, unit);
        const quantities = Object.fromEntries(
          Object.entries(enteredQuantities).map(([type, quantity]) => [
            type,
            convertQuantityToBase(item, quantity, unit, conversionFactor).quantity
          ])
        );
        if (!Object.values(enteredQuantities).every((quantity) => Number.isFinite(quantity) && quantity >= 0)
          || Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0) > stock.quantity) {
          throw Object.assign(new Error(`Reconciled quantity exceeds available minibar stock for ${item.name}.`), { statusCode: 409 });
        }
        const chargedQuantity = quantities.consumption;
        const unitPrice = item.sellingPrice ?? item.unitCost;
        const chargeAmount = Math.round(chargedQuantity * unitPrice * 100) / 100;
        if (chargeAmount > 0 && (!reservation || !invoice)) {
          throw Object.assign(new Error('A checked-in guest reservation and invoice are required to charge minibar consumption.'), { statusCode: 409 });
        }
        const totalDeducted = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
        if (totalDeducted > 0) {
          const updated = await MinibarStock.updateOne({
            _id: stock._id, quantity: { $gte: totalDeducted }
          }, { $inc: { quantity: -totalDeducted } }, { session });
          if (updated.modifiedCount !== 1) throw Object.assign(new Error('Minibar stock changed concurrently; reconcile again.'), { statusCode: 409 });
        }
        for (const [type, quantity] of Object.entries(quantities)) {
          if (!quantity) continue;
          const movementType = type === 'damaged' || type === 'missing' ? 'wastage' : 'issue';
          const movement = await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: item._id,
            movementType,
            quantity: enteredQuantities[type],
            unit,
            conversionFactor,
            location: `Room ${room.roomNumber}`,
            department: 'Minibar',
            referenceNumber: `ROOM-${room.roomNumber}`,
            notes: `${type} minibar item. ${notes}`.trim(),
            recordedBy: req.user._id,
            idempotencyKey: `${requestKey}:${item._id}:${type}`,
            session
          });
          const [transaction] = await MinibarTransaction.create([{
            ...tenantFilter(req),
            roomId: room._id,
            itemId: item._id,
            reservationId: reservation?._id || null,
            invoiceId: chargeAmount > 0 && type === 'consumption' ? invoice._id : null,
            type,
            quantity,
            enteredQuantity: enteredQuantities[type],
            unit,
            conversionFactor,
            unitPrice: type === 'consumption' ? unitPrice : 0,
            chargeAmount: type === 'consumption' ? chargeAmount : 0,
            idempotencyKey: `${requestKey}:${item._id}:${type}:record`,
            recordedBy: req.user._id,
            notes
          }], { session });
          recorded.push({ transaction, movement: movement.movement });
        }
        if (chargeAmount > 0) {
          invoice.items.push({
            description: `Minibar: ${item.name} (Room ${room.roomNumber})`,
            quantity: chargedQuantity,
            unitPrice,
            amount: chargeAmount,
            itemType: 'amenity',
            sourceRef: `${room._id}:${item._id}:${requestKey}`
          });
          invoice.subtotal = Math.round((invoice.subtotal + chargeAmount) * 100) / 100;
          invoice.totalAmount = Math.round((invoice.totalAmount + chargeAmount) * 100) / 100;
          invoice.balanceAmount = Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100;
          reservation.totalAmount = Math.round((reservation.totalAmount + chargeAmount) * 100) / 100;
          reservation.balanceAmount = Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100;
        }
      }
      if (invoice && recorded.length) await invoice.save({ session });
      if (reservation && recorded.length) await reservation.save({ session });
      return { duplicate: false, transactions: recorded };
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const approvePurchaseOrder = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const po = await PurchaseOrder.findOneAndUpdate({
      _id: req.params.id, ...tenantFilter(req), status: { $in: ['draft', 'pending_approval'] }
    }, {
      $set: { status: 'ordered', approvedBy: req.user._id, approvedAt: new Date() }
    }, { new: true, runValidators: true });
    if (!po) return res.status(404).json({ success: false, message: 'Pending purchase order not found.' });
    await logAudit({
      hotelId: req.hotelId,
      action: 'APPROVE_INVENTORY_PURCHASE_ORDER',
      entity: 'PurchaseOrder',
      entityId: po._id,
      details: { poNumber: po.poNumber },
      req
    });
    res.json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
};

export const getReorderSuggestions = async (req, res, next) => {
  try {
    const [items, openOrders, expiredBatches] = await Promise.all([
      InventoryItem.find({ ...tenantFilter(req), isActive: true }).select('name code unit baseUnit purchaseUnit purchaseConversionFactor packagingOptions unitConversions currentStock minStockThreshold reorderQuantity unitCost vendorId').lean(),
      PurchaseOrder.find({ ...tenantFilter(req), status: { $in: ['ordered', 'partially_received', 'approved'] } })
        .select('items status').lean(),
      InventoryBatch.aggregate([
        { $match: { ...tenantFilter(req), expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ])
    ]);
    const pending = new Map();
    const expired = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    for (const order of openOrders) {
      for (const line of order.items) {
        const key = String(line.itemId || '');
        pending.set(key, (pending.get(key) || 0)
          + Math.max(0, line.quantity - (line.receivedQuantity || 0)) * (line.conversionFactor || 1));
      }
    }
    const data = items.filter((item) => (
      Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0))
        + (pending.get(String(item._id)) || 0) <= item.minStockThreshold
    )).map((item) => {
      const onOrder = pending.get(String(item._id)) || 0;
      const availableStock = Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0));
      const target = Math.max(item.reorderQuantity || 0, item.minStockThreshold - availableStock - onOrder);
      const factor = getUnitConversionFactor(item, item.purchaseUnit || item.baseUnit || item.unit);
      return {
        ...item,
        availableStock,
        pendingPurchaseQuantity: onOrder,
        suggestedBaseQuantity: Math.max(0, target),
        suggestedQuantity: Math.ceil(Math.max(0, target) / factor),
        suggestedUnit: item.purchaseUnit || item.baseUnit || item.unit
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getDepartmentRequests = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.department) filter.department = req.query.department;
    const data = await DepartmentRequest.find(filter)
      .populate('requestedBy approvedBy', 'name')
      .populate('lines.itemId', 'name code unit currentStock')
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 100))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createDepartmentRequest = async (req, res, next) => {
  try {
    const { department, lines, notes } = req.body;
    if (!department?.trim() || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ success: false, message: 'Department and at least one requested item are required.' });
    }
    const parsedLines = [];
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: 'Requested quantities must be positive.' });
      }
      const item = await InventoryItem.findOne({
        _id: line.itemId, ...tenantFilter(req), isActive: true
      }).select('name unit baseUnit purchaseUnit packagingOptions unitConversions');
      if (!item) return res.status(400).json({ success: false, message: 'Request contains an invalid inventory item.' });
      const unit = normalizeInventoryUnit(line.unit || item.baseUnit || item.unit);
      const converted = convertQuantityToBase(item, quantity, unit);
      parsedLines.push({
        itemId: line.itemId,
        quantity,
        baseQuantity: converted.quantity,
        unit: converted.unit,
        conversionFactor: converted.factor
      });
    }
    const [request] = await DepartmentRequest.create([{
      ...tenantFilter(req),
      department: department.trim(),
      lines: parsedLines,
      notes: notes || '',
      requestedBy: req.user._id
    }]);
    res.status(201).json({ success: true, data: request });
  } catch (err) {
    next(err);
  }
};

export const reviewDepartmentRequest = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { decision, lines } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
    }
    const result = await runInventoryTransaction(async (session) => {
      const request = await DepartmentRequest.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'pending'
      }).session(session);
      if (!request) throw Object.assign(new Error('Pending department request not found.'), { statusCode: 404 });
      if (decision === 'reject') {
        request.status = 'rejected';
        request.approvedBy = req.user._id;
        request.approvedAt = new Date();
        await request.save({ session });
        return request;
      }
      const issuedLines = lines || request.lines;
      for (const input of issuedLines) {
        const line = request.lines.find((candidate) => String(candidate.itemId) === String(input.itemId));
        if (!line) throw Object.assign(new Error('Issue contains an item that was not requested.'), { statusCode: 400 });
        const quantity = Number(input.quantity ?? line.quantity);
        const unit = normalizeInventoryUnit(input.unit || line.unit);
        const requestedFactor = line.unit === unit && line.conversionFactor
          ? line.conversionFactor
          : getUnitConversionFactor(
            await InventoryItem.findOne({ _id: line.itemId, ...tenantFilter(req) })
              .select('name unit baseUnit packagingOptions unitConversions'),
            unit
          );
        const conversionFactor = requestedFactor;
        const baseQuantity = quantity * conversionFactor;
        if (!Number.isFinite(quantity) || quantity <= 0
          || baseQuantity > (line.baseQuantity ?? line.quantity * (line.conversionFactor || 1))) {
          throw Object.assign(new Error('Issued quantity must be positive and cannot exceed the requested quantity.'), { statusCode: 400 });
        }
        await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: line.itemId,
          movementType: 'department_issue',
          quantity,
          unit,
          conversionFactor,
          location: input.location || 'Main Store',
          department: request.department,
          referenceNumber: `REQ-${request._id}`,
          notes: request.notes || 'Approved department stock issue',
          recordedBy: req.user._id,
          idempotencyKey: `department-request:${request._id}:${line.itemId}`,
          session
        });
        line.issuedQuantity = baseQuantity;
        line.issuedEnteredQuantity = quantity;
        line.issuedUnit = unit;
        line.issuedConversionFactor = conversionFactor;
      }
      request.status = request.lines.every((line) => (
        line.issuedQuantity >= (line.baseQuantity ?? line.quantity * (line.conversionFactor || 1))
      )) ? 'issued' : 'partially_issued';
      request.approvedBy = req.user._id;
      request.approvedAt = new Date();
      await request.save({ session });
      return request;
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const getRecipes = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.menuItemId) filter.menuItemId = req.query.menuItemId;
    const recipes = await InventoryRecipe.find(filter)
      .populate('menuItemId', 'name price')
      .populate('ingredients.itemId', 'name code unit baseUnit unitCost')
      .populate('ingredients.substitutions.itemId', 'name code unit baseUnit')
      .sort({ menuItemId: 1, version: -1 })
      .lean();
    res.json({ success: true, data: recipes });
  } catch (err) {
    next(err);
  }
};

export const saveRecipe = async (req, res, next) => {
  try {
    if (!['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can manage recipes.' });
    }
    const { menuItemId, ingredients } = req.body;
    if (!mongoose.isValidObjectId(menuItemId) || !Array.isArray(ingredients) || !ingredients.length) {
      return res.status(400).json({ success: false, message: 'Menu item and at least one ingredient are required.' });
    }
    const MenuItem = mongoose.model('MenuItem');
    const menuItemExists = await MenuItem.exists({ _id: menuItemId, hotelId: req.hotelId });
    if (!menuItemExists) return res.status(404).json({ success: false, message: 'Menu item not found.' });
    for (const ingredient of ingredients) {
      if (!mongoose.isValidObjectId(ingredient.itemId) || !Number.isFinite(Number(ingredient.quantity)) || Number(ingredient.quantity) <= 0) {
        return res.status(400).json({ success: false, message: 'Each recipe ingredient needs a valid item and positive quantity.' });
      }
      const ingredientItem = await InventoryItem.findOne({
        _id: ingredient.itemId, ...tenantFilter(req), isActive: true
      }).select('name unit baseUnit packagingOptions unitConversions');
      if (!ingredientItem) return res.status(400).json({ success: false, message: 'Recipe contains an invalid inventory item.' });
      const ingredientUnit = normalizeInventoryUnit(ingredient.unit || ingredientItem.baseUnit || ingredientItem.unit);
      const ingredientConversionFactor = getUnitConversionFactor(ingredientItem, ingredientUnit);
      if (!Array.isArray(ingredient.substitutions || [])) {
        return res.status(400).json({ success: false, message: 'Recipe substitutions must be a list.' });
      }
      for (const substitution of ingredient.substitutions || []) {
        if (!mongoose.isValidObjectId(substitution.itemId)
          || (substitution.quantity !== undefined && (!Number.isFinite(Number(substitution.quantity)) || Number(substitution.quantity) <= 0))) {
          return res.status(400).json({ success: false, message: 'Recipe substitutions must include a valid item and positive optional quantity.' });
        }
        const substituteItem = await InventoryItem.findOne({
          _id: substitution.itemId, ...tenantFilter(req), isActive: true
        }).select('name unit baseUnit packagingOptions unitConversions');
        if (!substituteItem) return res.status(400).json({ success: false, message: 'Recipe substitution contains an invalid inventory item.' });
        const substituteUnit = normalizeInventoryUnit(substitution.unit || substituteItem.baseUnit || substituteItem.unit);
        substitution.unit = substituteUnit;
        substitution.conversionFactor = getUnitConversionFactor(substituteItem, substituteUnit);
        substitution.baseUnit = substituteItem.baseUnit || substituteItem.unit;
      }
      ingredient.unit = ingredientUnit;
      ingredient.conversionFactor = ingredientConversionFactor;
      ingredient.baseUnit = ingredientItem.baseUnit || ingredientItem.unit;
    }
    const recipe = await runInventoryTransaction(async (session) => {
      const previous = await InventoryRecipe.findOne({
        ...tenantFilter(req), menuItemId, isActive: true
      }).sort({ version: -1 }).session(session);
      if (previous) {
        previous.isActive = false;
        await previous.save({ session });
      }
      const version = (previous?.version || 0) + 1;
      const [created] = await InventoryRecipe.create([{
        ...tenantFilter(req),
        menuItemId,
        ingredients: ingredients.map((ingredient) => ({
          itemId: ingredient.itemId,
          quantity: Number(ingredient.quantity),
          unit: ingredient.unit,
          conversionFactor: ingredient.conversionFactor,
          baseUnit: ingredient.baseUnit,
          optional: Boolean(ingredient.optional),
          substitutions: ingredient.substitutions || []
        })),
        version,
        createdBy: req.user._id
      }], { session });
      return created;
    });
    res.status(201).json({ success: true, data: recipe });
  } catch (err) {
    next(err);
  }
};

export const getInventoryReport = async (req, res, next) => {
  try {
    const { type = 'stock', category, department, itemId, from, to } = req.query;
    const scope = tenantFilter(req);
    const createdAt = dateFilter({ from, to });
    if (type === 'financial') {
      const itemFilter = {
        ...scope,
        ...(category && category !== 'all' ? { category } : {}),
        ...(itemId ? { _id: itemId } : {})
      };
      const items = await InventoryItem.find(itemFilter)
        .select('name code category currentStock unitCost')
        .lean();
      const movementFilter = {
        ...scope,
        itemId: { $in: items.map((item) => item._id) },
        ...(createdAt ? {
          $or: [
            { transactionDate: createdAt },
            { transactionDate: { $exists: false }, createdAt }
          ]
        } : {})
      };
      const movements = await StockMovement.find(movementFilter)
        .select('itemId movementType totalValue previousStock newStock quantity referenceNumber batchAllocations transactionDate createdAt')
        .populate('itemId', 'name code category unit')
        .lean();
      const [batchValues, purchaseOrders] = await Promise.all([
        InventoryBatch.aggregate([
          { $match: { ...scope, itemId: { $in: items.map((item) => item._id) }, remainingQuantity: { $gt: 0 } } },
          { $group: {
            _id: '$itemId',
            quantity: { $sum: '$remainingQuantity' },
            value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
          } }
        ]),
        PurchaseOrder.find({
          ...scope,
          poNumber: { $in: [...new Set(movements
            .filter((movement) => movement.movementType === 'receipt')
            .map((movement) => movement.referenceNumber)
            .filter(Boolean))] }
        }).populate('vendorId', 'name').select('poNumber vendorId').lean()
      ]);
      const itemTotals = new Map(items.map((item) => [String(item._id), {
        itemId: item._id,
        name: item.name,
        code: item.code,
        unit: item.unit || '',
        purchasedQuantity: 0,
        purchaseValue: 0,
        consumedQuantity: 0,
        consumptionCost: 0,
        wastedQuantity: 0,
        wastageCost: 0
      }]));
      const vendorByPO = new Map(purchaseOrders.map((order) => [order.poNumber, order.vendorId]));
      const vendorTotals = new Map();
      const monthlyTotals = new Map();
      for (const movement of movements) {
        const totals = itemTotals.get(String(movement.itemId?._id));
        if (!totals) continue;
        const transactionDate = new Date(movement.transactionDate || movement.createdAt);
        const monthKey = `${transactionDate.getFullYear()}-${String(transactionDate.getMonth() + 1).padStart(2, '0')}`;
        const monthTotal = monthlyTotals.get(monthKey) || {
          month: monthKey,
          purchaseValue: 0,
          consumptionCost: 0,
          wastageCost: 0
        };
        if (movement.movementType === 'receipt') {
          totals.purchasedQuantity += movement.quantity;
          totals.purchaseValue += movement.totalValue;
          monthTotal.purchaseValue += movement.totalValue;
          const vendor = vendorByPO.get(movement.referenceNumber);
          const vendorKey = vendor?._id ? String(vendor._id) : 'unassigned';
          const vendorTotal = vendorTotals.get(vendorKey) || {
            vendorId: vendor?._id || null,
            vendorName: vendor?.name || 'Unassigned vendor',
            totalPurchaseValue: 0,
            receiptCount: 0
          };
          vendorTotal.totalPurchaseValue += movement.totalValue;
          vendorTotal.receiptCount += 1;
          vendorTotals.set(vendorKey, vendorTotal);
        } else if (['issue', 'department_issue', 'recipe_consumption'].includes(movement.movementType)) {
          totals.consumedQuantity += movement.quantity;
          totals.consumptionCost += movement.totalValue;
          monthTotal.consumptionCost += movement.totalValue;
        } else if (['wastage', 'expiry'].includes(movement.movementType)) {
          totals.wastedQuantity += movement.quantity;
          totals.wastageCost += movement.totalValue;
          monthTotal.wastageCost += movement.totalValue;
        }
        monthlyTotals.set(monthKey, monthTotal);
      }
      const purchases = movements.filter((movement) => movement.movementType === 'receipt')
        .reduce((sum, movement) => sum + movement.totalValue, 0);
      const consumption = movements.filter((movement) => (
        ['issue', 'department_issue', 'recipe_consumption'].includes(movement.movementType)
      )).reduce((sum, movement) => sum + movement.totalValue, 0);
      const wastage = movements.filter((movement) => (
        ['wastage', 'expiry'].includes(movement.movementType)
      )).reduce((sum, movement) => sum + movement.totalValue, 0);
      const stockAdjustment = movements.filter((movement) => (
        ['adjustment', 'physical_count'].includes(movement.movementType)
      )).reduce((sum, movement) => (
        sum + (movement.newStock < movement.previousStock ? -movement.totalValue : movement.totalValue)
      ), 0);
      const batchByItem = new Map(batchValues.map((batch) => [String(batch._id), batch]));
      let closingInventoryValue = items.reduce((sum, item) => {
        const batch = batchByItem.get(String(item._id));
        const batchQuantity = batch?.quantity || 0;
        const unbatchedQuantity = Math.max(0, item.currentStock - batchQuantity);
        return sum + (batch?.value || 0) + unbatchedQuantity * item.unitCost;
      }, 0);
      if (to && createdAt?.$lte) {
        const asOf = createdAt.$lte;
        const [batches, laterMovements] = await Promise.all([
          InventoryBatch.find({
            ...scope,
            itemId: { $in: items.map((item) => item._id) },
            receivedAt: { $lte: asOf }
          }).select('itemId quantity remainingQuantity unitCost').lean(),
          StockMovement.find({
            ...scope,
            itemId: { $in: items.map((item) => item._id) },
            $or: [
              { transactionDate: { $gt: asOf } },
              { transactionDate: { $exists: false }, createdAt: { $gt: asOf } }
            ]
          }).select('itemId previousStock newStock batchAllocations').lean()
        ]);
        const laterBatchReductions = new Map();
        const laterStockChanges = new Map();
        for (const movement of laterMovements) {
          const itemKey = String(movement.itemId);
          laterStockChanges.set(
            itemKey,
            (laterStockChanges.get(itemKey) || 0) + movement.newStock - movement.previousStock
          );
          for (const allocation of movement.batchAllocations || []) {
            if (!allocation.batchId) continue;
            const batchKey = String(allocation.batchId);
            laterBatchReductions.set(batchKey, (laterBatchReductions.get(batchKey) || 0) + allocation.quantity);
          }
        }
        const historicalBatchQuantity = new Map();
        const historicalBatchValues = new Map();
        for (const batch of batches) {
          const quantity = Math.min(
            batch.quantity,
            batch.remainingQuantity + (laterBatchReductions.get(String(batch._id)) || 0)
          );
          historicalBatchQuantity.set(
            String(batch.itemId),
            (historicalBatchQuantity.get(String(batch.itemId)) || 0) + quantity
          );
          historicalBatchValues.set(
            String(batch.itemId),
            (historicalBatchValues.get(String(batch.itemId)) || 0) + quantity * batch.unitCost
          );
        }
        closingInventoryValue = items.reduce((sum, item) => {
          const key = String(item._id);
          const historicalStock = Math.max(0, item.currentStock - (laterStockChanges.get(key) || 0));
          const batchedStock = historicalBatchQuantity.get(key) || 0;
          const unbatchedStock = Math.max(0, historicalStock - batchedStock);
          const batchedValue = historicalBatchValues.get(key) || 0;
          return sum + batchedValue + unbatchedStock * item.unitCost;
        }, 0);
      }
      closingInventoryValue = Math.round(closingInventoryValue * 100) / 100;
      return res.json({
        success: true,
        data: [{
          totalPurchaseValue: Math.round(purchases * 100) / 100,
          totalConsumptionCost: Math.round(consumption * 100) / 100,
          totalWastageLoss: Math.round(wastage * 100) / 100,
          closingInventoryValue,
          stockAdjustmentValue: Math.round(stockAdjustment * 100) / 100,
          totalRawMaterialCost: Math.round((consumption + wastage) * 100) / 100,
          vendorBreakdown: [...vendorTotals.values()].map((vendor) => ({
            ...vendor,
            totalPurchaseValue: Math.round(vendor.totalPurchaseValue * 100) / 100
          })).sort((a, b) => b.totalPurchaseValue - a.totalPurchaseValue),
          itemBreakdown: [...itemTotals.values()].map((item) => ({
            ...item,
            purchaseValue: Math.round(item.purchaseValue * 100) / 100,
            consumptionCost: Math.round(item.consumptionCost * 100) / 100,
            wastageCost: Math.round(item.wastageCost * 100) / 100
          })).sort((a, b) => (b.purchaseValue + b.consumptionCost + b.wastageCost)
            - (a.purchaseValue + a.consumptionCost + a.wastageCost)),
          monthlyTrend: [...monthlyTotals.values()].map((month) => ({
            ...month,
            purchaseValue: Math.round(month.purchaseValue * 100) / 100,
            consumptionCost: Math.round(month.consumptionCost * 100) / 100,
            wastageCost: Math.round(month.wastageCost * 100) / 100
          })).sort((a, b) => a.month.localeCompare(b.month))
        }]
      });
    }
    if (type === 'stock' || type === 'valuation') {
      const filter = { ...scope, ...(category && category !== 'all' ? { category } : {}) };
      const items = await InventoryItem.find(filter).populate('vendorId', 'name').sort({ name: 1 }).lean();
      const expiredBatches = await InventoryBatch.aggregate([
        { $match: { ...scope, itemId: { $in: items.map((item) => item._id) }, expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ]);
      const expired = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
      const data = items.map((item) => ({
        ...item,
        availableStock: Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0)),
        ...(type === 'valuation' ? { stockValue: item.currentStock * item.unitCost } : {})
      }));
      return res.json({
        success: true,
        data
      });
    }
    if (type === 'purchases') {
      const filter = { ...scope, ...(createdAt ? { createdAt } : {}) };
      const data = await PurchaseOrder.find(filter).populate('vendorId', 'name').sort({ createdAt: -1 }).lean();
      return res.json({ success: true, data });
    }
    if (type === 'recipe-consumption') {
      const filter = { ...scope, ...(createdAt ? { createdAt } : {}) };
      const data = await RecipeConsumption.find(filter).populate('ingredients.itemId', 'name code unit').sort({ createdAt: -1 }).lean();
      return res.json({ success: true, data });
    }
    if (type === 'verifications') {
      const filter = { ...scope, ...(createdAt ? { verifiedAt: createdAt } : {}) };
      if (itemId) filter.itemId = itemId;
      const data = await StockVerification.find(filter)
        .populate('itemId', 'name code unit baseUnit')
        .populate('verifiedBy', 'name')
        .sort({ verifiedAt: -1 })
        .limit(5010)
        .lean();
      return res.json({ success: true, data });
    }
    if (type === 'expiry') {
      const pipeline = [
        { $match: { ...scope } },
        { $unwind: '$lines' },
        { $match: { 'lines.expiryDate': { $ne: null }, ...(createdAt ? { 'lines.expiryDate': createdAt } : {}) } },
        { $lookup: { from: 'inventoryitems', localField: 'lines.itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        ...(category && category !== 'all' ? [{ $match: { 'item.category': category } }] : []),
        { $project: {
          _id: 0,
          itemId: '$item._id',
          itemName: '$item.name',
          code: '$item.code',
          unit: '$item.unit',
          batchNumber: '$lines.batchNumber',
          expiryDate: '$lines.expiryDate',
          quantity: '$lines.acceptedQuantity',
          receiptNumber: 1,
          receivedAt: 1
        } },
        { $sort: { expiryDate: 1 } },
        { $limit: 5010 }
      ];
      const data = await GoodsReceipt.aggregate(pipeline);
      return res.json({ success: true, data });
    }
    const movementTypes = type === 'wastage' ? ['wastage', 'expiry']
      : type === 'department-consumption' ? ['issue', 'department_issue', 'recipe_consumption']
        : null;
    if (movementTypes) {
      const filter = {
        ...scope,
        movementType: { $in: movementTypes },
        ...(createdAt ? { createdAt } : {}),
        ...(department ? { department } : {}),
        ...(itemId ? { itemId } : {})
      };
      const data = await StockMovement.find(filter).populate('itemId', 'name code unit').populate('recordedBy', 'name')
        .sort({ createdAt: -1 }).limit(5010).lean();
      return res.json({ success: true, data });
    }
    if (type === 'ledger' || type === 'transfers' || type === 'adjustments') {
      const types = type === 'transfers' ? ['transfer']
        : type === 'adjustments' ? ['adjustment', 'physical_count']
          : null;
      const filter = {
        ...scope,
        ...(types ? { movementType: { $in: types } } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(department ? { department } : {}),
        ...(itemId ? { itemId } : {})
      };
      const data = await StockMovement.find(filter).populate('itemId', 'name code unit')
        .populate('recordedBy', 'name').sort({ createdAt: -1 }).limit(5010).lean();
      return res.json({ success: true, data });
    }
    res.status(400).json({ success: false, message: 'Unsupported inventory report type.' });
  } catch (err) {
    next(err);
  }
};

export const exportInventoryReport = async (req, res, next) => {
  try {
    const { type = 'stock', ...filters } = req.query;
    const request = { ...req, query: { ...filters, type } };
    const result = await new Promise((resolve, reject) => {
      getInventoryReport(request, {
        json: (body) => resolve(body),
        status: (status) => ({ json: (body) => resolve({ ...body, status }) })
      }, reject);
    });
    if (result.status && result.status !== 200) {
      return res.status(result.status).json(result);
    }
    const rows = result.data || [];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== '__v')))];
    const csvValue = (value) => {
      const text = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = [columns.map(csvValue).join(','), ...rows.map((row) => columns.map((key) => csvValue(row[key])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${type}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};
