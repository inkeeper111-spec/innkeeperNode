import mongoose from 'mongoose';

const stockMovementSchema = new mongoose.Schema({
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
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InventoryItem',
    required: true,
    index: true
  },
  movementType: {
    type: String,
    enum: [
      'receipt', 'issue', 'adjustment', 'wastage', 'return', 'transfer',
      'opening', 'department_issue', 'recipe_consumption', 'sale_reversal',
      'physical_count', 'expiry'
    ],
    required: true
  },
  transactionDate: { type: Date, default: Date.now, index: true },
  quantity: {
    type: Number,
    required: true
  },
  enteredQuantity: { type: Number, min: 0, default: null },
  enteredUnit: { type: String, trim: true, default: '' },
  enteredUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  purchasePackageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  purchasePackageName: { type: String, trim: true, default: '' },
  looseQuantity: { type: Number, min: 0, default: 0 },
  conversionFactor: { type: Number, min: 0, default: 1 },
  baseUnit: { type: String, trim: true, default: '' },
  baseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  previousStock: {
    type: Number,
    required: true
  },
  newStock: {
    type: Number,
    required: true
  },
  unitCost: {
    type: Number,
    default: 0
  },
  totalValue: {
    type: Number,
    default: 0
  },
  referenceNumber: {
    type: String,
    default: ''
  },
  notes: {
    type: String,
    default: ''
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  location: { type: String, trim: true, default: 'Main Store' },
  destinationLocation: { type: String, trim: true, default: '' },
  department: { type: String, trim: true, default: '' },
  sourceDepartment: { type: String, trim: true, default: '' },
  destinationDepartment: { type: String, trim: true, default: '' },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
  purchaseUnitPrice: { type: Number, min: 0, default: null },
  idempotencyKey: { type: String, default: undefined },
  batchAllocations: [{
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryBatch', default: null },
    quantity: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ['batch', 'legacy'], default: 'batch' }
  }],
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', default: null },
  batchNumber: { type: String, trim: true, default: '' },
  expiryDate: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true
});

stockMovementSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
stockMovementSchema.index({ hotelId: 1, propertyId: 1, createdAt: -1 });
stockMovementSchema.index({ hotelId: 1, propertyId: 1, transactionDate: -1 });

export const StockMovement = mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
