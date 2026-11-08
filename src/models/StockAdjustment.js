import mongoose from 'mongoose';

const stockAdjustmentSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, trim: true, default: '' },
  conversionFactor: { type: Number, min: 0, default: 1 },
  baseUnit: { type: String, trim: true, default: '' },
  reason: {
    type: String,
    required: true,
    enum: ['expired', 'damaged', 'food_wastage', 'spillage', 'missing', 'physical_mismatch', 'internal_usage']
  },
  department: { type: String, trim: true, default: '' },
  location: { type: String, trim: true, default: 'Main Store' },
  status: { type: String, enum: ['pending', 'logged', 'approved', 'rejected'], default: 'approved', index: true },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: Date,
  remarks: { type: String, trim: true, default: '' },
  movementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null }
}, { timestamps: true });

stockAdjustmentSchema.index({ hotelId: 1, propertyId: 1, createdAt: -1 });

export const StockAdjustment = mongoose.models.StockAdjustment
  || mongoose.model('StockAdjustment', stockAdjustmentSchema);
