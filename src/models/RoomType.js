import mongoose from 'mongoose';

const roomTypeSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  maxOccupancy: {
    type: Number,
    required: true,
    default: 2,
    min: 1
  },
  adultCapacity: {
    type: Number,
    required: true,
    default: 2,
    min: 1
  },
  childCapacity: {
    type: Number,
    default: 1,
    min: 0
  },
  bedConfiguration: {
    type: String,
    default: '1 King Bed'
  },
  basePrice: {
    type: Number,
    required: true,
    min: 0
  },
  extraGuestPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  amenities: [{
    type: String
  }],
  images: [{
    type: String
  }],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

roomTypeSchema.index({ hotelId: 1, code: 1 }, { unique: true });

export const RoomType = mongoose.models.RoomType || mongoose.model('RoomType', roomTypeSchema);

