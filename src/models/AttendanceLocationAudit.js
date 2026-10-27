import mongoose from 'mongoose';

const attendanceLocationAuditSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  action: {
    type: String,
    enum: ['check_in', 'check_out'],
    required: true
  },
  latitude: {
    type: Number,
    default: null
  },
  longitude: {
    type: Number,
    default: null
  },
  accuracyMeters: {
    type: Number,
    default: null
  },
  distanceMeters: {
    type: Number,
    default: null
  },
  radiusMeters: {
    type: Number,
    default: 50
  },
  maxAccuracyMeters: {
    type: Number,
    default: 25
  },
  validationResult: {
    type: String,
    enum: ['valid', 'invalid'],
    required: true
  },
  attendanceResult: {
    type: String,
    enum: ['pending', 'recorded', 'rejected'],
    default: 'pending'
  },
  failureReason: {
    type: String,
    default: ''
  },
  occurredAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, {
  timestamps: true
});

attendanceLocationAuditSchema.index({ hotelId: 1, userId: 1, occurredAt: -1 });

export const AttendanceLocationAudit = mongoose.models.AttendanceLocationAudit
  || mongoose.model('AttendanceLocationAudit', attendanceLocationAuditSchema);
