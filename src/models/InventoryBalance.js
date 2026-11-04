import mongoose from 'mongoose';

const inventoryBalanceSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  location: { type: String, required: true, trim: true, default: 'Main Store' },
  quantity: { type: Number, required: true, min: 0, default: 0 }
}, { timestamps: true });

inventoryBalanceSchema.index({ hotelId: 1, propertyId: 1, itemId: 1, location: 1 }, { unique: true });

export const InventoryBalance = mongoose.models.InventoryBalance
  || mongoose.model('InventoryBalance', inventoryBalanceSchema);
