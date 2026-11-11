import mongoose from 'mongoose';

const advancePaymentSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StaffProfile',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  advanceAmount: { type: Number, required: true, min: 0.01 },
  paymentMode: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'upi'],
    default: 'cash'
  },
  disbursedDate: { type: Date, required: true },
  effectiveMonth: { type: String, required: true }, // YYYY-MM first recovery month
  payAmount: { type: Number, required: true, min: 0.01 }, // monthly recovery amount (or full if single)
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

export const AdvancePayment =
  mongoose.models.AdvancePayment ||
  mongoose.model('AdvancePayment', advancePaymentSchema);
