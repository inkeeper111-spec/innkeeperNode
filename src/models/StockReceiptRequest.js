import mongoose from 'mongoose';

const previousBatchSchema = new mongoose.Schema({
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryBatch', required: true },
  batchNumber: { type: String, trim: true, default: '' },
  remainingQuantity: { type: Number, required: true, min: 0 }
}, { _id: false });

const stockReceiptRequestSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, trim: true, required: true },
  purchaseUnitPrice: { type: Number, required: true, min: 0 },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
  department: { type: String, trim: true, default: '' },
  location: { type: String, trim: true, default: 'Main Store' },
  expiryDate: { type: Date, default: null },
  notes: { type: String, trim: true, default: '' },
  previousBatches: { type: [previousBatchSchema], default: [] },
  previousAvailableQuantity: { type: Number, required: true, min: 0 },
  existingStockDeduction: { type: Number, required: true, min: 0, default: 0 },
  existingStockDeductionEnteredQuantity: { type: Number, min: 0, default: null },
  existingStockDeductionUnit: { type: String, trim: true, default: '' },
  remainingPreviousStockAfterDeduction: { type: Number, min: 0, default: null },
  deductionMovementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  wastageQuantity: { type: Number, min: 0, default: 0 },
  wastageEnteredQuantity: { type: Number, min: 0, default: null },
  wastageUnit: { type: String, trim: true, default: '' },
  wastageReason: { type: String, trim: true, default: '' },
  wastageMovementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, trim: true, default: '' },
  movementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  batchNumber: { type: String, trim: true, default: '' }
}, { timestamps: true });

stockReceiptRequestSchema.index({ hotelId: 1, propertyId: 1, status: 1, createdAt: -1 });

export const StockReceiptRequest = mongoose.models.StockReceiptRequest
  || mongoose.model('StockReceiptRequest', stockReceiptRequestSchema);
