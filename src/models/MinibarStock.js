import mongoose from 'mongoose';

const minibarStockSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  openingQuantity: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 0 }
}, { timestamps: true });

minibarStockSchema.index({ hotelId: 1, propertyId: 1, roomId: 1, itemId: 1 }, { unique: true });

export const MinibarStock = mongoose.models.MinibarStock
  || mongoose.model('MinibarStock', minibarStockSchema);
