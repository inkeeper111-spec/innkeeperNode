import mongoose from 'mongoose';

const subscriptionModuleSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  monthlyPrice: { type: Number, required: true, min: 0, default: 0 },
  annualPrice: { type: Number, required: true, min: 0, default: 0 },
  enabled: { type: Boolean, default: true, index: true }
}, { timestamps: true });

export const SubscriptionModule = mongoose.models.SubscriptionModule
  || mongoose.model('SubscriptionModule', subscriptionModuleSchema);
