export const INVENTORY_UNIT_MASTER = [
  {
    category: 'Weight',
    units: [
      { unit: 'kg', label: 'Kilogram (kg)', factor: 1000 },
      { unit: 'g', label: 'Gram (g)', factor: 1 },
      { unit: 'mg', label: 'Milligram (mg)', factor: 0.001 },
      { unit: 'MT', label: 'Metric tonne (MT)', factor: 1000000 }
    ]
  },
  {
    category: 'Volume',
    units: [
      { unit: 'L', label: 'Litre (L)', factor: 1000 },
      { unit: 'ml', label: 'Millilitre (ml)', factor: 1 },
      { unit: 'KL', label: 'Kilolitre (KL)', factor: 1000000 }
    ]
  },
  {
    category: 'Quantity',
    units: [
      { unit: 'pcs', label: 'Piece (pcs)', factor: 1 },
      { unit: 'dozen', label: 'Dozen', factor: 12 },
      { unit: 'pair', label: 'Pair', factor: 2 },
      { unit: 'box', label: 'Box', factor: null },
      { unit: 'packet', label: 'Packet', factor: null },
      { unit: 'carton', label: 'Carton', factor: null },
      { unit: 'tray', label: 'Tray', factor: null },
      { unit: 'set', label: 'Set', factor: null },
      { unit: 'bottle', label: 'Bottle', factor: null },
      { unit: 'can', label: 'Can', factor: null },
      { unit: 'bag', label: 'Bag', factor: null },
      { unit: 'roll', label: 'Roll', factor: null }
    ]
  },
  {
    category: 'Length',
    units: [
      { unit: 'm', label: 'Metre (m)', factor: 1000 },
      { unit: 'cm', label: 'Centimetre (cm)', factor: 10 },
      { unit: 'mm', label: 'Millimetre (mm)', factor: 1 }
    ]
  },
  {
    category: 'Area',
    units: [
      { unit: 'm²', label: 'Square metre (m²)', factor: 1 },
      { unit: 'sq.ft', label: 'Square foot (sq.ft)', factor: 0.09290304 }
    ]
  }
];

const UNIT_ALIASES = new Map([
  ['liter', 'L'], ['litre', 'L'], ['liters', 'L'], ['litres', 'L'],
  ['pieces', 'pcs'], ['piece', 'pcs'], ['boxes', 'box'],
  ['packets', 'packet'], ['bottles', 'bottle'], ['meters', 'm'], ['metres', 'm']
]);

const unitDefinitions = new Map(
  INVENTORY_UNIT_MASTER.flatMap(({ category, units }) =>
    units.map(({ unit, factor }) => [unit, { category, factor }])
  )
);

export const normalizeInventoryUnit = (unit = '') => {
  const trimmed = String(unit).trim();
  return UNIT_ALIASES.get(trimmed.toLowerCase()) || trimmed;
};

const itemUnitConversions = (item) => {
  const conversions = item?.unitConversions;
  const entries = conversions instanceof Map ? [...conversions.entries()] : Object.entries(conversions || {});
  return Object.fromEntries(entries.map(([unit, factor]) => [normalizeInventoryUnit(unit), factor]));
};

export const getUnitConversionFactor = (item, unit) => {
  const sourceUnit = normalizeInventoryUnit(unit || item.baseUnit || item.unit);
  const baseUnit = normalizeInventoryUnit(item.baseUnit || item.unit);
  if (sourceUnit === baseUnit) return 1;

  const explicitFactor = Number(itemUnitConversions(item)[sourceUnit]);
  if (Number.isFinite(explicitFactor) && explicitFactor > 0) return explicitFactor;
  if (sourceUnit === normalizeInventoryUnit(item.purchaseUnit)
    && Number.isFinite(Number(item.purchaseConversionFactor))
    && Number(item.purchaseConversionFactor) > 0) {
    return Number(item.purchaseConversionFactor);
  }

  const packagingFactor = (item.packagingOptions || [])
    .find((option) => normalizeInventoryUnit(option.unit) === sourceUnit)?.conversionFactor;
  if (Number.isFinite(Number(packagingFactor)) && Number(packagingFactor) > 0) {
    return Number(packagingFactor);
  }

  const source = unitDefinitions.get(sourceUnit);
  const base = unitDefinitions.get(baseUnit);
  if (source && base && source.category === base.category && source.factor && base.factor) {
    return source.factor / base.factor;
  }

  throw Object.assign(
    new Error(`Unit "${sourceUnit}" is not configured for ${item.name}; add an item-specific conversion.`),
    { statusCode: 400 }
  );
};

export const convertQuantityToBase = (item, quantity, unit, factorOverride) => {
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0) {
    throw Object.assign(new Error('Quantity must be a non-negative number.'), { statusCode: 400 });
  }
  const factor = factorOverride === undefined
    ? getUnitConversionFactor(item, unit)
    : Number(factorOverride);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw Object.assign(new Error('Unit conversion factor must be a positive number.'), { statusCode: 400 });
  }
  const convertedQuantity = Math.round((numericQuantity * factor + Number.EPSILON) * 100000000) / 100000000;
  if (numericQuantity > 0 && convertedQuantity === 0) {
    throw Object.assign(new Error('Quantity is below the supported precision for this base unit.'), { statusCode: 400 });
  }
  return { quantity: convertedQuantity, factor, unit: normalizeInventoryUnit(unit || item.baseUnit || item.unit) };
};

