import mongoose from 'mongoose';
import {
  DepartmentRequest, GoodsReceipt, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, StockReceiptRequest, Unit,
  MinibarStock, MinibarTransaction, StockMovement, StockVerification, SupplierPayment, Vendor, PurchaseOrder
} from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyHotelOperations, notifyRoles } from '../services/notificationService.js';
import { postStockMovement, runInventoryTransaction } from '../services/inventoryService.js';
import {
  getItemUnitConfiguration, getUnitConversionFactor, normalizeInventoryUnit
} from '../config/inventoryUnits.js';

const isAdministrator = (user) => ['hotel_admin', 'super_admin'].includes(user?.role);
const unitConfigurationError = (message) => Object.assign(new Error(message), { statusCode: 400 });
const getConfiguredRawMaterialUnit = (item, unitSymbol) => (item.supportedUnits || []).find((entry) => (
  entry.isActive !== false
  && normalizeInventoryUnit(entry.unitSymbolSnapshot || entry.unitId?.symbol || '')
    === normalizeInventoryUnit(unitSymbol || '')
  && Number(entry.conversionFactorToBase) > 0
));
const quantityInBaseUnit = (quantity, conversionFactor) => (
  Math.round((Number(quantity) * Number(conversionFactor) + Number.EPSILON) * 100000000) / 100000000
);

const resolveItemUnits = async ({
  hotelId,
  baseUnitId,
  purchaseUnitId,
  conversionFactor,
  additionalPackagingOptions = []
}) => {
  if (!baseUnitId || !purchaseUnitId) {
    throw unitConfigurationError('Choose a base unit and purchase unit for this raw material.');
  }
  if (!Array.isArray(additionalPackagingOptions)) {
    throw unitConfigurationError('Additional packaging options must be a list of configured units.');
  }
  const requestedIds = [baseUnitId, purchaseUnitId, ...additionalPackagingOptions.map((option) => option.unitId)]
    .filter(Boolean)
    .map(String);
  const uniqueIds = [...new Set(requestedIds)];
  const units = await Unit.find({
    hotelId,
    _id: { $in: uniqueIds },
    isActive: true
  });
  const unitsById = new Map(units.map((unit) => [String(unit._id), unit]));
  const baseUnit = unitsById.get(String(baseUnitId));
  const purchaseUnit = unitsById.get(String(purchaseUnitId));
  if (!baseUnit || !purchaseUnit) {
    throw unitConfigurationError('Base and purchase units must be active units belonging to this hotel.');
  }

  const packagingOptions = [];
  const seenUnits = new Set([String(baseUnit._id), String(purchaseUnit._id)]);
  for (const option of additionalPackagingOptions) {
    const unit = unitsById.get(String(option.unitId));
    const factor = Number(option.conversionFactor);
    if (!unit || !Number.isFinite(factor) || factor <= 0) {
      throw unitConfigurationError('Each additional packaging unit must be active and have a conversion factor greater than zero.');
    }
    if (seenUnits.has(String(unit._id))) {
      throw unitConfigurationError(`Unit "${unit.name}" is configured more than once.`);
    }
    if (unit.category === baseUnit.category) {
      let standardFactor = null;
      try {
        standardFactor = getUnitConversionFactor({ baseUnit: baseUnit.symbol, unit: baseUnit.symbol }, unit.symbol);
      } catch (error) {
        if (error.statusCode !== 400) throw error;
      }
      if (standardFactor && Math.abs(factor - standardFactor) > 1e-9) {
        throw unitConfigurationError(`Conversion for ${unit.name} must use the standard conversion to ${baseUnit.name}.`);
      }
    }
    seenUnits.add(String(unit._id));
    packagingOptions.push({ unit: unit.symbol, unitId: unit._id, conversionFactor: factor });
  }

  const suppliedFactor = conversionFactor === '' || conversionFactor === null || conversionFactor === undefined
    ? null
    : Number(conversionFactor);
  if (suppliedFactor !== null && (!Number.isFinite(suppliedFactor) || suppliedFactor <= 0)) {
    throw unitConfigurationError('Conversion factor must be greater than zero.');
  }

  let purchaseConversionFactor = 1;
  if (String(purchaseUnit._id) !== String(baseUnit._id)) {
    const packageFactor = packagingOptions.find((option) => String(option.unitId) === String(purchaseUnit._id))?.conversionFactor;
    let standardFactor = null;
    try {
      standardFactor = baseUnit.category === purchaseUnit.category
        ? getUnitConversionFactor({ baseUnit: baseUnit.symbol, unit: baseUnit.symbol }, purchaseUnit.symbol)
        : null;
      purchaseConversionFactor = packageFactor || suppliedFactor || standardFactor;
    } catch (error) {
      if (error.statusCode !== 400) throw error;
      purchaseConversionFactor = packageFactor || suppliedFactor || null;
    }
    if (!Number.isFinite(Number(purchaseConversionFactor)) || Number(purchaseConversionFactor) <= 0) {
      throw unitConfigurationError(
        `Enter a product-specific conversion factor for ${purchaseUnit.name} to ${baseUnit.name}.`
      );
    }
    if (packageFactor && suppliedFactor && Math.abs(packageFactor - suppliedFactor) > 1e-9) {
      throw unitConfigurationError('Purchase conversion factor must match the configured packaging option.');
    }
    if (standardFactor && suppliedFactor && Math.abs(standardFactor - suppliedFactor) > 1e-9) {
      throw unitConfigurationError('Purchase conversion factor must match the standard unit conversion.');
    }
    if (baseUnit.category !== purchaseUnit.category && !packageFactor && suppliedFactor === null) {
      throw unitConfigurationError('Units from different categories require an explicit item-specific conversion factor.');
    }
  } else if (suppliedFactor !== null && Math.abs(suppliedFactor - 1) > 1e-9) {
    throw unitConfigurationError('A unit converted to itself must use a factor of 1.');
  }

  const unitConversions = Object.fromEntries(packagingOptions.map((option) => [option.unit, option.conversionFactor]));
  if (purchaseUnit.symbol !== baseUnit.symbol) {
    unitConversions[purchaseUnit.symbol] = Number(purchaseConversionFactor);
  }
  return {
    unit: baseUnit.symbol,
    baseUnit: baseUnit.symbol,
    baseUnitId: baseUnit._id,
    baseUnitCategory: baseUnit.category,
    purchaseUnit: purchaseUnit.symbol,
    purchaseUnitId: purchaseUnit._id,
    purchaseConversionFactor: Number(purchaseConversionFactor),
    conversionFactor: Number(purchaseConversionFactor),
    packagingOptions,
    additionalPackagingOptions: packagingOptions.map(({ unitId, conversionFactor: factor }) => ({
      unitId,
      conversionFactor: factor
    })),
    unitConversions
  };
};

