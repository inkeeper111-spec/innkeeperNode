import mongoose from 'mongoose';
import {
  InventoryItem,
  PurchaseOrder,
  RawMaterialCategory,
  RawMaterialSubcategory,
  StockMovement,
  Unit,
  Vendor
} from '../models/index.js';
import { getUnitConversionFactor, INVENTORY_UNIT_MASTER } from '../config/inventoryUnits.js';
import { logAudit } from '../services/auditService.js';
import { evaluateAutomaticReorder, runInventoryTransaction } from '../services/inventoryService.js';

const isAdministrator = (user) => ['hotel_admin', 'super_admin'].includes(user?.role);
const sendError = (res, status, message) => res.status(status).json({ success: false, message });
const asObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));
const normalize = (value) => String(value || '').trim();
const packageUnitSymbols = new Set(
  INVENTORY_UNIT_MASTER.find(({ category }) => category === 'Package')?.units.map(({ unit }) => unit.toLowerCase()) || []
);
const isPackageUnit = (unit) => unit.category === 'package' || packageUnitSymbols.has(unit.symbol.toLowerCase());
const codePrefix = (name) => normalize(name)
  .split(/\s+/)
  .map((part) => part.replace(/[^a-z0-9]/gi, ''))
  .filter(Boolean)
  .map((part) => part[0])
  .join('')
  .toUpperCase()
  .slice(0, 4) || 'CAT';

const getStandardFactor = (baseUnit, unit) => {
  if (String(baseUnit._id) === String(unit._id)) return 1;
  if (unit.category !== baseUnit.category) return null;
  try {
    return getUnitConversionFactor({
      unit: baseUnit.symbol,
      baseUnit: baseUnit.symbol
    }, unit.symbol);
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    const unitFactor = Number(unit.conversionFactor);
    const baseFactor = Number(baseUnit.conversionFactor);
    if (String(unit.baseUnitId || '') === String(baseUnit._id) && unitFactor > 0) return unitFactor;
    if (String(baseUnit.baseUnitId || '') === String(unit._id) && baseFactor > 0) return 1 / baseFactor;
    if (unit.baseUnitId && String(unit.baseUnitId) === String(baseUnit.baseUnitId)
      && unitFactor > 0 && baseFactor > 0) {
      return unitFactor / baseFactor;
    }
    return null;
  }
};

const resolveMaterialUnitFactor = ({ unitId, baseUnit, unitsById, entriesById }) => {
  const cache = new Map([[String(baseUnit._id), 1]]);
  const resolve = (id, path = new Set()) => {
    const key = String(id);
    if (cache.has(key)) return { factor: cache.get(key) };
    if (path.has(key)) return { error: 'Package unit conversions cannot contain a cycle.' };
    const unit = unitsById.get(key);
    if (!unit) return { error: 'Every package measurement unit must be active and belong to this hotel.' };

    const nextPath = new Set(path);
    nextPath.add(key);
    let factor;
    if (isPackageUnit(unit)) {
      const entry = entriesById.get(key);
      if (!entry) return { error: `Configure ${unit.name} as a purchase unit before using it as a package measure.` };
      const packageSize = Number(entry.packageSize);
      if (!Number.isFinite(packageSize) || packageSize <= 0) {
        return { error: `Enter a positive package size for ${unit.name}.` };
      }
      const measurementUnit = unitsById.get(String(entry.packageMeasurementUnitId || ''));
      if (!measurementUnit) {
        return { error: `Choose a package measurement unit for ${unit.name}.` };
      }
      const measurement = resolve(measurementUnit._id, nextPath);
      if (measurement.error) return measurement;
      factor = packageSize * measurement.factor;
    } else {
      if (unit.category !== baseUnit.category) {
        return { error: `Purchase unit ${unit.name} must match the base unit type or use a package unit.` };
      }
      factor = getStandardFactor(baseUnit, unit);
    }

    if (!Number.isFinite(factor) || factor < 0.000000001) {
      return { error: `No valid conversion exists between ${unit.name} and ${baseUnit.name}.` };
    }
    cache.set(key, factor);
    return { factor };
  };
  return resolve(unitId);
};

