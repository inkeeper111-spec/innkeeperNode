import mongoose from 'mongoose';

const minibarTransactionSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  reservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', default: null },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
  type: { type: String, enum: ['opening', 'consumption', 'complimentary', 'damaged', 'missing', 'replenishment'], required: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  enteredQuantity: { type: Number, min: 0, default: null },
  unit: { type: String, trim: true, default: '' },
  conversionFactor: { type: Number, min: 0, default: 1 },
  unitPrice: { type: Number, min: 0, default: 0 },
  chargeAmount: { type: Number, min: 0, default: 0 },
  idempotencyKey: { type: String, default: undefined },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notes: { type: String, trim: true, default: '' }
}, { timestamps: true });

minibarTransactionSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const MinibarTransaction = mongoose.models.MinibarTransaction
  || mongoose.model('MinibarTransaction', minibarTransactionSchema);