export const getInventoryItems = async (req, res, next) => {
  try {
    const { category, lowStock, search, page = 1, limit = 100 } = req.query;
    const filter = { hotelId: req.hotelId, propertyId: req.propertyId };
    if (req.query.includeInactive === 'true' && !isAdministrator(req.user)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can view inactive inventory items.' });
    }

    if (category && category !== 'all') filter.category = category;
    if (search) {
      const escapedSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escapedSearch, $options: 'i' } },
        { code: { $regex: escapedSearch, $options: 'i' } },
        { barcode: { $regex: escapedSearch, $options: 'i' } }
      ];
    }
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (lowStock === 'true') {
      filter.$expr = { $lte: ['$currentStock', '$minStockThreshold'] };
    }

    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 100));
    const sortFields = new Set(['name', 'code', 'category', 'currentStock', 'unitCost', 'createdAt']);
    const sortField = sortFields.has(req.query.sort) ? req.query.sort : 'name';
    const sortDirection = req.query.direction === 'desc' ? -1 : 1;
    const [items, total] = await Promise.all([
      InventoryItem.find(filter)
      .populate('vendorId', 'name contactPerson phone')
      .populate('baseUnitId', 'name symbol category isActive')
      .populate('purchaseUnitId', 'name symbol category isActive')
      .populate('preferredPurchaseUnitId', 'name symbol category isActive')
      .populate('additionalPackagingOptions.unitId', 'name symbol category isActive')
      .populate('packagingOptions.unitId', 'name symbol category isActive')
      .populate('supportedUnits.unitId', 'name symbol category isActive')
      .populate('supportedUnits.packageMeasurementUnitId', 'name symbol category isActive')
      .sort({ [sortField]: sortDirection })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize)
      .lean(),
      InventoryItem.countDocuments(filter)
    ]);
    const expiredBatches = await InventoryBatch.aggregate([
      { $match: { hotelId: req.hotelId, propertyId: req.propertyId, itemId: { $in: items.map((item) => item._id) }, expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
      { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
    ]);
    const lastVerifications = await StockVerification.aggregate([
      { $match: { hotelId: req.hotelId, propertyId: req.propertyId, itemId: { $in: items.map((item) => item._id) } } },
      { $sort: { verifiedAt: -1 } },
      { $group: { _id: '$itemId', periodEnd: { $first: '$periodEnd' } } }
    ]);
    const expiredByItem = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    const lastVerifiedByItem = new Map(lastVerifications.map((verification) => [
      String(verification._id),
      verification.periodEnd
    ]));
    const rows = items.map((item) => ({
      ...item,
      lastVerifiedPeriodEnd: lastVerifiedByItem.get(String(item._id)) || null,
      availableStock: Math.max(0, item.currentStock - (expiredByItem.get(String(item._id)) || 0))
    }));

    res.json({ success: true, data: rows, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
  }
};

export const getInventoryBatches = async (req, res, next) => {
  try {
    const { itemId } = req.query;
    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ success: false, message: 'Choose a valid inventory item to view its batches.' });
    }
    const item = await InventoryItem.findOne({
      _id: itemId,
      hotelId: req.hotelId,
      propertyId: req.propertyId
    }).select('_id currentStock unitCost location baseUnit unit');
    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }
    const batches = await InventoryBatch.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      ...(req.query.location ? { location: String(req.query.location).trim() } : {})
    })
      .populate('vendorId', 'name')
      .sort({ receivedAt: 1, _id: 1 })
      .lean();
    const balances = await InventoryBalance.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      ...(req.query.location ? { location: String(req.query.location).trim() } : {})
    }).select('location quantity').lean();
    const batchQuantityByLocation = new Map();
    for (const batch of batches) {
      const location = batch.location || 'Main Store';
      batchQuantityByLocation.set(
        location,
        (batchQuantityByLocation.get(location) || 0) + (Number(batch.remainingQuantity) || 0)
      );
    }
    const stockByLocation = balances.length
      ? balances
      : [{
        location: String(req.query.location || item.location || 'Main Store').trim(),
        quantity: item.currentStock
      }];
    const legacyBatches = stockByLocation.flatMap((balance) => {
      const location = balance.location || 'Main Store';
      const untrackedQuantity = Math.max(
        0,
        (Number(balance.quantity) || 0) - (batchQuantityByLocation.get(location) || 0)
      );
      if (untrackedQuantity <= 1e-8) return [];
      return [{
        _id: `legacy-${item._id}-${encodeURIComponent(location)}`,
        itemId: item._id,
        location,
        batchNumber: 'Untracked stock',
        quantity: untrackedQuantity,
        remainingQuantity: untrackedQuantity,
        unitCost: item.unitCost,
        purchaseQuantity: null,
        purchaseUnit: '',
        purchaseUnitCost: null,
        purchaseAmount: null,
        vendorId: null,
        receivedAt: null,
        legacyStock: true,
        status: 'untracked'
      }];
    });
    res.json({
      success: true,
      data: [...batches.map((batch) => ({
        ...batch,
        status: batch.remainingQuantity > 0 ? 'open' : 'closed'
      })), ...legacyBatches]
    });
  } catch (error) {
    next(error);
  }
};

export const getStockReceiptRequests = async (req, res, next) => {
  try {
    const filter = { hotelId: req.hotelId, propertyId: req.propertyId };
    if (req.query.status) filter.status = req.query.status;
    const requests = await StockReceiptRequest.find(filter)
      .populate('itemId', 'name code unit baseUnit')
      .populate('vendorId', 'name')
      .populate('requestedBy reviewedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 100))
      .lean();
    res.json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
};

export const createStockReceiptRequest = async (req, res, next) => {
  try {
    const {
      itemId, quantity, unit, purchaseUnitPrice,
      existingStockDeduction = 0, existingStockDeductionQuantity,
      existingStockDeductionUnit = '', wastageQuantity = 0, wastageUnit = '', wastageReason = ''
    } = req.body;
    const requestedQuantity = Number(quantity);
    const unitPrice = Number(purchaseUnitPrice);
    const enteredStockDeduction = existingStockDeductionQuantity === undefined
      ? Number(existingStockDeduction)
      : Number(existingStockDeductionQuantity);
    const enteredWastageQuantity = Number(wastageQuantity);
    const location = String(req.body.location || 'Main Store').trim();
    if (!mongoose.isValidObjectId(itemId) || !unit?.trim() || !location
      || !Number.isFinite(requestedQuantity) || requestedQuantity <= 0
      || !Number.isFinite(unitPrice) || unitPrice < 0
      || !Number.isFinite(enteredStockDeduction) || enteredStockDeduction < 0
      || !Number.isFinite(enteredWastageQuantity) || enteredWastageQuantity < 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid raw material, purchase unit, location, positive quantity, and non-negative purchase price.' });
    }

    const item = await InventoryItem.findOne({
      _id: itemId,
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      inventoryType: 'raw_material',
      isActive: true
    }).populate('supportedUnits.unitId', 'symbol name').lean();
    if (!item) {
      return res.status(404).json({ success: false, message: 'Active raw material not found.' });
    }
    const selectedUnit = getConfiguredRawMaterialUnit(item, unit);
    if (!selectedUnit) {
      return res.status(400).json({ success: false, message: 'Choose a configured purchase unit for this raw material.' });
    }
    const deductionUnit = existingStockDeductionQuantity === undefined
      ? null
      : getConfiguredRawMaterialUnit(item, existingStockDeductionUnit);
    if (existingStockDeductionQuantity !== undefined && enteredStockDeduction > 0 && !deductionUnit) {
      return res.status(400).json({ success: false, message: 'Choose a configured unit for the existing-stock deduction.' });
    }
    const stockDeduction = existingStockDeductionQuantity === undefined
      ? enteredStockDeduction
      : quantityInBaseUnit(enteredStockDeduction, deductionUnit?.conversionFactorToBase || 1);
    let wastageBaseQuantity = 0;
    let wastageUnitEntry = null;
    const normalizedWastageReason = String(wastageReason || '').trim();
    if (enteredWastageQuantity > 0) {
      wastageUnitEntry = getConfiguredRawMaterialUnit(item, wastageUnit);
      if (!wastageUnitEntry || !normalizedWastageReason) {
        return res.status(400).json({ success: false, message: 'Choose a configured wastage unit and enter a reason.' });
      }
      wastageBaseQuantity = quantityInBaseUnit(
        enteredWastageQuantity,
        wastageUnitEntry.conversionFactorToBase
      );
      if (!Number.isFinite(wastageBaseQuantity) || wastageBaseQuantity <= 0) {
        return res.status(400).json({ success: false, message: 'Enter a valid positive wastage quantity.' });
      }
    }
    const vendorId = req.body.vendorId || null;
    if (vendorId) {
      const vendor = await Vendor.findOne({
        _id: vendorId, hotelId: req.hotelId, status: 'active'
      }).select('_id');
      if (!vendor) {
        return res.status(400).json({ success: false, message: 'Choose an active vendor belonging to this hotel.' });
      }
    }
    const expiryDate = req.body.expiryDate ? new Date(req.body.expiryDate) : null;
    if ((expiryDate && Number.isNaN(expiryDate.getTime())) || (item.trackExpiry && !expiryDate)) {
      return res.status(400).json({ success: false, message: `A valid expiry date is required${item.trackExpiry ? ' for this raw material' : ''}.` });
    }

    const previousBatches = await InventoryBatch.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      location,
      remainingQuantity: { $gt: 0 }
    }).sort({ receivedAt: 1, _id: 1 }).lean();
    const previousAvailableQuantity = previousBatches.reduce(
      (total, batch) => total + batch.remainingQuantity, 0
    );
    if (previousAvailableQuantity <= 0) {
      return res.status(409).json({ success: false, message: 'There is no remaining stock in an earlier batch. Refresh the batch history and submit a regular stock receipt.' });
    }
    if (stockDeduction > previousAvailableQuantity) {
      return res.status(400).json({ success: false, message: `The quantity to deduct cannot exceed the ${previousAvailableQuantity} ${item.baseUnit || item.unit} already available.` });
    }
    const requestedReceiptBaseQuantity = quantityInBaseUnit(
      requestedQuantity,
      selectedUnit.conversionFactorToBase
    );
    const wastageEligibleQuantity = requestedReceiptBaseQuantity
      + (stockDeduction > 0 ? previousAvailableQuantity - stockDeduction : 0);
    if (wastageBaseQuantity > wastageEligibleQuantity) {
      return res.status(400).json({
        success: false,
        message: `Wastage cannot exceed the ${item.baseUnit || item.unit} stock eligible after the existing-stock deduction and fresh receipt.`
      });
    }

    const request = await StockReceiptRequest.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      quantity: requestedQuantity,
      unit: normalizeInventoryUnit(unit),
      purchaseUnitPrice: unitPrice,
      vendorId,
      department: String(req.body.department || '').trim(),
      location,
      expiryDate,
      notes: String(req.body.notes || '').trim(),
      previousBatches: previousBatches.map((batch) => ({
        batchId: batch._id,
        batchNumber: batch.batchNumber,
        remainingQuantity: batch.remainingQuantity
      })),
      previousAvailableQuantity,
      existingStockDeduction: stockDeduction,
      existingStockDeductionEnteredQuantity: existingStockDeductionQuantity === undefined
        ? null
        : enteredStockDeduction,
      existingStockDeductionUnit: existingStockDeductionQuantity === undefined
        ? ''
        : normalizeInventoryUnit(existingStockDeductionUnit || item.baseUnit || item.unit),
      remainingPreviousStockAfterDeduction: previousAvailableQuantity - stockDeduction,
      wastageQuantity: wastageBaseQuantity,
      wastageEnteredQuantity: enteredWastageQuantity || null,
      wastageUnit: enteredWastageQuantity > 0 ? normalizeInventoryUnit(wastageUnit) : '',
      wastageReason: enteredWastageQuantity > 0 ? normalizedWastageReason : '',
      requestedBy: req.user._id
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_STOCK_RECEIPT_REQUEST',
      entity: 'StockReceiptRequest',
      entityId: request._id,
      details: {
        itemId: String(item._id),
        previousAvailableQuantity,
        existingStockDeduction: stockDeduction,
        existingStockDeductionEnteredQuantity: existingStockDeductionQuantity === undefined
          ? null
          : enteredStockDeduction,
        existingStockDeductionUnit: existingStockDeductionQuantity === undefined
          ? ''
          : normalizeInventoryUnit(existingStockDeductionUnit || item.baseUnit || item.unit),
        remainingPreviousStockAfterDeduction: previousAvailableQuantity - stockDeduction,
        wastageQuantity: wastageBaseQuantity,
        wastageEnteredQuantity: enteredWastageQuantity || 0,
        wastageUnit: enteredWastageQuantity > 0 ? normalizeInventoryUnit(wastageUnit) : '',
        wastageReason: enteredWastageQuantity > 0 ? normalizedWastageReason : '',
        location
      },
      req
    });
    res.status(201).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
};

