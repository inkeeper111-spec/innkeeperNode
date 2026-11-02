import mongoose from 'mongoose';

const subscriptionSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'global' },
  minimumMonthlyAmount: { type: Number, required: true, min: 999, default: 999 }
}, { timestamps: true });

export const SubscriptionSettings = mongoose.models.SubscriptionSettings
  || mongoose.model('SubscriptionSettings', subscriptionSettingsSchema);
