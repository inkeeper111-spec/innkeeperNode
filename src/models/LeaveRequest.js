import mongoose from 'mongoose';

const leaveRequestSchema = new mongoose.Schema({
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
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  supportingDocuments: {
    type: [String],
    default: []
  },
  leaveType: {
    type: String,
    required: true,
    default: 'casual'
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  totalDays: {
    type: Number,
    required: true,
    min: 1
  },
  days: {
    type: Number,
    min: 1
  },
  reason: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  activeDates: {
    type: [String],
    default: [],
    select: false
  },
  activeRequest: {
    type: Boolean,
    default: false,
    select: false
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: Date,
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectedAt: Date,
  rejectionReason: {
    type: String,
    default: ''
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancelledAt: Date,
  cancellationReason: {
    type: String,
    default: ''
  },
  decisionHistory: [{
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, required: true },
    timestamp: { type: Date, required: true },
    reason: { type: String, default: '' }
  }],
  reviewNotes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

leaveRequestSchema.index(
  { hotelId: 1, userId: 1, activeDates: 1 },
  { unique: true, partialFilterExpression: { activeRequest: true } }
);

export const LeaveRequest = mongoose.models.LeaveRequest || mongoose.model('LeaveRequest', leaveRequestSchema);