export const reviewStockReceiptRequest = async (req, res, next) => {
  try {
    if (!isAdministrator(req.user)) {
      return res.status(403).json({ success: false, message: 'Hotel administrator approval is required.' });
    }
    const { decision, reviewNotes = '' } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
    }
    const result = await runInventoryTransaction(async (session) => {
      const receiptRequest = await StockReceiptRequest.findOne({
        _id: req.params.id,
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        status: 'pending'
      }).session(session);
      if (!receiptRequest) {
        throw Object.assign(new Error('Pending stock receipt approval not found.'), { statusCode: 404 });
      }
      receiptRequest.status = decision === 'approve' ? 'approved' : 'rejected';
      receiptRequest.reviewedBy = req.user._id;
      receiptRequest.reviewedAt = new Date();
      receiptRequest.reviewNotes = String(reviewNotes).trim();
      if (decision === 'approve') {
        const previousBatchIds = receiptRequest.previousBatches.map((batch) => batch.batchId);
        if (receiptRequest.existingStockDeduction > 0) {
          const eligibleBatches = await InventoryBatch.find({
            _id: { $in: previousBatchIds },
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: receiptRequest.itemId,
            location: receiptRequest.location,
            remainingQuantity: { $gt: 0 }
          }).session(session);
          const eligibleQuantity = eligibleBatches.reduce(
            (total, batch) => total + batch.remainingQuantity, 0
          );
          if (eligibleQuantity < receiptRequest.existingStockDeduction) {
            throw Object.assign(new Error(
              `Only ${eligibleQuantity} units remain in the previously recorded batches; refresh the stock count before approving this restock.`
            ), { statusCode: 409 });
          }
          const item = await InventoryItem.findOne({
            _id: receiptRequest.itemId,
            hotelId: req.hotelId,
            propertyId: req.propertyId
          }).select('baseUnit unit').session(session);
          if (!item) {
            throw Object.assign(new Error('Raw material not found while approving restock.'), { statusCode: 404 });
          }
          const deductionResult = await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: receiptRequest.itemId,
            movementType: 'issue',
            quantity: receiptRequest.existingStockDeduction,
            unit: item.baseUnit || item.unit,
            batchIds: previousBatchIds,
            location: receiptRequest.location,
            department: receiptRequest.department,
            notes: `Existing stock deduction approved for restock request ${receiptRequest._id}.`,
            referenceNumber: `RESTOCK-USE-${receiptRequest._id}`,
            recordedBy: req.user._id,
            idempotencyKey: `stock-receipt-request-deduction:${receiptRequest._id}`,
            session
          });
          receiptRequest.deductionMovementId = deductionResult.movement._id;
        }
        const remainingPreviousBatches = await InventoryBatch.find({
          _id: { $in: previousBatchIds },
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: receiptRequest.itemId,
          location: receiptRequest.location
        }).session(session);
        receiptRequest.remainingPreviousStockAfterDeduction = remainingPreviousBatches.reduce(
          (total, batch) => total + batch.remainingQuantity, 0
        );
        const movementResult = await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: receiptRequest.itemId,
          movementType: 'receipt',
          quantity: receiptRequest.quantity,
          unit: receiptRequest.unit,
          purchaseUnitPrice: receiptRequest.purchaseUnitPrice,
          vendorId: receiptRequest.vendorId,
          autoGenerateBatchNumber: true,
          location: receiptRequest.location,
          department: receiptRequest.department,
          notes: receiptRequest.notes,
          referenceNumber: `RESTOCK-${receiptRequest._id}`,
          expiryDate: receiptRequest.expiryDate,
          batchDetails: {
            purchaseQuantity: receiptRequest.quantity,
            purchaseUnit: receiptRequest.unit,
            purchaseUnitCost: receiptRequest.purchaseUnitPrice,
            purchaseAmount: receiptRequest.quantity * receiptRequest.purchaseUnitPrice
          },
          recordedBy: req.user._id,
          idempotencyKey: `stock-receipt-request:${receiptRequest._id}`,
          session
        });
        receiptRequest.movementId = movementResult.movement._id;
        receiptRequest.batchNumber = movementResult.movement.batchNumber || '';
        if (receiptRequest.wastageQuantity > 0) {
          const wastageItem = await InventoryItem.findOne({
            _id: receiptRequest.itemId,
            hotelId: req.hotelId,
            propertyId: req.propertyId
          }).select('baseUnit unit').session(session);
          if (!wastageItem) {
            throw Object.assign(new Error('Raw material not found while recording receipt wastage.'), { statusCode: 404 });
          }
          const freshBatch = await InventoryBatch.findOne({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: receiptRequest.itemId,
            location: receiptRequest.location,
            batchNumber: movementResult.movement.batchNumber
          }).sort({ receivedAt: -1, _id: -1 }).session(session);
          if (!freshBatch) {
            throw Object.assign(new Error('Fresh receipt batch not found while recording its wastage.'), { statusCode: 409 });
          }
          const wastageBatchIds = receiptRequest.existingStockDeduction > 0
            ? [...previousBatchIds, freshBatch._id]
            : [freshBatch._id];
          const availableForWastage = await InventoryBatch.find({
            _id: { $in: wastageBatchIds },
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: receiptRequest.itemId,
            location: receiptRequest.location,
            remainingQuantity: { $gt: 0 },
            $or: [{ expiryDate: null }, { expiryDate: { $gt: new Date() } }]
          }).session(session);
          const usableWastageQuantity = availableForWastage.reduce(
            (total, batch) => total + batch.remainingQuantity, 0
          );
          if (usableWastageQuantity < receiptRequest.wastageQuantity) {
            throw Object.assign(new Error(
              `Only ${usableWastageQuantity} ${wastageItem.baseUnit || wastageItem.unit} remain in eligible batches for this wastage.`
            ), { statusCode: 409 });
          }
          let quantityToReference = receiptRequest.wastageQuantity;
          const affectedBatches = [];
          for (const batch of availableForWastage.sort((left, right) => (
            new Date(left.receivedAt) - new Date(right.receivedAt)
            || String(left._id).localeCompare(String(right._id))
          ))) {
            if (quantityToReference <= 0) break;
            const allocatedQuantity = Math.min(batch.remainingQuantity, quantityToReference);
            if (allocatedQuantity > 0) {
              affectedBatches.push(batch);
              quantityToReference = Math.max(0, quantityToReference - allocatedQuantity);
            }
          }
          const affectedBatchNumbers = affectedBatches.map((batch) => batch.batchNumber || String(batch._id));
          const wastageResult = await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: receiptRequest.itemId,
            movementType: 'wastage',
            quantity: receiptRequest.wastageQuantity,
            unit: wastageItem.baseUnit || wastageItem.unit,
            batchIds: wastageBatchIds,
            batchNumber: affectedBatchNumbers[0] || '',
            location: receiptRequest.location,
            department: receiptRequest.department,
            notes: `Wastage during stock receipt: ${receiptRequest.wastageReason}. Affected batches: ${affectedBatchNumbers.join(', ')}.`,
            referenceNumber: `RESTOCK-WASTE-${receiptRequest._id}`,
            recordedBy: req.user._id,
            idempotencyKey: `stock-receipt-request-wastage:${receiptRequest._id}`,
            metadata: {
              reason: receiptRequest.wastageReason,
              source: 'raw_material_receipt',
              stockReceiptRequestId: String(receiptRequest._id),
              batchNumbers: affectedBatchNumbers
            },
            session
          });
          receiptRequest.wastageMovementId = wastageResult.movement._id;
        }
      }
      await receiptRequest.save({ session });
      return receiptRequest;
    });
    await logAudit({
      hotelId: req.hotelId,
      action: `STOCK_RECEIPT_REQUEST_${decision.toUpperCase()}`,
      entity: 'StockReceiptRequest',
      entityId: result._id,
      details: {
        itemId: String(result.itemId),
        quantity: result.quantity,
        previousAvailableQuantity: result.previousAvailableQuantity,
        existingStockDeduction: result.existingStockDeduction,
        remainingPreviousStockAfterDeduction: result.remainingPreviousStockAfterDeduction,
        wastageQuantity: result.wastageQuantity,
        wastageUnit: result.wastageUnit,
        wastageReason: result.wastageReason,
        wastageMovementId: result.wastageMovementId,
        batchNumber: result.batchNumber
      },
      req
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const updateInventoryItem = async (req, res, next) => {
  try {
    const allowedFields = [
      'name', 'code', 'category', 'description', 'unit', 'unitCost', 'sellingPrice',
      'minStockThreshold', 'maxStockLevel', 'reorderQuantity', 'vendorId', 'barcode',
      'trackExpiry', 'trackBatchNumber', 'unitConversions', 'isActive', 'location',
      'stockVerificationIntervalDays',
      'baseUnit', 'purchaseUnit', 'purchaseConversionFactor', 'purchasePrice', 'packagingOptions'
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([field]) => allowedFields.includes(field))
    );
    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Provide at least one supported inventory item field to update.' });
    }
    if (updates.name !== undefined && !String(updates.name).trim()) {
      return res.status(400).json({ success: false, message: 'Item name cannot be empty.' });
    }
    if (updates.code !== undefined) updates.code = String(updates.code).trim().toUpperCase();
    const currentItem = await InventoryItem.findOne({
      _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId
    });
    if (!currentItem) return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    if (updates.unit !== undefined && updates.baseUnit === undefined) updates.baseUnit = updates.unit;
    if (updates.baseUnit !== undefined && updates.unit === undefined) updates.unit = updates.baseUnit;
    if (updates.baseUnit !== undefined
      && normalizeInventoryUnit(updates.baseUnit) !== normalizeInventoryUnit(currentItem.baseUnit || currentItem.unit)) {
      const hasHistory = currentItem.currentStock > 0
        || await StockMovement.exists({ itemId: currentItem._id, hotelId: req.hotelId, propertyId: req.propertyId })
        || await InventoryRecipe.exists({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          $or: [{ 'ingredients.itemId': currentItem._id }, { 'ingredients.substitutions.itemId': currentItem._id }]
        })
        || await PurchaseOrder.exists({
          hotelId: req.hotelId, propertyId: req.propertyId, 'items.itemId': currentItem._id
        })
        || await DepartmentRequest.exists({
          hotelId: req.hotelId, propertyId: req.propertyId, 'lines.itemId': currentItem._id
        })
        || await MinibarStock.exists({ hotelId: req.hotelId, propertyId: req.propertyId, itemId: currentItem._id })
        || await MinibarTransaction.exists({ hotelId: req.hotelId, propertyId: req.propertyId, itemId: currentItem._id });
      if (hasHistory) {
        return res.status(409).json({ success: false, message: 'Base unit cannot be changed after stock or recipe history exists. Create a new item and transfer stock instead.' });
      }
    }
    if (['unit', 'baseUnit', 'purchaseUnit', 'purchaseConversionFactor', 'unitConversions', 'packagingOptions'].some((field) => updates[field] !== undefined)) {
      const baseUnit = updates.baseUnit || currentItem.baseUnit || currentItem.unit;
      const purchaseUnit = updates.purchaseUnit || currentItem.purchaseUnit || baseUnit;
      const storedConversions = currentItem.unitConversions instanceof Map
        ? Object.fromEntries(currentItem.unitConversions)
        : currentItem.unitConversions?.toObject?.() || currentItem.unitConversions || {};
      let packagingOptions = updates.packagingOptions || currentItem.packagingOptions || [];
      if (updates.purchaseConversionFactor !== undefined && updates.packagingOptions === undefined) {
        packagingOptions = packagingOptions.map((option) => (
          normalizeInventoryUnit(option.unit) === normalizeInventoryUnit(purchaseUnit)
            ? {
              ...(typeof option.toObject === 'function' ? option.toObject() : option),
              conversionFactor: Number(updates.purchaseConversionFactor)
            }
            : option
        ));
      }
      const packageFactor = packagingOptions.find((option) => (
        normalizeInventoryUnit(option.unit) === normalizeInventoryUnit(purchaseUnit)
      ))?.conversionFactor;
      const unitConversions = updates.unitConversions ?? (
        updates.purchaseConversionFactor !== undefined && normalizeInventoryUnit(purchaseUnit) !== normalizeInventoryUnit(baseUnit)
          ? { ...storedConversions, [normalizeInventoryUnit(purchaseUnit)]: Number(updates.purchaseConversionFactor) }
          : currentItem.unitConversions
      );
      const configuration = getItemUnitConfiguration({
        ...currentItem.toObject(),
        ...updates,
        unit: baseUnit,
        baseUnit,
        unitConversions,
        packagingOptions,
        purchaseConversionFactor: updates.purchaseConversionFactor
          ?? ((updates.purchaseUnit !== undefined || updates.packagingOptions !== undefined)
            ? packageFactor
            : currentItem.purchaseConversionFactor)
      });
      Object.assign(updates, configuration, { unit: configuration.baseUnit });
    }
    if (updates.purchaseUnit !== undefined
      && normalizeInventoryUnit(updates.purchaseUnit) !== normalizeInventoryUnit(currentItem.purchaseUnit || currentItem.baseUnit || currentItem.unit)
      && updates.purchasePrice === undefined) {
      updates.purchasePrice = null;
    }
    if (updates.purchasePrice !== undefined
      || (updates.purchaseConversionFactor !== undefined
        && updates.purchaseUnit === undefined
        && currentItem.purchasePrice !== null)) {
      const factor = updates.purchaseConversionFactor
        ?? currentItem.purchaseConversionFactor
        ?? 1;
      updates.unitCost = Number(updates.purchasePrice ?? currentItem.purchasePrice) / factor;
    }
    const item = await InventoryItem.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: item._id,
      details: updates,
      req
    });
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