const validateUnitConfiguration = async ({ hotelId, baseUnitId, supportedUnits }) => {
  if (!asObjectId(baseUnitId)) {
    return { error: 'Choose a valid base unit.' };
  }
  if (!Array.isArray(supportedUnits)) {
    return { error: 'Purchase units must be provided as a list.' };
  }

  const entries = supportedUnits.filter((entry) => entry?.unitId);
  const packageNames = new Set();
  const entryIds = new Set();
  const seenDirectUnits = new Set();
  for (const entry of entries) {
    if (entry._id && asObjectId(entry._id)) {
      const id = String(entry._id);
      if (entryIds.has(id)) return { error: 'Each configured purchase package must have a unique identifier.' };
      entryIds.add(id);
    }
  }
  const purchaseUnitIds = entries.map((entry) => String(entry.unitId));
  const unitIds = [...new Set([String(baseUnitId), ...purchaseUnitIds])];

  const measurementIds = entries
    .map((entry) => entry.packageMeasurementUnitId)
    .filter(Boolean)
    .map(String);
  const allIds = [...new Set([...unitIds, ...measurementIds])];
  const units = await Unit.find({
    hotelId,
    _id: { $in: allIds },
    isActive: true
  });
  const unitsById = new Map(units.map((unit) => [String(unit._id), unit]));
  const entriesById = new Map(entries.map((entry) => [String(entry.unitId), entry]));
  const baseUnit = unitsById.get(String(baseUnitId));
  if (!baseUnit) return { error: 'Base unit must be active and belong to this hotel.' };
  if (!['weight', 'volume', 'quantity'].includes(baseUnit.category)) {
    return { error: 'Base unit must be a weight, volume, or count unit.' };
  }

  const result = [];
  const seen = new Set();
  for (const entry of entries) {
    const unit = unitsById.get(String(entry.unitId));
    if (!unit) return { error: 'Every purchase unit must be active and belong to this hotel.' };
    if (entry.conversionFactorToBase !== undefined
      && entry.conversionFactorToBase !== null
      && entry.conversionFactorToBase !== ''
      && (!Number.isFinite(Number(entry.conversionFactorToBase)) || Number(entry.conversionFactorToBase) <= 0)) {
      return { error: `Enter a positive conversion factor for ${unit.name}.` };
    }
    const packageUnit = isPackageUnit(unit);
    if (!packageUnit && seenDirectUnits.has(String(unit._id))) {
      return { error: `Purchase unit "${unit.name}" is configured more than once.` };
    }
    if (!packageUnit) seenDirectUnits.add(String(unit._id));
    seen.add(String(unit._id));

    let conversionFactorToBase;
    let packageSize = null;
    let packageMeasurementUnit = null;
    const packageName = normalize(entry.packageName) || (packageUnit ? unit.name : '');
    if (packageUnit) {
      const normalizedPackageName = packageName.toLocaleLowerCase();
      if (packageNames.has(normalizedPackageName)) {
        return { error: 'Package names must be unique for this material.' };
      }
      packageNames.add(normalizedPackageName);
    }
    if (String(unit._id) === String(baseUnit._id)) {
      if (entry.isActive === false) {
        return { error: 'The base unit must remain an active purchase unit.' };
      }
      conversionFactorToBase = 1;
    } else if (packageUnit) {
      if (!packageName) return { error: `Enter a name for the ${unit.name} package.` };
      packageSize = Number(entry.packageSize);
      packageMeasurementUnit = unitsById.get(String(entry.packageMeasurementUnitId));
      if (!Number.isFinite(packageSize) || packageSize <= 0 || !packageMeasurementUnit) {
        return { error: `Enter a positive package size and measurement unit for ${unit.name}.` };
      }
      if (!isPackageUnit(packageMeasurementUnit)
        && packageMeasurementUnit.category !== baseUnit.category) {
        return { error: `Package measurement for ${packageName} must match the ${baseUnit.name} unit type.` };
      }
    }
    const factorResult = String(unit._id) === String(baseUnit._id)
      ? { factor: 1 }
      : packageUnit && packageMeasurementUnit && !isPackageUnit(packageMeasurementUnit)
        ? { factor: packageSize * getStandardFactor(baseUnit, packageMeasurementUnit) }
        : resolveMaterialUnitFactor({
          unitId: unit._id,
          baseUnit,
          unitsById,
          entriesById
        });
    if (factorResult.error) return { error: factorResult.error };
    conversionFactorToBase = factorResult.factor;
    if (!Number.isFinite(conversionFactorToBase) || conversionFactorToBase < 0.000000001) {
      return { error: `Conversion for ${unit.name} is outside the supported numeric range.` };
    }

    result.push({
      ...(entry._id && asObjectId(entry._id) ? { _id: entry._id } : {}),
      unitId: unit._id,
      unitNameSnapshot: unit.name,
      unitSymbolSnapshot: unit.symbol,
      packageName,
      packageSize,
      packageMeasurementUnitId: packageMeasurementUnit?._id || null,
      packageMeasurementUnitNameSnapshot: packageMeasurementUnit?.name || '',
      packageMeasurementUnitSymbolSnapshot: packageMeasurementUnit?.symbol || '',
      conversionFactorToBase,
      isDefaultPurchaseUnit: entry.isDefaultPurchaseUnit === true,
      isActive: entry.isActive !== false
    });
  }

  if (!seen.has(String(baseUnit._id))) {
    result.unshift({
      unitId: baseUnit._id,
      unitNameSnapshot: baseUnit.name,
      unitSymbolSnapshot: baseUnit.symbol,
      packageName: '',
      packageSize: null,
      packageMeasurementUnitId: null,
      packageMeasurementUnitNameSnapshot: '',
      packageMeasurementUnitSymbolSnapshot: '',
      conversionFactorToBase: 1,
      isDefaultPurchaseUnit: false,
      isActive: true
    });
  }
  if (!result.some((entry) => entry.isActive)) {
    return { error: 'At least one purchase unit must remain active.' };
  }
  const defaultUnits = result.filter((entry) => entry.isDefaultPurchaseUnit && entry.isActive);
  if (defaultUnits.length > 1) {
    return { error: 'Choose no more than one preferred purchase unit.' };
  }
  const defaultUnit = defaultUnits[0] || result.find((entry) => (
    String(entry.unitId) === String(baseUnit._id) && entry.isActive
  )) || result.find((entry) => entry.isActive);
  for (const entry of result) entry.isDefaultPurchaseUnit = String(entry.unitId) === String(defaultUnit.unitId);

  return { baseUnit, supportedUnits: result, defaultUnit };
};

