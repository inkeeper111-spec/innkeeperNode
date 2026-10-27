import mongoose from 'mongoose';
import { FOOD_ORDER_STATUS } from '../config/constants.js';

const orderItemSchema = new mongoose.Schema({
  menuItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MenuItem',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  unitPrice: {
    type: Number,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  specialInstructions: {
    type: String,
    default: ''
  }
}, { _id: false });

const foodOrderSchema = new mongoose.Schema({
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
  orderNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  orderType: {
    type: String,
    enum: ['dine_in', 'room_service', 'takeaway'],
    default: 'dine_in'
  },
  tableNumber: {
    type: String,
    default: ''
  },
  tableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RestaurantTable',
    default: null,
    index: true
  },
  tableNameSnapshot: {
    type: String,
    default: ''
  },
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room'
  },
  roomNumber: String,
  reservationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Reservation'
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Guest'
  },
  guestName: String,
  items: [orderItemSchema],
  subtotal: {
    type: Number,
    required: true,
    default: 0
  },
  taxAmount: {
    type: Number,
    default: 0
  },
  discountAmount: {
    type: Number,
    default: 0
  },
  totalAmount: {
    type: Number,
    required: true,
    default: 0
  },
  status: {
    type: String,
    enum: Object.values(FOOD_ORDER_STATUS),
    default: FOOD_ORDER_STATUS.PENDING,
    index: true
  },
  isBilledToRoomFolio: {
    type: Boolean,
    default: false
  },
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'paid', 'transferred_to_folio'],
    default: 'unpaid'
  },
  paymentMethod: String,
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

export const FoodOrder = mongoose.models.FoodOrder || mongoose.model('FoodOrder', foodOrderSchema);