export const createInventoryItem = async (req, res, next) => {
  try {
    if (req.body.inventoryType === 'raw_material') {
      return res.status(400).json({
        success: false,
        message: 'Create raw materials through the Raw Material Master so categories and unit conversions are validated.'
      });
    }
    const {
      name, code, currentStock = 0, minStockThreshold = 0, unitCost = 0, purchasePrice,
      openingUnit, openingBatchNumber = '', openingExpiryDate = null, baseUnitId, purchaseUnitId,
      conversionFactor, additionalPackagingOptions = [], ...details
    } = req.body;
    const openingStock = Number(currentStock);
    const unitConfiguration = await resolveItemUnits({
      hotelId: req.hotelId,
      baseUnitId,
      purchaseUnitId,
      conversionFactor: conversionFactor ?? details.purchaseConversionFactor,
      additionalPackagingOptions
    });
    const baseUnitCost = purchasePrice !== undefined
      ? Number(purchasePrice) / unitConfiguration.purchaseConversionFactor
      : Number(unitCost);
    if (!name?.trim() || !code?.trim() || !Number.isFinite(openingStock) || openingStock < 0
      || !Number.isFinite(Number(minStockThreshold)) || Number(minStockThreshold) < 0
      || !Number.isFinite(baseUnitCost) || baseUnitCost < 0
      || (purchasePrice !== undefined && (!Number.isFinite(Number(purchasePrice)) || Number(purchasePrice) < 0))) {
      return res.status(400).json({ success: false, message: 'Name, item code, and valid non-negative stock, minimum level, and purchase price are required.' });
    }

    const item = await runInventoryTransaction(async (session) => {
      const [created] = await InventoryItem.create([{
        ...details,
        ...unitConfiguration,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        unit: unitConfiguration.baseUnit,
        baseUnit: unitConfiguration.baseUnit,
        purchasePrice: purchasePrice === undefined ? null : Number(purchasePrice),
        currentStock: 0,
        minStockThreshold: Number(minStockThreshold),
        unitCost: baseUnitCost,
        hotelId: req.hotelId,
        propertyId: req.propertyId
      }], { session });
      if (openingStock > 0) {
        await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: created._id,
          movementType: 'opening',
          quantity: openingStock,
          unit: openingUnit || unitConfiguration.baseUnit,
          location: details.location || 'Main Store',
          batchNumber: openingBatchNumber,
          expiryDate: openingExpiryDate ? new Date(openingExpiryDate) : null,
          referenceNumber: generateReference('OPEN'),
          notes: 'Opening inventory balance',
          recordedBy: req.user._id,
          idempotencyKey: `opening:${created._id}`,
          session
        });
      }
      return InventoryItem.findById(created._id).session(session);
    });
    await notifyHotelOperations({
      hotelId: req.hotelId,
      title: 'Inventory item added',
      message: 'A new inventory item was added.',
      module: 'inventory',
      eventType: 'inventory_item_created',
      relatedRecordId: item._id,
      link: '/inventory',
      eventId: `inventory-item-created:${item._id}`
    });

    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

