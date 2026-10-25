import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  code: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  description: {
    type: String,
    default: ''
  },
  monthlyPrice: {
    type: Number,
    required: true,
    min: 0
  },
  annualPrice: {
    type: Number,
    required: true,
    min: 0
  },
  maxRooms: {
    type: Number,
    required: true,
    default: 20
  },
  maxUsers: {
    type: Number,
    required: true,
    default: 5
  },
  maxProperties: {
    type: Number,
    required: true,
    default: 1
  },
  enabledModules: [{
    type: String
  }],
  aiUsageAllowance: {
    type: Number,
    default: 100 // AI requests/month
  },
  supportLevel: {
    type: String,
    enum: ['standard', 'priority', 'dedicated_24_7'],
    default: 'standard'
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

export const SubscriptionPlan = mongoose.models.SubscriptionPlan || mongoose.model('SubscriptionPlan', subscriptionPlanSchema);

