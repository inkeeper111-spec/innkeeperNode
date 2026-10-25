import mongoose from 'mongoose';

const refundSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    required: true
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  reservationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Reservation'
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  reason: {
    type: String,
    required: true
  },
  razorpayRefundId: String,
  status: {
    type: String,
    enum: ['pending', 'processed', 'failed'],
    default: 'processed'
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

export const Refund = mongoose.models.Refund || mongoose.model('Refund', refundSchema);