/**
 * Record Stock Movement (Audit Ledger)
 */
export const recordStockMovement = async (req, res, next) => {
  try {
    const {
      itemId, movementType, quantity, notes, referenceNumber, location, department, idempotencyKey
    } = req.body;
    const receiptLocation = String(location || 'Main Store').trim() || 'Main Store';
    const transactionReferenceNumber = referenceNumber || generateReference('MOV');
    const autoGenerateBatchNumber = req.body.autoGenerateBatchNumber === true;
    const hasWastageQuantity = req.body.wastageQuantity !== undefined;
    const wastageQuantity = hasWastageQuantity ? Number(req.body.wastageQuantity) : 0;
    const existingStockDeductionQuantity = Number(req.body.existingStockDeductionQuantity || 0);
    if (hasWastageQuantity && (!Number.isFinite(wastageQuantity) || wastageQuantity < 0)) {
      return res.status(400).json({ success: false, message: 'Enter a valid non-negative wastage quantity.' });
    }
    if (!Number.isFinite(existingStockDeductionQuantity) || existingStockDeductionQuantity < 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid non-negative existing-stock deduction.' });
    }
    if (wastageQuantity > 0
      && (movementType !== 'receipt' || !autoGenerateBatchNumber
        || !String(req.body.wastageUnit || '').trim() || !String(req.body.wastageReason || '').trim())) {
      return res.status(400).json({ success: false, message: 'Wastage requires a raw-material receipt, configured wastage unit, and reason.' });
    }
    if (existingStockDeductionQuantity > 0 && (movementType !== 'receipt' || !autoGenerateBatchNumber)) {
      return res.status(400).json({ success: false, message: 'Existing-stock deductions require a raw-material receipt.' });
    }
    if (!['receipt', 'issue', 'adjustment', 'wastage', 'return'].includes(movementType)) {
      return res.status(400).json({ success: false, message: 'Unsupported stock movement type.' });
    }
    if (autoGenerateBatchNumber && movementType !== 'receipt') {
      return res.status(400).json({ success: false, message: 'Automatic batch numbers are only available for stock receipts.' });
    }
    let receiptMaterial = null;
    let wastageUnitEntry = null;
    let deductionUnitEntry = null;
    let wastageReason = '';
    let wastageBaseQuantity = 0;
    let existingStockDeduction = 0;
    if (autoGenerateBatchNumber) {
      receiptMaterial = await InventoryItem.findOne({
        _id: itemId,
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        inventoryType: 'raw_material',
        isActive: true
      }).select('_id baseUnit unit supportedUnits').lean();
      if (!receiptMaterial) {
        return res.status(400).json({ success: false, message: 'Choose an active raw material for this stock receipt.' });
      }
      if (!Number.isFinite(Number(req.body.purchaseUnitPrice)) || Number(req.body.purchaseUnitPrice) < 0) {
        return res.status(400).json({ success: false, message: 'Enter a valid purchase price for the selected purchase unit.' });
      }
      if (wastageQuantity > 0) {
        const selectedReceiptUnit = getConfiguredRawMaterialUnit(receiptMaterial, req.body.unit);
        wastageUnitEntry = getConfiguredRawMaterialUnit(receiptMaterial, req.body.wastageUnit);
        wastageReason = String(req.body.wastageReason).trim();
        if (!selectedReceiptUnit || !wastageUnitEntry) {
          return res.status(400).json({ success: false, message: 'Choose configured purchase and wastage units for this raw material.' });
        }
        wastageBaseQuantity = quantityInBaseUnit(
          wastageQuantity,
          wastageUnitEntry.conversionFactorToBase
        );
        const receiptBaseQuantity = quantityInBaseUnit(
          Number(quantity),
          selectedReceiptUnit.conversionFactorToBase
        );
        if (!Number.isFinite(wastageBaseQuantity) || wastageBaseQuantity <= 0
          || !Number.isFinite(receiptBaseQuantity) || receiptBaseQuantity <= 0) {
          return res.status(400).json({
            success: false,
            message: `Enter valid receipt and wastage quantities in ${receiptMaterial.baseUnit || receiptMaterial.unit}.`
          });
        }
      }
      if (existingStockDeductionQuantity > 0) {
        deductionUnitEntry = getConfiguredRawMaterialUnit(
          receiptMaterial,
          req.body.existingStockDeductionUnit || receiptMaterial.baseUnit || receiptMaterial.unit
        );
        if (!deductionUnitEntry) {
          return res.status(400).json({ success: false, message: 'Choose a configured unit for the existing-stock deduction.' });
        }
        existingStockDeduction = quantityInBaseUnit(
          existingStockDeductionQuantity,
          deductionUnitEntry.conversionFactorToBase
        );
      }
    }
    let vendorId = null;
    if (req.body.vendorId) {
      const vendor = await Vendor.findOne({
        _id: req.body.vendorId,
        hotelId: req.hotelId,
        status: 'active'
      }).select('_id');
      if (!vendor) {
        return res.status(400).json({ success: false, message: 'Choose an active vendor belonging to this hotel.' });
      }
      vendorId = vendor._id;
    }
    if (movementType === 'adjustment' && !isAdministrator(req.user)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can post direct stock adjustments.' });
    }
    if (!isAdministrator(req.user) && movementType !== 'issue') {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can receive stock or post direct stock adjustments.' });
    }
    if (movementType === 'issue' && !department?.trim()) {
      return res.status(400).json({ success: false, message: 'Department is required for stock issues.' });
    }

    const movementIdempotencyKey = idempotencyKey || req.get('Idempotency-Key');
    const result = await runInventoryTransaction(async (session) => {
      let deductionMovement = null;
      let previousBatchIds = [];
      let previousBatchNumbers = new Map();
      if (existingStockDeduction > 0 || wastageBaseQuantity > 0) {
        const previousBatches = await InventoryBatch.find({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId,
          location: receiptLocation,
          remainingQuantity: { $gt: 0 }
        }).sort({ receivedAt: 1, _id: 1 }).session(session);
        const previousAvailableQuantity = previousBatches.reduce(
          (total, batch) => total + batch.remainingQuantity, 0
        );
        if (existingStockDeduction > previousAvailableQuantity) {
          throw Object.assign(new Error(
            `The existing-stock deduction cannot exceed the ${previousAvailableQuantity} ${receiptMaterial.baseUnit || receiptMaterial.unit} available in earlier batches.`
          ), { statusCode: 409 });
        }
        previousBatchIds = previousBatches.map((batch) => batch._id);
        previousBatchNumbers = new Map(previousBatches.map((batch) => [
          String(batch._id),
          batch.batchNumber || String(batch._id)
        ]));
        const wastageEligibleQuantity = quantityInBaseUnit(
          Number(quantity),
          getConfiguredRawMaterialUnit(receiptMaterial, req.body.unit)?.conversionFactorToBase || 0
        ) + (existingStockDeduction > 0 ? previousAvailableQuantity - existingStockDeduction : 0);
        if (wastageBaseQuantity > wastageEligibleQuantity) {
          throw Object.assign(new Error(
            `Wastage cannot exceed the ${receiptMaterial.baseUnit || receiptMaterial.unit} stock eligible after the existing-stock deduction and fresh receipt.`
          ), { statusCode: 400 });
        }
        if (existingStockDeduction > 0) {
          const deductionResult = await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId,
            movementType: 'issue',
            quantity: existingStockDeduction,
            unit: receiptMaterial.baseUnit || receiptMaterial.unit,
            batchIds: previousBatchIds,
            location: receiptLocation,
            department: department || '',
            notes: 'Existing stock deducted during raw-material restock.',
            referenceNumber: `${transactionReferenceNumber}-USE`,
            recordedBy: req.user._id,
            idempotencyKey: movementIdempotencyKey ? `${movementIdempotencyKey}:existing-stock-deduction` : undefined,
            session
          });
          deductionMovement = deductionResult.movement;
        }
      }
      const receiptResult = await postStockMovement({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        itemId,
        movementType,
        quantity,
        unit: req.body.unit,
        unitCost: req.body.unitCost,
        purchaseUnitPrice: req.body.purchaseUnitPrice,
        vendorId,
        autoGenerateBatchNumber,
        purchasePackageId: req.body.purchasePackageId || null,
        packageQuantity: req.body.packageQuantity,
        looseQuantity: req.body.looseQuantity,
        notes: notes || '',
        referenceNumber: transactionReferenceNumber,
        location: movementType === 'receipt' ? receiptLocation : location || 'Main Store',
        department: department || '',
        batchNumber: req.body.batchNumber || '',
        expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
        batchDetails: req.body.purchaseUnitPrice !== undefined ? {
          purchaseQuantity: Number(quantity),
          purchaseUnit: req.body.unit || '',
          purchaseUnitCost: Number(req.body.purchaseUnitPrice),
          purchaseAmount: Number(quantity) * Number(req.body.purchaseUnitPrice)
        } : {},
        recordedBy: req.user._id,
        idempotencyKey: movementIdempotencyKey,
        session
      });
      if (receiptResult.duplicate || wastageBaseQuantity <= 0) {
        return { ...receiptResult, deductionMovement };
      }

      const freshBatch = await InventoryBatch.findOne({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        itemId,
        location: receiptLocation,
        batchNumber: receiptResult.movement.batchNumber
      }).sort({ receivedAt: -1, _id: -1 }).session(session);
      if (!freshBatch) {
        throw Object.assign(new Error('Fresh receipt batch was not found while recording its wastage.'), { statusCode: 409 });
      }
      previousBatchNumbers.set(
        String(freshBatch._id),
        freshBatch.batchNumber || String(freshBatch._id)
      );
      const wastageResult = await postStockMovement({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        itemId,
        movementType: 'wastage',
        quantity: wastageBaseQuantity,
        unit: receiptMaterial.baseUnit || receiptMaterial.unit,
        batchIds: existingStockDeduction > 0
          ? [...previousBatchIds, freshBatch._id]
          : [freshBatch._id],
        batchNumber: freshBatch.batchNumber || '',
        location: receiptLocation,
        department: department || '',
        notes: `Wastage during stock receipt: ${wastageReason}.`,
        referenceNumber: `${receiptResult.movement.referenceNumber}-WASTE`,
        recordedBy: req.user._id,
        idempotencyKey: movementIdempotencyKey ? `${movementIdempotencyKey}:wastage` : undefined,
        metadata: {
          reason: wastageReason,
          source: 'raw_material_receipt',
          receiptMovementId: String(receiptResult.movement._id)
        },
        session
      });
      wastageResult.movement.metadata = {
        ...wastageResult.movement.metadata,
        batchNumbers: wastageResult.movement.batchAllocations.map((allocation) => (
          previousBatchNumbers.get(String(allocation.batchId)) || 'legacy'
        ))
      };
      await wastageResult.movement.save({ session });
      return {
        ...wastageResult,
        movement: receiptResult.movement,
        wastageMovement: wastageResult.movement,
        deductionMovement
      };
    });
    if (result.duplicate) {
      return res.json({ success: true, message: 'Stock movement was already recorded.', data: { movement: result.movement } });
    }
    const { movement, item } = result;
    if (result.wastageMovement) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'RECORD_RAW_MATERIAL_WASTAGE',
        entity: 'StockMovement',
        entityId: result.wastageMovement._id,
        details: {
          itemId: String(itemId),
          receiptMovementId: String(movement._id),
          wastageMovementId: String(result.wastageMovement._id),
          quantity: result.wastageMovement.quantity,
          unit: receiptMaterial.baseUnit || receiptMaterial.unit,
          enteredQuantity: wastageQuantity,
          enteredUnit: normalizeInventoryUnit(req.body.wastageUnit),
          reason: wastageReason,
          batchAllocations: result.wastageMovement.batchAllocations
        },
        req
      });
    }

    // Check low stock trigger
    if (item.currentStock <= item.minStockThreshold) {
      await notifyRoles({
        hotelId: req.hotelId,
        roles: ['hotel_admin', 'restaurant_staff'],
        title: 'Low Stock Alert',
        message: `An inventory item is below its minimum stock threshold (${item.currentStock} ${item.unit}).`,
        module: 'inventory',
        eventType: 'inventory_low_stock',
        relatedRecordId: item._id,
        priority: 'high',
        link: '/inventory',
        eventId: `low-stock:${movement._id}`
      });
    }

    res.status(201).json({
      success: true,
      message: 'Stock movement recorded successfully.',
      data: {
        movement,
        item,
        wastageMovement: result.wastageMovement || null,
        deductionMovement: result.deductionMovement || null
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getVendors = async (req, res, next) => {
  try {
    const vendors = await Vendor.find({ hotelId: req.hotelId }).populate('suppliedItems', 'name code unit').sort({ name: 1 });
    res.json({ success: true, data: vendors });
  } catch (err) {
    next(err);
  }
};

export const createVendor = async (req, res, next) => {
  try {
    const {
      name, contactPerson = '', email = '', phone, address = '',
      taxNumber = req.body.gstNumber || '', paymentTerms = 'Net 30', suppliedItems = []
    } = req.body;
    if (!name?.trim() || !phone?.trim()) {
      return res.status(400).json({ success: false, message: 'Vendor name and phone number are required.' });
    }
    if (!Array.isArray(suppliedItems)) {
      return res.status(400).json({ success: false, message: 'Supplied items must be a list.' });
    }
    if (suppliedItems.length) {
      const count = await InventoryItem.countDocuments({
        _id: { $in: suppliedItems }, hotelId: req.hotelId, propertyId: req.propertyId
      });
      if (count !== new Set(suppliedItems.map(String)).size) {
        return res.status(400).json({ success: false, message: 'Vendor contains an item from another property or an invalid item.' });
      }
    }
    const vendor = await Vendor.create({
      name: name.trim(),
      contactPerson,
      email,
      phone,
      address,
      taxNumber,
      paymentTerms,
      suppliedItems,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: vendor });
  } catch (err) {
    next(err);
  }
};

export const updateVendor = async (req, res, next) => {
  try {
    const allowedFields = [
      'name', 'contactPerson', 'email', 'phone', 'address', 'taxNumber',
      'paymentTerms', 'status', 'suppliedItems'
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([field]) => allowedFields.includes(field))
    );
    if (req.body.gstNumber !== undefined && updates.taxNumber === undefined) {
      updates.taxNumber = req.body.gstNumber;
    }
    if (updates.suppliedItems) {
      if (!Array.isArray(updates.suppliedItems)) {
        return res.status(400).json({ success: false, message: 'Supplied items must be a list.' });
      }
      const count = await InventoryItem.countDocuments({
        _id: { $in: updates.suppliedItems }, hotelId: req.hotelId, propertyId: req.propertyId
      });
      if (count !== new Set(updates.suppliedItems.map(String)).size) {
        return res.status(400).json({ success: false, message: 'Vendor contains an item from another property or an invalid item.' });
      }
    }
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('suppliedItems', 'name code unit');
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });
    res.json({ success: true, data: vendor });
  } catch (err) {
    next(err);
  }
};

