import mongoose from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../config/constants.js';

const subscriptionSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  status: {
    type: String,
    enum: Object.values(SUBSCRIPTION_STATUS),
    default: SUBSCRIPTION_STATUS.TRIALING,
    index: true
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'annual'],
    default: 'monthly'
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: true
  },
  amount: {
    type: Number,
    required: true,
    default: 0
  },
  currency: {
    type: String,
    default: 'USD'
  },
  paymentMethod: {
    type: String,
    default: 'razorpay'
  },
  razorpaySubscriptionId: String,
  razorpayPaymentId: String,
  autoRenew: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

export const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);

