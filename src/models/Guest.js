import mongoose from 'mongoose';

const guestSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  address: {
    type: String,
    default: ''
  },
  city: {
    type: String,
    default: ''
  },
  country: {
    type: String,
    default: 'United States'
  },
  idDocumentType: {
    type: String,
    enum: ['passport', 'driver_license', 'national_id', 'other', 'none'],
    default: 'none'
  },
  idDocumentNumber: {
    type: String,
    default: ''
  },
  preferences: {
    type: String,
    default: ''
  },
  specialRequests: {
    type: String,
    default: ''
  },
  vipStatus: {
    type: Boolean,
    default: false
  },
  internalNotes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

guestSchema.index({ hotelId: 1, phone: 1 });
guestSchema.index({ hotelId: 1, email: 1 });

export const Guest = mongoose.models.Guest || mongoose.model('Guest', guestSchema);