const getCategoryAndSubcategory = async ({ hotelId, categoryId, subcategoryId }) => {
  if (!asObjectId(categoryId) || !asObjectId(subcategoryId)) {
    return { error: 'Choose a category and subcategory.' };
  }
  const [category, subcategory] = await Promise.all([
    RawMaterialCategory.findOne({ _id: categoryId, hotelId, isActive: true }),
    RawMaterialSubcategory.findOne({ _id: subcategoryId, categoryId, hotelId, isActive: true })
  ]);
  if (!category) return { error: 'Choose an active category belonging to this hotel.' };
  if (!subcategory) return { error: 'Choose an active subcategory under the selected category.' };
  return { category, subcategory };
};

const nextMaterialCode = async ({ hotelId, propertyId, category, itemId }) => {
  const existing = await InventoryItem.find({
    hotelId,
    propertyId,
    categoryId: category._id,
    inventoryType: 'raw_material',
    ...(itemId ? { _id: { $ne: itemId } } : {})
  }).select('code').lean();
  let sequence = existing.reduce((max, item) => {
    const match = item.code.match(/-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  let code = `${category.categoryCode}-${String(sequence).padStart(4, '0')}`;
  while (await InventoryItem.exists({ hotelId, propertyId, code, ...(itemId ? { _id: { $ne: itemId } } : {}) })) {
    code = `${category.categoryCode}-${String(++sequence).padStart(4, '0')}`;
  }
  return code;
};

export const getRawMaterialCategories = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to load categories.');
    if (req.query.includeInactive === 'true' && !isAdministrator(req.user)) {
      return sendError(res, 403, 'Only hotel administrators can view inactive categories.');
    }
    const filter = { hotelId: req.hotelId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    const categories = await RawMaterialCategory.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
};

export const createRawMaterialCategory = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to create categories.');
    const name = normalize(req.body.name);
    if (!name) return sendError(res, 400, 'Category name is required.');
    const prefix = codePrefix(name);
    const count = await RawMaterialCategory.countDocuments({
      hotelId: req.hotelId,
      categoryCode: new RegExp(`^${prefix}\\d+$`)
    });
    const category = await RawMaterialCategory.create({
      hotelId: req.hotelId,
      name,
      categoryCode: `${prefix}${String(count + 1).padStart(3, '0')}`,
      description: normalize(req.body.description),
      isActive: req.body.isActive !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_RAW_MATERIAL_CATEGORY',
      entity: 'RawMaterialCategory',
      entityId: category._id,
      details: { name: category.name, categoryCode: category.categoryCode },
      req
    });
    res.status(201).json({ success: true, data: category });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'A category with this name or code already exists.');
    next(error);
  }
};