export const getVendorPurchases = async (req, res, next) => {
  try {
    const vendorExists = await Vendor.exists({ _id: req.params.id, hotelId: req.hotelId });
    if (!vendorExists) return res.status(404).json({ success: false, message: 'Vendor not found.' });
    const data = await PurchaseOrder.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      vendorId: req.params.id
    }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getVendorPayments = async (req, res, next) => {
  try {
    const vendorExists = await Vendor.exists({ _id: req.params.id, hotelId: req.hotelId });
    if (!vendorExists) return res.status(404).json({ success: false, message: 'Vendor not found.' });
    const data = await SupplierPayment.find({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      vendorId: req.params.id
    }).populate('recordedBy', 'name').sort({ paidAt: -1 }).limit(200).lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const recordVendorPayment = async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Vendor payment amount must be positive.' });
    }
    const key = req.body.idempotencyKey || req.get('Idempotency-Key');
    const payment = await runInventoryTransaction(async (session) => {
      if (key) {
        const duplicate = await SupplierPayment.findOne({
          hotelId: req.hotelId, propertyId: req.propertyId, idempotencyKey: key
        }).session(session);
        if (duplicate) return { payment: duplicate, duplicate: true };
      }
      const vendor = await Vendor.findOneAndUpdate({
        _id: req.params.id,
        hotelId: req.hotelId,
        $expr: { $gte: [{ $ifNull: ['$outstandingBalance', 0] }, amount] }
      }, { $inc: { outstandingBalance: -amount } }, { new: true, session });
      if (!vendor) {
        throw Object.assign(new Error('Vendor not found or payment exceeds the outstanding balance.'), { statusCode: 409 });
      }
      const [created] = await SupplierPayment.create([{
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        vendorId: vendor._id,
        amount,
        paymentMethod: req.body.paymentMethod || 'bank_transfer',
        referenceNumber: req.body.referenceNumber || '',
        invoiceNumber: req.body.invoiceNumber || '',
        notes: req.body.notes || '',
        idempotencyKey: key || undefined,
        recordedBy: req.user._id
      }], { session });
      return { payment: created, duplicate: false };
    });
    if (!payment.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'RECORD_SUPPLIER_PAYMENT',
        entity: 'SupplierPayment',
        entityId: payment.payment._id,
        details: { vendorId: req.params.id, amount },
        req
      });
    }
    res.status(payment.duplicate ? 200 : 201).json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

