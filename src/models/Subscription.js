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
    default: null
  },
  selectedModules: [{ type: String, trim: true, lowercase: true }],
  selectedModulePrices: [{
    key: { type: String, required: true },
    monthlyPrice: { type: Number, required: true, min: 0 },
    annualPrice: { type: Number, required: true, min: 0 }
  }],
  moduleTotal: { type: Number, min: 0, default: 0 },
  finalAmount: { type: Number, min: 0, default: 0 },
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
    default: 'INR'
  },
  paymentMethod: {
    type: String,
    default: 'razorpay'
  },
  razorpaySubscriptionId: String,
  razorpayPaymentId: String,
  razorpayOrderId: { type: String, index: true },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'unpaid'],
    default: 'unpaid',
    index: true
  },
  nextBillingDate: Date,
  scheduledModuleRemovals: [{ type: String, trim: true, lowercase: true }],
  scheduledChangesAt: Date,
  autoRenew: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

export const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
