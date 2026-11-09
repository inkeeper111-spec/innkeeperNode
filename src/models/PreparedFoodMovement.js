import mongoose from 'mongoose';

const preparedFoodMovementSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  productionBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBatch', required: true, index: true },
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
  movementType: {
    type: String,
    enum: ['production_receipt', 'reservation', 'reservation_release', 'sale', 'sale_reversal', 'wastage', 'complimentary', 'staff_consumption', 'transfer_out', 'transfer_in', 'reversal'],
    required: true
  },
  quantity: { type: Number, required: true, min: 0.00000001 },
  unitCost: { type: Number, min: 0, default: 0 },
  totalCost: { type: Number, min: 0, default: 0 },
  salesRevenue: { type: Number, min: 0, default: 0 },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', default: null },
  orderNumber: { type: String, trim: true, default: '' },
  orderLineIndex: { type: Number, min: 0, default: null },
  idempotencyKey: { type: String, default: undefined },
  reason: { type: String, trim: true, default: '' },
  location: { type: String, trim: true, default: '' },
  destinationLocation: { type: String, trim: true, default: '' },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  notes: { type: String, trim: true, default: '' }
}, { timestamps: true });

preparedFoodMovementSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const PreparedFoodMovement = mongoose.models.PreparedFoodMovement
  || mongoose.model('PreparedFoodMovement', preparedFoodMovementSchema);
