import mongoose from 'mongoose';
import { HOTEL_STATUS, SUBSCRIPTION_STATUS } from '../config/constants.js';

const attendanceLocationSchema = new mongoose.Schema({
  latitude: {
    type: Number,
    min: -90,
    max: 90
  },
  longitude: {
    type: Number,
    min: -180,
    max: 180
  },
  radiusMeters: {
    type: Number,
    default: 50,
    min: 1
  },
  maxAccuracyMeters: {
    type: Number,
    default: 25,
    min: 1
  }
}, { _id: false });

const hotelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true
  },
  address: {
    type: String,
    required: true
  },
  city: {
    type: String,
    required: true
  },
  state: {
    type: String,
    required: true
  },
  country: {
    type: String,
    default: 'United States'
  },
  postalCode: {
    type: String,
    required: true
  },
  logo: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: Object.values(HOTEL_STATUS),
    default: HOTEL_STATUS.PENDING_APPROVAL,
    index: true
  },
  taxNumber: {
    type: String,
    default: ''
  },
  currency: {
    type: String,
    default: 'USD'
  },
  timezone: {
    type: String,
    default: 'UTC'
  },
  checkInTime: {
    type: String,
    default: '14:00'
  },
  checkOutTime: {
    type: String,
    default: '11:00'
  },
  cancellationPolicy: {
    type: String,
    default: 'Free cancellation up to 24 hours prior to check-in.'
  },
  attendanceLocation: {
    type: attendanceLocationSchema,
    default: null
  },
  invoicePrefix: {
    type: String,
    default: 'INV'
  },
  leaveTypes: {
    type: [{
      key: { type: String, required: true, trim: true, lowercase: true },
      label: { type: String, required: true, trim: true },
      active: { type: Boolean, default: true }
    }],
    default: [
      { key: 'casual', label: 'Casual Leave', active: true },
      { key: 'sick', label: 'Sick Leave', active: true },
      { key: 'earned', label: 'Earned Leave', active: true },
      { key: 'unpaid', label: 'Unpaid Leave', active: true },
      { key: 'emergency', label: 'Emergency Leave', active: true }
    ]
  },
  currentPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    default: null
  },
  subscriptionStatus: {
    type: String,
    enum: Object.values(SUBSCRIPTION_STATUS),
    default: SUBSCRIPTION_STATUS.TRIALING
  },
  trialEndsAt: {
    type: Date,
    default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14-day trial
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

export const Hotel = mongoose.models.Hotel || mongoose.model('Hotel', hotelSchema);
