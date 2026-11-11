import mongoose from 'mongoose';

const advancePaymentBreakupSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  advancePaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdvancePayment',
    required: true,
    index: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StaffProfile',
    required: true,
    index: true
  },
  payMonth: { type: String, required: true, index: true }, // YYYY-MM
  payAmount: { type: Number, required: true, min: 0 },
  balanceAmount: { type: Number, default: 0, min: 0 },
  isPaid: { type: String, enum: ['N', 'P', 'Y'], default: 'N' }
}, { timestamps: true });

advancePaymentBreakupSchema.index({ advancePaymentId: 1, payMonth: 1 }, { unique: true });

export const AdvancePaymentBreakup =
  mongoose.models.AdvancePaymentBreakup ||
  mongoose.model('AdvancePaymentBreakup', advancePaymentBreakupSchema);
