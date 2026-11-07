import mongoose from 'mongoose';

const inventoryItemSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },
  category: {
    type: String,
    enum: [
      'food_beverage', 'food_ingredients', 'vegetables', 'fruits', 'groceries',
      'dairy_products', 'meat', 'seafood', 'beverages', 'toiletries',
      'housekeeping_supplies', 'cleaning_materials', 'maintenance',
      'maintenance_materials', 'electrical_items', 'stationery',
      'minibar_products', 'linen_laundry', 'linen_cleaning', 'other'
    ],
    default: 'food_beverage'
  },
  inventoryType: {
    type: String,
    enum: ['stock_item', 'raw_material'],
    default: 'stock_item',
    index: true
  },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterialCategory', default: null, index: true },
  subcategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterialSubcategory', default: null, index: true },
  storageType: { type: String, trim: true, default: '' },
  reorderLevel: { type: Number, min: 0, default: 0 },
  preferredPurchaseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  supportedUnits: [{
    unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    unitNameSnapshot: { type: String, required: true, trim: true },
    unitSymbolSnapshot: { type: String, required: true, trim: true },
    packageName: { type: String, trim: true, default: '' },
    packageSize: { type: Number, min: 0, default: null },
    packageMeasurementUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
    packageMeasurementUnitNameSnapshot: { type: String, trim: true, default: '' },
    packageMeasurementUnitSymbolSnapshot: { type: String, trim: true, default: '' },
    conversionFactorToBase: { type: Number, required: true, min: 0.000000001 },
    isDefaultPurchaseUnit: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true }
  }],
  unit: {
    type: String,
    trim: true,
    default: 'pieces'
  },
  baseUnit: {
    type: String,
    trim: true,
    default: ''
  },
  baseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  purchaseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  purchaseUnit: { type: String, trim: true, default: '' },
  purchaseConversionFactor: { type: Number, min: 0.000000001, default: 1 },
  conversionFactor: { type: Number, min: 0.000000001, default: 1 },
  purchasePrice: { type: Number, min: 0, default: null },
  packagingOptions: [{
    unit: { type: String, trim: true, required: true },
    unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
    conversionFactor: { type: Number, min: 0.000000001, required: true }
  }],
  additionalPackagingOptions: [{
    unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    conversionFactor: { type: Number, min: 0.000000001, required: true }
  }],
  currentStock: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  minStockThreshold: {
    type: Number,
    required: true,
    default: 10,
    min: 0
  },
  maxStockLevel: { type: Number, min: 0, default: null },
  reorderQuantity: { type: Number, min: 0, default: 0 },
  description: { type: String, trim: true, default: '' },
  sellingPrice: { type: Number, min: 0, default: null },
  barcode: { type: String, trim: true, default: '' },
  trackExpiry: { type: Boolean, default: false },
  trackBatchNumber: { type: Boolean, default: false },
  stockVerificationIntervalDays: { type: Number, min: 1, max: 365, default: null },
  unitConversions: {
    type: Map,
    of: Number,
    default: {}
  },
  isActive: { type: Boolean, default: true },
  unitCost: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vendor'
  },
  location: {
    type: String,
    default: 'Main Store'
  }
}, {
  timestamps: true
});

inventoryItemSchema.index({ hotelId: 1, propertyId: 1, code: 1 }, { unique: true });
inventoryItemSchema.index({ hotelId: 1, propertyId: 1, inventoryType: 1, isActive: 1, name: 1 });

inventoryItemSchema.pre('validate', function setBaseUnit() {
  if (!this.baseUnit) this.baseUnit = this.unit || 'pcs';
  if (!this.unit) this.unit = this.baseUnit;
  if (!this.purchaseUnit) this.purchaseUnit = this.baseUnit;
});

export const InventoryItem = mongoose.models.InventoryItem || mongoose.model('InventoryItem', inventoryItemSchema);
