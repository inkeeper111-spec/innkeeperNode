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
  fulfillmentSource: {
    type: String,
    enum: ['made_to_order', 'batch_production'],
    default: 'made_to_order'
  },
  specialInstructions: {
    type: String,
    default: ''
  },
  ingredientSubstitutions: [{
    ingredientItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' },
    substituteItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' },
    quantity: { type: Number, min: 0.000001 },
    unit: { type: String, trim: true }
  }]
}, { _id: false });

const preparedFoodAllocationSchema = new mongoose.Schema({
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
  productionBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBatch', required: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  orderLineIndex: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['reserved', 'sold', 'released', 'reversed'], default: 'reserved' }
}, { _id: false });

const amountModificationSchema = new mongoose.Schema({
  field: {
    type: String,
    enum: ['unitPrice', 'discountAmount'],
    required: true
  },
  itemIndex: Number,
  originalAmount: { type: Number, required: true },
  revisedAmount: { type: Number, required: true },
  reason: { type: String, required: true, trim: true },
  editorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  editorName: { type: String, required: true },
  timestamp: { type: Date, required: true, default: Date.now }
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
  preparedFoodAllocations: { type: [preparedFoodAllocationSchema], default: [] },
  preparedFoodReservedAt: { type: Date, default: null },
  preparedFoodDeductedAt: { type: Date, default: null },
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
  amountModifications: {
    type: [amountModificationSchema],
    default: []
  },
  archivedAt: {
    type: Date,
    default: null,
    index: true
  },
  archivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

export const FoodOrder = mongoose.models.FoodOrder || mongoose.model('FoodOrder', foodOrderSchema);
