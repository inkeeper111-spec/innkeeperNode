import {
  DepartmentRequest, GoodsReceipt, InventoryBatch, InventoryItem, InventoryRecipe, Unit,
  MinibarStock, MinibarTransaction, StockMovement, SupplierPayment, Vendor, PurchaseOrder
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
      .populate('additionalPackagingOptions.unitId', 'name symbol category isActive')
      .populate('packagingOptions.unitId', 'name symbol category isActive')
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
    const expiredByItem = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    const rows = items.map((item) => ({
      ...item,
      availableStock: Math.max(0, item.currentStock - (expiredByItem.get(String(item._id)) || 0))
    }));

    res.json({ success: true, data: rows, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
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
    const { itemId, movementType, quantity, notes, referenceNumber, location, department, idempotencyKey } = req.body;
    if (!['receipt', 'issue', 'adjustment', 'wastage', 'return'].includes(movementType)) {
      return res.status(400).json({ success: false, message: 'Unsupported stock movement type.' });
    }
    if (movementType === 'adjustment' && !isAdministrator(req.user)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can post direct stock adjustments.' });
    }
    if (!isAdministrator(req.user) && movementType !== 'issue') {
      return res.status(403).json({ success: false, message: 'Use an approved goods receipt or submit a stock adjustment request for this movement.' });
    }
    if (movementType === 'issue' && !department?.trim()) {
      return res.status(400).json({ success: false, message: 'Department is required for stock issues.' });
    }

    const result = await runInventoryTransaction((session) => postStockMovement({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId,
      movementType,
      quantity,
      unit: req.body.unit,
      notes: notes || '',
      referenceNumber: referenceNumber || generateReference('MOV'),
      location: location || 'Main Store',
      department: department || '',
      batchNumber: req.body.batchNumber || '',
      expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
      recordedBy: req.user._id,
      idempotencyKey: idempotencyKey || req.get('Idempotency-Key'),
      session
    }));
    if (result.duplicate) {
      return res.json({ success: true, message: 'Stock movement was already recorded.', data: { movement: result.movement } });
    }
    const { movement, item } = result;

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
      data: { movement, item }
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
      return res.status(400).json({ success: false, message: 'Supplier name and phone number are required.' });
    }
    if (!Array.isArray(suppliedItems)) {
      return res.status(400).json({ success: false, message: 'Supplied items must be a list.' });
    }
    if (suppliedItems.length) {
      const count = await InventoryItem.countDocuments({
        _id: { $in: suppliedItems }, hotelId: req.hotelId, propertyId: req.propertyId
      });
      if (count !== new Set(suppliedItems.map(String)).size) {
        return res.status(400).json({ success: false, message: 'Supplier contains an item from another property or an invalid item.' });
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
        return res.status(400).json({ success: false, message: 'Supplier contains an item from another property or an invalid item.' });
      }
    }
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('suppliedItems', 'name code unit');
    if (!vendor) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    res.json({ success: true, data: vendor });
  } catch (err) {
    next(err);
  }
};

export const getVendorPurchases = async (req, res, next) => {
  try {
    const vendorExists = await Vendor.exists({ _id: req.params.id, hotelId: req.hotelId });
    if (!vendorExists) return res.status(404).json({ success: false, message: 'Supplier not found.' });
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
    if (!vendorExists) return res.status(404).json({ success: false, message: 'Supplier not found.' });
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
      return res.status(400).json({ success: false, message: 'Supplier payment amount must be positive.' });
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
        throw Object.assign(new Error('Supplier not found or payment exceeds the outstanding balance.'), { statusCode: 409 });
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
    if (!vendor) return res.status(400).json({ success: false, message: 'An active supplier is required.' });
    const purchaseLines = [];
    for (const line of items) {
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0
        || !Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0) {
        return res.status(400).json({ success: false, message: 'Purchase quantities must be positive and unit prices cannot be negative.' });
      }
      const inventoryItem = await InventoryItem.findOne({
        _id: line.itemId, hotelId: req.hotelId, propertyId: req.propertyId, isActive: true
      }).select('name unit baseUnit baseUnitId purchaseUnit purchaseUnitId purchaseConversionFactor packagingOptions additionalPackagingOptions unitConversions');
      if (!inventoryItem) return res.status(400).json({ success: false, message: 'Purchase order contains an invalid inventory item.' });
      const purchaseUnit = normalizeInventoryUnit(line.unit || inventoryItem.purchaseUnit || inventoryItem.baseUnit || inventoryItem.unit);
      const conversionFactor = getUnitConversionFactor(inventoryItem, purchaseUnit);
      const configuredUnitId = purchaseUnit === inventoryItem.baseUnit
        ? inventoryItem.baseUnitId
        : purchaseUnit === inventoryItem.purchaseUnit
          ? inventoryItem.purchaseUnitId
          : inventoryItem.packagingOptions.find((option) => option.unit === purchaseUnit)?.unitId
            || inventoryItem.additionalPackagingOptions.find((option) => String(option.unitId) === String(line.unitId))?.unitId;
      const requestedUnit = configuredUnitId
        ? await Unit.findOne({ _id: configuredUnitId, hotelId: req.hotelId })
        : await Unit.findOne({ hotelId: req.hotelId, symbolKey: purchaseUnit.toLocaleLowerCase(), isActive: true });
      if (!requestedUnit) return res.status(400).json({ success: false, message: 'Purchase unit is not an active unit for this hotel.' });
      if (!configuredUnitId && inventoryItem.baseUnitId) {
        const baseUnitRecord = await Unit.findOne({ _id: inventoryItem.baseUnitId, hotelId: req.hotelId }).select('category');
        if (!baseUnitRecord || requestedUnit.category !== baseUnitRecord.category) {
          return res.status(400).json({ success: false, message: 'Purchase unit is not compatible with the item base unit.' });
        }
      }
      purchaseLines.push({
        itemId: inventoryItem._id,
        itemName: inventoryItem.name,
        quantity: Number(line.quantity),
        unit: purchaseUnit,
        unitId: requestedUnit._id,
        baseUnit: inventoryItem.baseUnit || inventoryItem.unit,
        baseUnitId: inventoryItem.baseUnitId || null,
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
          unit: poLine.unit || '',
          unitId: poLine.unitId || null,
          baseUnit: poLine.baseUnit || '',
          baseUnitId: poLine.baseUnitId || null,
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
