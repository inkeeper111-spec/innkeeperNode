import mongoose from 'mongoose';

const restaurantTableSchema = new mongoose.Schema({
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
  tableNumber: {
    type: Number,
    required: true,
    min: 1
  },
  name: {
    type: String,
    trim: true,
    default: ''
  },
  capacity: {
    type: Number,
    required: true,
    min: 1,
    default: 4
  },
  status: {
    type: String,
    enum: ['available', 'reserved'],
    default: 'available'
  },
  activeOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FoodOrder',
    default: null
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, { timestamps: true });

restaurantTableSchema.index(
  { hotelId: 1, propertyId: 1, tableNumber: 1 },
  { unique: true }
);

export const RestaurantTable = mongoose.models.RestaurantTable
  || mongoose.model('RestaurantTable', restaurantTableSchema);
