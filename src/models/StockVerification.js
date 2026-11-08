import mongoose from 'mongoose';

const stockVerificationSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  location: { type: String, trim: true, required: true, default: 'Main Store' },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  verifiedAt: { type: Date, required: true, default: Date.now },
  expectedStock: { type: Number, required: true, min: 0 },
  actualStock: { type: Number, required: true, min: 0 },
  consumptionQuantity: { type: Number, required: true, min: 0, default: 0 },
  consumptionReason: { type: String, trim: true, default: '' },
  wastageQuantity: { type: Number, required: true, min: 0, default: 0 },
  wastageReason: { type: String, trim: true, default: '' },
  discrepancyQuantity: { type: Number, required: true, min: 0, default: 0 },
  stockGain: { type: Number, required: true, min: 0, default: 0 },
  unit: { type: String, trim: true, required: true },
  discrepancyReason: { type: String, trim: true, default: '' },
  remarks: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'approved', index: true },
  adjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAdjustment', default: null },
  movementIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' }],
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  idempotencyKey: { type: String, default: undefined }
}, { timestamps: true });

stockVerificationSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const StockVerification = mongoose.models.StockVerification
  || mongoose.model('StockVerification', stockVerificationSchema);
