import mongoose from 'mongoose';

const shiftSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  shiftDate: {
    type: Date,
    required: true,
    index: true
  },
  shiftType: {
    type: String,
    enum: ['morning', 'evening', 'night', 'general'],
    default: 'general'
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'absent', 'cancelled'],
    default: 'scheduled'
  },
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

export const Shift = mongoose.models.Shift || mongoose.model('Shift', shiftSchema);