export const getPurchaseOrders = async (req, res, next) => {
  try {
    const pos = await PurchaseOrder.find({ hotelId: req.hotelId, propertyId: req.propertyId })
      .populate('vendorId', 'name contactPerson email phone')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: pos });
  } catch (err) {
    next(err);
  }
};

export const createPurchaseOrder = async (req, res, next) => {
  try {
    const { vendorId, items, expectedDeliveryDate, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one purchase order item is required.' });
    }
    const vendor = await Vendor.findOne({ _id: vendorId, hotelId: req.hotelId, status: 'active' });
    if (!vendor) return res.status(400).json({ success: false, message: 'An active vendor is required.' });
    const purchaseLines = [];
    for (const line of items) {
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0
        || !Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0) {
        return res.status(400).json({ success: false, message: 'Purchase quantities must be positive and unit prices cannot be negative.' });
      }
      const inventoryItem = await InventoryItem.findOne({
        _id: line.itemId, hotelId: req.hotelId, propertyId: req.propertyId, isActive: true
      }).select('name unit baseUnit baseUnitId purchaseUnit purchaseUnitId preferredPurchaseUnitId purchaseConversionFactor packagingOptions additionalPackagingOptions unitConversions inventoryType supportedUnits');
      if (!inventoryItem) return res.status(400).json({ success: false, message: 'Purchase order contains an invalid inventory item.' });
      let configuredPurchaseUnit = null;
      if (inventoryItem.inventoryType === 'raw_material') {
        const activePurchaseUnits = inventoryItem.supportedUnits.filter((supportedUnit) => supportedUnit.isActive);
        configuredPurchaseUnit = line.purchasePackageId
          ? activePurchaseUnits.find((supportedUnit) => String(supportedUnit._id) === String(line.purchasePackageId))
          : line.unitId
            ? activePurchaseUnits.find((supportedUnit) => String(supportedUnit.unitId) === String(line.unitId)
              && supportedUnit.isDefaultPurchaseUnit)
              || activePurchaseUnits.find((supportedUnit) => String(supportedUnit.unitId) === String(line.unitId))
            : line.unit
              ? activePurchaseUnits.find((supportedUnit) => (
                normalizeInventoryUnit(supportedUnit.unitSymbolSnapshot)
                === normalizeInventoryUnit(line.unit)
              ) && supportedUnit.isDefaultPurchaseUnit)
                || activePurchaseUnits.find((supportedUnit) => (
                  normalizeInventoryUnit(supportedUnit.unitSymbolSnapshot)
                  === normalizeInventoryUnit(line.unit)
                ))
              : activePurchaseUnits.find((supportedUnit) => supportedUnit.isDefaultPurchaseUnit)
                || activePurchaseUnits.find((supportedUnit) => String(supportedUnit.unitId) === String(inventoryItem.preferredPurchaseUnitId));
        if (!configuredPurchaseUnit) {
          return res.status(400).json({
            success: false,
            message: `Choose an active purchase unit configured for ${inventoryItem.name}.`
          });
        }
      }
      const purchaseUnit = normalizeInventoryUnit(
        configuredPurchaseUnit?.unitSymbolSnapshot
          || line.unit
          || inventoryItem.purchaseUnit
          || inventoryItem.baseUnit
          || inventoryItem.unit
      );
      const conversionFactor = configuredPurchaseUnit
        ? Number(configuredPurchaseUnit.conversionFactorToBase)
        : getUnitConversionFactor(inventoryItem, purchaseUnit);
      const configuredUnitId = configuredPurchaseUnit?.unitId
        || (purchaseUnit === inventoryItem.baseUnit
        ? inventoryItem.baseUnitId
        : purchaseUnit === inventoryItem.purchaseUnit
          ? inventoryItem.purchaseUnitId
          : inventoryItem.packagingOptions.find((option) => option.unit === purchaseUnit)?.unitId
            || inventoryItem.additionalPackagingOptions.find((option) => String(option.unitId) === String(line.unitId))?.unitId);
      const requestedUnit = configuredUnitId
        ? await Unit.findOne({
          _id: configuredUnitId,
          hotelId: req.hotelId,
          ...(configuredPurchaseUnit ? { isActive: true } : {})
        })
        : await Unit.findOne({ hotelId: req.hotelId, symbolKey: purchaseUnit.toLocaleLowerCase(), isActive: true });
      if (!requestedUnit) return res.status(400).json({ success: false, message: 'Purchase unit is not an active unit for this hotel.' });
      if (!configuredUnitId && inventoryItem.baseUnitId) {
        const baseUnitRecord = await Unit.findOne({ _id: inventoryItem.baseUnitId, hotelId: req.hotelId }).select('category');
        if (!baseUnitRecord || requestedUnit.category !== baseUnitRecord.category) {
          return res.status(400).json({ success: false, message: 'Purchase unit is not compatible with the item base unit.' });
        }
      }
      const baseUnitRecord = inventoryItem.baseUnitId
        ? await Unit.findOne({ _id: inventoryItem.baseUnitId, hotelId: req.hotelId }).select('name symbol')
        : null;
      const packageConfigured = Number(configuredPurchaseUnit?.packageSize) > 0
        && Boolean(configuredPurchaseUnit?.packageMeasurementUnitId);
      purchaseLines.push({
        itemId: inventoryItem._id,
        itemName: inventoryItem.name,
        quantity: Number(line.quantity),
        unit: purchaseUnit,
        unitId: requestedUnit._id,
        purchasePackageId: packageConfigured ? configuredPurchaseUnit._id : null,
        packageNameSnapshot: packageConfigured ? configuredPurchaseUnit.packageName || configuredPurchaseUnit.unitNameSnapshot : '',
        unitNameSnapshot: packageConfigured
          ? configuredPurchaseUnit.packageName || configuredPurchaseUnit.unitNameSnapshot
          : configuredPurchaseUnit?.unitNameSnapshot || requestedUnit.name,
        unitSymbolSnapshot: configuredPurchaseUnit?.unitSymbolSnapshot || requestedUnit.symbol,
        baseUnit: inventoryItem.baseUnit || inventoryItem.unit,
        baseUnitId: inventoryItem.baseUnitId || null,
        baseUnitNameSnapshot: baseUnitRecord?.name || inventoryItem.baseUnit || inventoryItem.unit,
        baseUnitSymbolSnapshot: baseUnitRecord?.symbol || inventoryItem.baseUnit || inventoryItem.unit,
        conversionFactor,
        unitCost: Number(line.unitCost),
        totalAmount: Number(line.quantity) * Number(line.unitCost)
      });
    }
    const subtotal = purchaseLines.reduce((sum, item) => sum + item.totalAmount, 0);
    const taxAmount = Number(req.body.taxAmount || 0);
    const discountAmount = Number(req.body.discountAmount || 0);
    if (!Number.isFinite(taxAmount) || taxAmount < 0 || !Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) {
      return res.status(400).json({ success: false, message: 'Tax and discount must be valid; discount cannot exceed the subtotal.' });
    }
    const totalAmount = Math.round((subtotal + taxAmount - discountAmount) * 100) / 100;

    const po = await PurchaseOrder.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      poNumber: generateReference('PO'),
      vendorId,
      items: purchaseLines,
      subtotal,
      taxAmount,
      discountAmount,
      totalAmount,
      status: req.body.submitForApproval === true ? 'pending_approval' : 'ordered',
      expectedDeliveryDate,
      notes,
      createdBy: req.user._id
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_INVENTORY_PURCHASE_ORDER',
      entity: 'PurchaseOrder',
      entityId: po._id,
      details: { poNumber: po.poNumber, totalAmount },
      req
    });
    res.status(201).json({ success: true, message: 'Purchase order issued.', data: po });
  } catch (err) {
    next(err);
  }
};