export const updateRawMaterialCategory = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to update categories.');
    const category = await RawMaterialCategory.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!category) return sendError(res, 404, 'Raw material category not found.');
    if (req.body.name !== undefined) {
      const name = normalize(req.body.name);
      if (!name) return sendError(res, 400, 'Category name is required.');
      category.name = name;
    }
    if (req.body.description !== undefined) category.description = normalize(req.body.description);
    if (req.body.isActive !== undefined) category.isActive = req.body.isActive === true;
    category.updatedBy = req.user._id;
    await category.save();
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_RAW_MATERIAL_CATEGORY',
      entity: 'RawMaterialCategory',
      entityId: category._id,
      details: { name: category.name, isActive: category.isActive },
      req
    });
    res.json({ success: true, data: category });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'A category with this name already exists.');
    next(error);
  }
};

export const getRawMaterialSubcategories = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to load subcategories.');
    if (req.query.includeInactive === 'true' && !isAdministrator(req.user)) {
      return sendError(res, 403, 'Only hotel administrators can view inactive subcategories.');
    }
    const filter = { hotelId: req.hotelId };
    if (req.query.categoryId) {
      if (!asObjectId(req.query.categoryId)) return sendError(res, 400, 'Choose a valid category.');
      filter.categoryId = req.query.categoryId;
    }
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    const subcategories = await RawMaterialSubcategory.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, data: subcategories });
  } catch (error) {
    next(error);
  }
};

export const createRawMaterialSubcategory = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to create subcategories.');
    const name = normalize(req.body.name);
    if (!name || !asObjectId(req.body.categoryId)) {
      return sendError(res, 400, 'Category and subcategory name are required.');
    }
    const category = await RawMaterialCategory.findOne({
      _id: req.body.categoryId,
      hotelId: req.hotelId,
      isActive: true
    });
    if (!category) return sendError(res, 400, 'Choose an active category belonging to this hotel.');
    const subcategory = await RawMaterialSubcategory.create({
      hotelId: req.hotelId,
      categoryId: category._id,
      name,
      description: normalize(req.body.description),
      isActive: req.body.isActive !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_RAW_MATERIAL_SUBCATEGORY',
      entity: 'RawMaterialSubcategory',
      entityId: subcategory._id,
      details: { categoryId: category._id, name: subcategory.name },
      req
    });
    res.status(201).json({ success: true, data: subcategory });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'This subcategory already exists for the selected category.');
    next(error);
  }
};

export const updateRawMaterialSubcategory = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to update subcategories.');
    const subcategory = await RawMaterialSubcategory.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!subcategory) return sendError(res, 404, 'Raw material subcategory not found.');
    if (req.body.name !== undefined) {
      const name = normalize(req.body.name);
      if (!name) return sendError(res, 400, 'Subcategory name is required.');
      subcategory.name = name;
    }
    if (req.body.description !== undefined) subcategory.description = normalize(req.body.description);
    if (req.body.isActive !== undefined) subcategory.isActive = req.body.isActive === true;
    subcategory.updatedBy = req.user._id;
    await subcategory.save();
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_RAW_MATERIAL_SUBCATEGORY',
      entity: 'RawMaterialSubcategory',
      entityId: subcategory._id,
      details: { name: subcategory.name, isActive: subcategory.isActive },
      req
    });
    res.json({ success: true, data: subcategory });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'This subcategory already exists for the selected category.');
    next(error);
  }
};