export const getItemUnitConfiguration = (configuration) => {
  const baseUnit = normalizeInventoryUnit(configuration.baseUnit || configuration.unit);
  const purchaseUnit = normalizeInventoryUnit(configuration.purchaseUnit || baseUnit);
  const suppliedPurchaseFactor = Number(configuration.purchaseConversionFactor);
  const packagingOptions = (configuration.packagingOptions || []).map((option) => ({
    unit: normalizeInventoryUnit(option.unit),
    conversionFactor: Number(option.conversionFactor)
  }));
  const rawConversions = configuration.unitConversions instanceof Map
    ? Object.fromEntries(configuration.unitConversions)
    : configuration.unitConversions || {};
  const unitConversions = Object.fromEntries(
    Object.entries(rawConversions).map(([unit, factor]) => [
      normalizeInventoryUnit(unit),
      Number(factor)
    ])
  );

  if (!unitDefinitions.has(baseUnit) || !unitDefinitions.has(purchaseUnit)) {
    throw Object.assign(new Error('Choose a supported base unit and purchase unit.'), { statusCode: 400 });
  }

  const configuredUnits = new Set();
  for (const [unit, factor] of Object.entries(unitConversions)) {
    if (!unitDefinitions.has(unit) || !Number.isFinite(factor) || factor <= 0) {
      throw Object.assign(new Error(`Invalid conversion configured for unit "${unit}".`), { statusCode: 400 });
    }
    if (unit === baseUnit && factor !== 1) {
      throw Object.assign(new Error('The base unit conversion factor must be 1.'), { statusCode: 400 });
    }
    const source = unitDefinitions.get(unit);
    const base = unitDefinitions.get(baseUnit);
    if (source && base && source.category === base.category && source.factor && base.factor
      && Math.abs(factor - source.factor / base.factor) > 1e-9) {
      throw Object.assign(new Error(`Conversion for ${unit} to ${baseUnit} must use the standard unit factor.`), { statusCode: 400 });
    }
  }

  for (const option of packagingOptions) {
    if (!unitDefinitions.has(option.unit) || !Number.isFinite(option.conversionFactor) || option.conversionFactor <= 0) {
      throw Object.assign(new Error('Every packaging option must use a supported unit and a positive conversion factor.'), { statusCode: 400 });
    }
    if (configuredUnits.has(option.unit)) {
      throw Object.assign(new Error(`Packaging unit "${option.unit}" is configured more than once.`), { statusCode: 400 });
    }
    if (option.unit === baseUnit && option.conversionFactor !== 1) {
      throw Object.assign(new Error('A package configured as the base unit must have a conversion factor of 1.'), { statusCode: 400 });
    }
    configuredUnits.add(option.unit);
    unitConversions[option.unit] = option.conversionFactor;
  }

  let purchaseFactor = 1;
  if (purchaseUnit !== baseUnit) {
    const explicit = unitConversions[purchaseUnit];
    if (Number.isFinite(explicit) && explicit > 0) {
      purchaseFactor = explicit;
      if (Number.isFinite(suppliedPurchaseFactor)
        && suppliedPurchaseFactor > 0
        && Math.abs(suppliedPurchaseFactor - purchaseFactor) > 1e-9) {
        throw Object.assign(new Error('Purchase conversion factor does not match the configured package conversion.'), { statusCode: 400 });
      }
    } else {
      const source = unitDefinitions.get(purchaseUnit);
      const base = unitDefinitions.get(baseUnit);
      if (source && base && source.category === base.category && source.factor && base.factor) {
        purchaseFactor = source.factor / base.factor;
        if (Number.isFinite(suppliedPurchaseFactor)
          && suppliedPurchaseFactor > 0
          && Math.abs(suppliedPurchaseFactor - purchaseFactor) > 1e-9) {
          throw Object.assign(new Error('Purchase conversion factor does not match the standard unit conversion.'), { statusCode: 400 });
        }
      } else if (Number.isFinite(suppliedPurchaseFactor) && suppliedPurchaseFactor > 0) {
        purchaseFactor = suppliedPurchaseFactor;
      } else {
        throw Object.assign(new Error(`Set a product-specific conversion factor for ${purchaseUnit} to ${baseUnit}.`), { statusCode: 400 });
      }
    }
  }

  if (purchaseUnit === baseUnit
    && Number.isFinite(suppliedPurchaseFactor)
    && suppliedPurchaseFactor > 0
    && Math.abs(suppliedPurchaseFactor - 1) > 1e-9) {
    throw Object.assign(new Error('Purchase conversion factor does not match the configured unit conversion.'), { statusCode: 400 });
  }

  if (purchaseUnit !== baseUnit && !unitConversions[purchaseUnit]) {
    unitConversions[purchaseUnit] = purchaseFactor;
    packagingOptions.push({ unit: purchaseUnit, conversionFactor: purchaseFactor });
  }

  return { baseUnit, purchaseUnit, purchaseConversionFactor: purchaseFactor, packagingOptions, unitConversions };
};

export const listInventoryUnits = () => INVENTORY_UNIT_MASTER;