export const receivePurchaseOrder = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId });
    if (!po) {
      return res.status(404).json({ success: false, message: 'Purchase order not found.' });
    }
    const purchaseDate = req.body.purchaseDate ? new Date(req.body.purchaseDate) : new Date();
    if (Number.isNaN(purchaseDate.getTime()) || purchaseDate > new Date()) {
      return res.status(400).json({ success: false, message: 'Purchase date must be valid and cannot be in the future.' });
    }

    const key = req.body.idempotencyKey || req.get('Idempotency-Key');
    const receipt = await runInventoryTransaction(async (session) => {
      if (key) {
        const duplicate = await GoodsReceipt.findOne({
          hotelId: req.hotelId, propertyId: req.propertyId, requestKey: key
        }).session(session);
        if (duplicate) return { receipt: duplicate, duplicate: true, po };
      }

      const currentPO = await PurchaseOrder.findOne({
        _id: req.params.id, hotelId: req.hotelId, propertyId: req.propertyId
      }).session(session);
      if (!currentPO || ['cancelled', 'received'].includes(currentPO.status)) {
        throw Object.assign(new Error('Purchase order is not open for receiving.'), { statusCode: 409 });
      }
      const lines = [];
      for (const poLine of currentPO.items) {
        const input = (req.body.items || []).find((line) => String(line.itemId) === String(poLine.itemId));
        const remaining = Math.max(0, poLine.quantity - (poLine.receivedQuantity || 0));
        const receivedQuantity = input ? Number(input.receivedQuantity) : (req.body.items ? 0 : remaining);
        const acceptedQuantity = input ? Number(input.acceptedQuantity ?? receivedQuantity) : receivedQuantity;
        const damagedQuantity = input ? Number(input.damagedQuantity || 0) : 0;
        const rejectedQuantity = input ? Number(input.rejectedQuantity || 0) : 0;
        if (![receivedQuantity, acceptedQuantity, damagedQuantity, rejectedQuantity].every(Number.isFinite)
          || receivedQuantity < 0 || receivedQuantity > remaining
          || acceptedQuantity < 0 || damagedQuantity < 0 || rejectedQuantity < 0
          || acceptedQuantity + damagedQuantity + rejectedQuantity > receivedQuantity) {
          throw Object.assign(new Error(`Invalid received quantities for ${poLine.itemName}.`), { statusCode: 400 });
        }
        if (receivedQuantity === 0) continue;
        const batchNumber = String(input?.batchNumber || '').trim();
        const expiryDate = input?.expiryDate ? new Date(input.expiryDate) : null;
        if (expiryDate && Number.isNaN(expiryDate.getTime())) {
          throw Object.assign(new Error(`Invalid expiry date for ${poLine.itemName}.`), { statusCode: 400 });
        }
        poLine.receivedQuantity = (poLine.receivedQuantity || 0) + receivedQuantity;
        lines.push({
          itemId: poLine.itemId,
          purchasePackageId: poLine.purchasePackageId || null,
          packageNameSnapshot: poLine.packageNameSnapshot || '',
          unit: poLine.unit || '',
          unitId: poLine.unitId || null,
          unitNameSnapshot: poLine.unitNameSnapshot || poLine.unit || '',
          unitSymbolSnapshot: poLine.unitSymbolSnapshot || poLine.unit || '',
          baseUnit: poLine.baseUnit || '',
          baseUnitId: poLine.baseUnitId || null,
          baseUnitNameSnapshot: poLine.baseUnitNameSnapshot || poLine.baseUnit || '',
          baseUnitSymbolSnapshot: poLine.baseUnitSymbolSnapshot || poLine.baseUnit || '',
          conversionFactor: poLine.conversionFactor || 1,
          receivedQuantity,
          acceptedQuantity,
          damagedQuantity,
          rejectedQuantity,
          batchNumber,
          expiryDate,
          unitCost: poLine.unitCost
        });
        if (acceptedQuantity > 0) {
          await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: poLine.itemId,
            movementType: 'receipt',
            quantity: acceptedQuantity,
            unit: poLine.unit,
            unitId: poLine.unitId,
            conversionFactor: poLine.conversionFactor || 1,
            purchasePackageId: poLine.purchasePackageId || null,
            purchasePackageName: poLine.packageNameSnapshot || '',
            purchasePackageSnapshot: Boolean(poLine.purchasePackageId),
            unitCost: poLine.unitCost / (poLine.conversionFactor || 1),
            location: req.body.location || 'Main Store',
            referenceNumber: currentPO.poNumber,
            notes: `Goods receipt for purchase order ${currentPO.poNumber}`,
            recordedBy: req.user._id,
            idempotencyKey: `grn:${key || currentPO._id + ':' + currentPO.items.indexOf(poLine)}:${lines.length}`,
            batchNumber,
            expiryDate,
            transactionDate: purchaseDate,
            receivedAt: purchaseDate,
            batchDetails: {
              purchaseQuantity: acceptedQuantity,
              purchaseUnit: poLine.unit || '',
              purchaseUnitCost: poLine.unitCost,
              purchaseAmount: Math.round(acceptedQuantity * poLine.unitCost * 100) / 100,
              vendorId: currentPO.vendorId,
              purchaseOrderId: currentPO._id,
              invoiceNumber: String(req.body.invoiceNumber || '').trim()
            },
            session
          });
        }
      }
      if (!lines.length) throw Object.assign(new Error('Enter at least one received purchase order line.'), { statusCode: 400 });
      const [createdReceipt] = await GoodsReceipt.create([{
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        purchaseOrderId: currentPO._id,
        receiptNumber: generateReference('GRN'),
        requestKey: key || undefined,
        invoiceNumber: req.body.invoiceNumber || '',
        invoiceAttachment: req.body.invoiceAttachment || '',
        location: req.body.location || 'Main Store',
        lines,
        receivedBy: req.user._id,
        receivedAt: purchaseDate,
        notes: req.body.notes || ''
      }], { session });
      const receivedSubtotal = lines.reduce(
        (sum, line) => sum + line.acceptedQuantity * line.unitCost,
        0
      );
      const purchaseSubtotal = currentPO.subtotal
        || currentPO.items.reduce((sum, line) => sum + line.totalAmount, 0);
      const taxAndDiscount = currentPO.taxAmount - currentPO.discountAmount;
      const payableAmount = purchaseSubtotal > 0
        ? receivedSubtotal + taxAndDiscount * (receivedSubtotal / purchaseSubtotal)
        : receivedSubtotal;
      if (payableAmount > 0) {
        await Vendor.updateOne(
          { _id: currentPO.vendorId, hotelId: req.hotelId },
          { $inc: { outstandingBalance: Math.round(payableAmount * 100) / 100 } },
          { session }
        );
      }
      currentPO.receivingHistory.push(createdReceipt._id);
      const fullyReceived = currentPO.items.every((line) => line.receivedQuantity >= line.quantity);
      currentPO.status = fullyReceived ? 'received' : 'partially_received';
      if (fullyReceived) currentPO.receivedDate = new Date();
      currentPO.invoiceAttachment = req.body.invoiceAttachment || currentPO.invoiceAttachment;
      await currentPO.save({ session });
      return { receipt: createdReceipt, duplicate: false, po: currentPO };
    });

    if (receipt.duplicate) {
      return res.json({ success: true, message: 'Goods receipt was already recorded.', data: receipt });
    }

    res.json({
      success: true,
      message: 'Goods receipt recorded; accepted quantities were added to stock.',
      data: receipt
    });
  } catch (err) {
    next(err);
  }
};

export const receivePurchaseOrderGoods = receivePurchaseOrder;
