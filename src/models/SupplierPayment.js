import mongoose from 'mongoose';

const supplierPaymentSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  paymentMethod: { type: String, enum: ['cash', 'card', 'bank_transfer', 'upi', 'cheque', 'other'], default: 'bank_transfer' },
  referenceNumber: { type: String, trim: true, default: '' },
  invoiceNumber: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  idempotencyKey: { type: String, default: undefined },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  paidAt: { type: Date, default: Date.now }
}, { timestamps: true });

supplierPaymentSchema.index({ hotelId: 1, propertyId: 1, vendorId: 1, paidAt: -1 });
supplierPaymentSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const SupplierPayment = mongoose.models.SupplierPayment
  || mongoose.model('SupplierPayment', supplierPaymentSchema);
