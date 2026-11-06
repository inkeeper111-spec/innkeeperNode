import { GoodsReceipt, InventoryItem, PurchaseOrder, StockMovement, Unit } from '../models/index.js';
import { logAudit } from '../services/auditService.js';
import { INVENTORY_UNIT_MASTER } from '../config/inventoryUnits.js';

const UNIT_CATEGORIES = ['weight', 'volume', 'quantity', 'length', 'area', 'other'];
const normalizeKey = (value) => String(value || '').trim().toLocaleLowerCase();
const symbolPattern = (symbol) => new RegExp(`^${String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const sendError = (res, status, message) => res.status(status).json({ success: false, message });

const defaultUnits = [
  ...INVENTORY_UNIT_MASTER.flatMap(({ category, units }) => units.map(({ unit, label }) => ({
    name: label.replace(/\s*\([^)]*\)\s*$/, ''),
    symbol: unit,
    category: category.toLowerCase()
  })))
];

export const getInventoryUnits = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to load units.');
    if (req.query.includeInactive === 'true' && !['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      return sendError(res, 403, 'Only hotel administrators can view inactive units.');
    }
    const filter = { hotelId: req.hotelId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (UNIT_CATEGORIES.includes(String(req.query.category || '').toLowerCase())) {
      filter.category = String(req.query.category).toLowerCase();
    }
    if (req.query.search) {
      const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { symbol: { $regex: escaped, $options: 'i' } }
      ];
    }
    const units = await Unit.find(filter).sort({ category: 1, name: 1 }).lean();
    res.json({ success: true, data: units, categories: UNIT_CATEGORIES });
  } catch (error) {
    next(error);
  }
};

export const createInventoryUnit = async (req, res, next) => {
  try {
    const { name, symbol, category, description = '' } = req.body;
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to create units.');
    if (!String(name || '').trim() || !String(symbol || '').trim()) {
      return sendError(res, 400, 'Unit name and symbol are required.');
    }
    const normalizedCategory = String(category || '').toLowerCase();
    if (!UNIT_CATEGORIES.includes(normalizedCategory)) {
      return sendError(res, 400, 'Choose a valid unit category.');
    }
    const keys = [normalizeKey(name), normalizeKey(symbol)];
    if (await Unit.exists({
      hotelId: req.hotelId,
      $or: [{ nameKey: keys[0] }, { symbolKey: keys[1] }]
    })) {
      return sendError(res, 409, 'A unit with this name or symbol already exists for this hotel.');
    }
    const unit = await Unit.create({
      hotelId: req.hotelId,
      name: String(name).trim(),
      symbol: String(symbol).trim(),
      category: normalizedCategory,
      description: String(description).trim(),
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_INVENTORY_UNIT',
      entity: 'Unit',
      entityId: unit._id,
      details: { name: unit.name, symbol: unit.symbol, category: unit.category },
      req
    });
    res.status(201).json({ success: true, data: unit });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'A unit with this name or symbol already exists for this hotel.');
    next(error);
  }
};

export const updateInventoryUnit = async (req, res, next) => {
  try {
    const unit = await Unit.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!unit) return sendError(res, 404, 'Unit not found.');
    const updates = {};
    for (const field of ['name', 'symbol', 'category', 'description', 'isActive']) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (updates.name !== undefined && !String(updates.name).trim()) {
      return sendError(res, 400, 'Unit name is required.');
    }
    if (updates.symbol !== undefined && !String(updates.symbol).trim()) {
      return sendError(res, 400, 'Unit symbol is required.');
    }
    if (updates.category !== undefined) {
      updates.category = String(updates.category).toLowerCase();
      if (!UNIT_CATEGORIES.includes(updates.category)) return sendError(res, 400, 'Choose a valid unit category.');
    }
    const symbolOrCategoryChanging = (updates.symbol !== undefined
      && normalizeKey(updates.symbol) !== unit.symbolKey)
      || (updates.category !== undefined && updates.category !== unit.category);
    if (symbolOrCategoryChanging) {
      const symbol = symbolPattern(unit.symbol);
      const [itemReference, movementReference, purchaseReference, receiptReference] = await Promise.all([
        InventoryItem.exists({
          hotelId: req.hotelId,
          $or: [
            { baseUnitId: unit._id },
            { purchaseUnitId: unit._id },
            { 'additionalPackagingOptions.unitId': unit._id },
            { unit: symbol },
            { baseUnit: symbol },
            { purchaseUnit: symbol },
            { 'packagingOptions.unit': symbol }
          ]
        }),
        StockMovement.exists({
          hotelId: req.hotelId,
          $or: [{ enteredUnitId: unit._id }, { baseUnitId: unit._id }, { enteredUnit: symbol }, { baseUnit: symbol }]
        }),
        PurchaseOrder.exists({
          hotelId: req.hotelId,
          $or: [{ 'items.unitId': unit._id }, { 'items.baseUnitId': unit._id }, { 'items.unit': symbol }, { 'items.baseUnit': symbol }]
        }),
        GoodsReceipt.exists({
          hotelId: req.hotelId,
          $or: [{ 'lines.unitId': unit._id }, { 'lines.baseUnitId': unit._id }, { 'lines.unit': symbol }, { 'lines.baseUnit': symbol }]
        })
      ]);
      const referenced = itemReference || movementReference || purchaseReference || receiptReference;
      if (referenced) {
        return sendError(res, 409, 'Unit symbol and category cannot change while inventory items reference this unit. Deactivate it instead.');
      }
    }
    if (updates.name !== undefined) updates.name = String(updates.name).trim();
    if (updates.symbol !== undefined) updates.symbol = String(updates.symbol).trim();
    if (updates.description !== undefined) updates.description = String(updates.description).trim();
    Object.assign(unit, updates, { updatedBy: req.user._id });
    await unit.save();
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_INVENTORY_UNIT',
      entity: 'Unit',
      entityId: unit._id,
      details: updates,
      req
    });
    res.json({ success: true, data: unit });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'A unit with this name or symbol already exists for this hotel.');
    next(error);
  }
};

export const deleteInventoryUnit = async (req, res, next) => {
  try {
    const unit = await Unit.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!unit) return sendError(res, 404, 'Unit not found.');
    const [itemReference, movementReference, purchaseReference, receiptReference] = await Promise.all([
      InventoryItem.exists({
        hotelId: req.hotelId,
        $or: [
          { baseUnitId: unit._id },
          { purchaseUnitId: unit._id },
          { 'additionalPackagingOptions.unitId': unit._id },
          { unit: symbolPattern(unit.symbol) },
          { baseUnit: symbolPattern(unit.symbol) },
          { purchaseUnit: symbolPattern(unit.symbol) },
          { 'packagingOptions.unit': symbolPattern(unit.symbol) }
        ]
      }),
      StockMovement.exists({
        hotelId: req.hotelId,
        $or: [{ enteredUnitId: unit._id }, { baseUnitId: unit._id }, { enteredUnit: symbolPattern(unit.symbol) }, { baseUnit: symbolPattern(unit.symbol) }]
      }),
      PurchaseOrder.exists({
        hotelId: req.hotelId,
        $or: [{ 'items.unitId': unit._id }, { 'items.baseUnitId': unit._id }, { 'items.unit': symbolPattern(unit.symbol) }, { 'items.baseUnit': symbolPattern(unit.symbol) }]
      }),
      GoodsReceipt.exists({
        hotelId: req.hotelId,
        $or: [{ 'lines.unitId': unit._id }, { 'lines.baseUnitId': unit._id }, { 'lines.unit': symbolPattern(unit.symbol) }, { 'lines.baseUnit': symbolPattern(unit.symbol) }]
      })
    ]);
    if (itemReference || movementReference || purchaseReference || receiptReference) {
      return sendError(res, 409, 'This unit is referenced by inventory or stock history. Deactivate it instead.');
    }
    await unit.deleteOne();
    await logAudit({
      hotelId: req.hotelId,
      action: 'DELETE_INVENTORY_UNIT',
      entity: 'Unit',
      entityId: unit._id,
      details: { name: unit.name, symbol: unit.symbol },
      req
    });
    res.json({ success: true, message: 'Unit deleted.' });
  } catch (error) {
    next(error);
  }
};

export const createDefaultInventoryUnits = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to create units.');
    const existing = await Unit.find({ hotelId: req.hotelId }).select('nameKey symbolKey').lean();
    const existingNames = new Set(existing.map((unit) => unit.nameKey));
    const existingSymbols = new Set(existing.map((unit) => unit.symbolKey));
    const missing = defaultUnits.filter((unit) => (
      !existingNames.has(normalizeKey(unit.name)) && !existingSymbols.has(normalizeKey(unit.symbol))
    ));
    if (missing.length) {
      await Unit.insertMany(missing.map((unit) => ({
        ...unit,
        nameKey: normalizeKey(unit.name),
        symbolKey: normalizeKey(unit.symbol),
        hotelId: req.hotelId,
        createdBy: req.user._id,
        updatedBy: req.user._id
      })), { ordered: false });
    }
    const units = await Unit.find({ hotelId: req.hotelId }).sort({ category: 1, name: 1 }).lean();
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_STANDARD_INVENTORY_UNITS',
      entity: 'Unit',
      details: { addedCount: missing.length },
      req
    });
    res.status(201).json({ success: true, data: units, addedCount: missing.length });
  } catch (error) {
    if (error.code === 11000) {
      const units = await Unit.find({ hotelId: req.hotelId }).sort({ category: 1, name: 1 }).lean();
      await logAudit({
        hotelId: req.hotelId,
        action: 'CREATE_STANDARD_INVENTORY_UNITS',
        entity: 'Unit',
        details: { addedCount: 0 },
        req
      });
      return res.status(200).json({ success: true, data: units, addedCount: 0 });
    }
    next(error);
  }
};