export const getRawMaterials = async (req, res, next) => {
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to load raw materials.');
    }
    if (req.query.includeInactive === 'true' && !isAdministrator(req.user)) {
      return sendError(res, 403, 'Only hotel administrators can view inactive raw materials.');
    }
    const filter = {
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      inventoryType: 'raw_material'
    };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (req.query.search) {
      const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { code: { $regex: escaped, $options: 'i' } }
      ];
    }
    const materials = await InventoryItem.find(filter)
      .populate('categoryId', 'name categoryCode isActive')
      .populate('subcategoryId', 'name isActive')
      .populate('baseUnitId', 'name symbol category isActive')
      .populate('purchaseUnitId', 'name symbol category isActive')
      .populate('preferredPurchaseUnitId', 'name symbol category isActive')
      .populate('supportedUnits.unitId', 'name symbol category isActive')
      .populate('supportedUnits.packageMeasurementUnitId', 'name symbol category isActive')
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: materials });
  } catch (error) {
    next(error);
  }
};

const saveRawMaterial = async ({ req, currentItem = null }) => {
  const name = normalize(req.body.name ?? currentItem?.name);
  const categoryId = req.body.categoryId ?? currentItem?.categoryId;
  const subcategoryId = req.body.subcategoryId ?? currentItem?.subcategoryId;
  const categoryResult = await getCategoryAndSubcategory({
    hotelId: req.hotelId,
    categoryId,
    subcategoryId
  });
  if (categoryResult.error) return { error: categoryResult.error };
  if (!name) return { error: 'Raw material name is required.' };

  const baseUnitId = req.body.baseUnitId ?? currentItem?.baseUnitId;
  const supportedUnits = req.body.supportedUnits ?? currentItem?.supportedUnits ?? [];
  const unitResult = await validateUnitConfiguration({
    hotelId: req.hotelId,
    baseUnitId,
    supportedUnits
  });
  if (unitResult.error) return { error: unitResult.error };

  const { baseUnit, defaultUnit } = unitResult;
  const reorderLevel = Number(req.body.reorderLevel ?? currentItem?.reorderLevel ?? req.body.minStockThreshold ?? currentItem?.minStockThreshold ?? 0);
  const minStockThreshold = Number(req.body.minimumStockLevel ?? req.body.minStockThreshold ?? currentItem?.minStockThreshold ?? 0);
  const maxStockLevel = Number(req.body.maxStockLevel ?? currentItem?.maxStockLevel ?? 0);
  if (!Number.isFinite(reorderLevel) || reorderLevel < 0
    || !Number.isFinite(minStockThreshold) || minStockThreshold < 0
    || !Number.isFinite(maxStockLevel) || maxStockLevel < 0
    || (maxStockLevel > 0 && maxStockLevel < reorderLevel)) {
    return { error: 'Stock levels must be non-negative, and desired stock cannot be below the reorder level.' };
  }
  const requestedVendorId = req.body.vendorId === undefined
    ? currentItem?.vendorId
    : req.body.vendorId || null;
  let preferredVendor = requestedVendorId
    ? await Vendor.findOne({
      _id: requestedVendorId,
      hotelId: req.hotelId,
      status: 'active'
    }).select('_id')
    : null;
  if (!preferredVendor && requestedVendorId && currentItem
    && String(requestedVendorId) === String(currentItem.vendorId || '')) {
    preferredVendor = await Vendor.findOne({
      _id: requestedVendorId,
      hotelId: req.hotelId
    }).select('_id');
  }
  if (requestedVendorId && !preferredVendor) return { error: 'Choose an active preferred supplier belonging to this hotel.' };

  if (currentItem && String(currentItem.baseUnitId) !== String(baseUnit._id)) {
    const hasHistory = currentItem.currentStock > 0
      || await StockMovement.exists({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        itemId: currentItem._id
      })
      || await PurchaseOrder.exists({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        'items.itemId': currentItem._id
      });
    if (hasHistory) {
      return { conflict: 'Base unit cannot be changed after stock or purchase history exists. Create a new raw material and transfer stock instead.' };
    }
  }

  const activeSupportedUnits = unitResult.supportedUnits.filter((unit) => unit.isActive);
  const unitConversions = Object.fromEntries(activeSupportedUnits.map((unit) => (
    [unit.unitSymbolSnapshot, unit.conversionFactorToBase]
  )));
  const packagingOptions = activeSupportedUnits
    .filter((unit) => String(unit.unitId) !== String(baseUnit._id))
    .map((unit) => ({
      unit: unit.unitSymbolSnapshot,
      unitId: unit.unitId,
      conversionFactor: unit.conversionFactorToBase
    }));
  const itemFields = {
    name,
    category: 'food_ingredients',
    inventoryType: 'raw_material',
    categoryId: categoryResult.category._id,
    subcategoryId: categoryResult.subcategory._id,
    description: normalize(req.body.description ?? currentItem?.description),
    storageType: normalize(req.body.storageType ?? currentItem?.storageType),
    location: normalize(req.body.location ?? currentItem?.location ?? 'Main Store') || 'Main Store',
    baseUnit: baseUnit.symbol,
    unit: baseUnit.symbol,
    baseUnitId: baseUnit._id,
    purchaseUnit: defaultUnit.unitSymbolSnapshot,
    purchaseUnitId: defaultUnit.unitId,
    preferredPurchaseUnitId: defaultUnit.unitId,
    purchaseConversionFactor: defaultUnit.conversionFactorToBase,
    conversionFactor: defaultUnit.conversionFactorToBase,
    supportedUnits: unitResult.supportedUnits,
    additionalPackagingOptions: packagingOptions.map(({ unitId, conversionFactor }) => ({ unitId, conversionFactor })),
    packagingOptions,
    unitConversions,
    minStockThreshold,
    reorderLevel,
    reorderQuantity: reorderLevel,
    maxStockLevel: maxStockLevel > 0 ? maxStockLevel : null,
    vendorId: preferredVendor?._id || null,
    isActive: req.body.isActive === undefined ? currentItem?.isActive ?? true : req.body.isActive === true
  };
  itemFields.createdBy = currentItem?.createdBy || req.user._id;
  itemFields.updatedBy = req.user._id;
  if (!currentItem) {
    itemFields.code = await nextMaterialCode({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      category: categoryResult.category
    });
    itemFields.currentStock = 0;
    itemFields.unitCost = 0;
  } else {
    itemFields.code = currentItem.code;
  }
  return { itemFields, category: categoryResult.category };
};

