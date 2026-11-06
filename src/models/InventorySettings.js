import mongoose from 'mongoose';

const inventorySettingsSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  verificationIntervalDays: { type: Number, required: true, min: 1, max: 365, default: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

inventorySettingsSchema.index({ hotelId: 1, propertyId: 1 }, { unique: true });

export const InventorySettings = mongoose.models.InventorySettings
  || mongoose.model('InventorySettings', inventorySettingsSchema);
