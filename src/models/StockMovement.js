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
  quantity: {
    type: Number,
    required: true
  },
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
  idempotencyKey: { type: String, default: undefined },
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

export const StockMovement = mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
