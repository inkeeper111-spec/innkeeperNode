import mongoose from 'mongoose';

const inventoryBatchSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  location: { type: String, trim: true, required: true },
  batchNumber: { type: String, trim: true, default: '' },
  quantity: { type: Number, required: true, min: 0 },
  remainingQuantity: { type: Number, required: true, min: 0 },
  unitCost: { type: Number, required: true, min: 0 },
  expiryDate: { type: Date, default: null },
  receivedAt: { type: Date, default: Date.now }
}, { timestamps: true });

inventoryBatchSchema.index({ hotelId: 1, propertyId: 1, itemId: 1, location: 1, expiryDate: 1 });

export const InventoryBatch = mongoose.models.InventoryBatch
  || mongoose.model('InventoryBatch', inventoryBatchSchema);
