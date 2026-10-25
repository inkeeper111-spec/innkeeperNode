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
    enum: ['food_beverage', 'toiletries', 'linen_cleaning', 'maintenance', 'stationery', 'other'],
    default: 'food_beverage'
  },
  unit: {
    type: String,
    enum: ['kg', 'liter', 'pieces', 'boxes', 'packets', 'bottles'],
    default: 'pieces'
  },
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

export const InventoryItem = mongoose.models.InventoryItem || mongoose.model('InventoryItem', inventoryItemSchema);