export const createRawMaterial = async (req, res, next) => {
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to create raw materials.');
    }
    const result = await saveRawMaterial({ req });
    if (result.error) return sendError(res, 400, result.error);
    const item = await InventoryItem.create({
      ...result.itemFields,
      hotelId: req.hotelId,
      propertyId: req.propertyId
    });
    await runInventoryTransaction((session) => evaluateAutomaticReorder({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      recordedBy: req.user._id,
      session
    }));
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_RAW_MATERIAL',
      entity: 'InventoryItem',
      entityId: item._id,
      details: { name: item.name, code: item.code, categoryId: item.categoryId },
      req
    });
    res.status(201).json({ success: true, data: item });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'A raw material with this code or name already exists.');
    next(error);
  }
};

export const updateRawMaterial = async (req, res, next) => {
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to update raw materials.');
    }
    const currentItem = await InventoryItem.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      inventoryType: 'raw_material'
    });
    if (!currentItem) return sendError(res, 404, 'Raw material not found.');
    const result = await saveRawMaterial({ req, currentItem });
    if (result.error) return sendError(res, 400, result.error);
    if (result.conflict) return sendError(res, 409, result.conflict);
    const item = await InventoryItem.findOneAndUpdate(
      { _id: currentItem._id, hotelId: req.hotelId, propertyId: req.propertyId },
      { $set: result.itemFields },
      { new: true, runValidators: true }
    );
    if (!item) return sendError(res, 404, 'Raw material not found.');
    await runInventoryTransaction((session) => evaluateAutomaticReorder({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId: item._id,
      recordedBy: req.user._id,
      session
    }));
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_RAW_MATERIAL',
      entity: 'InventoryItem',
      entityId: item._id,
      details: { name: item.name, isActive: item.isActive },
      req
    });
    res.json({ success: true, data: item });
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, 'A raw material with this code or name already exists.');
    next(error);
  }
};
