import mongoose from 'mongoose';
import { MAINTENANCE_STATUS, PRIORITY } from '../config/constants.js';

const maintenanceTicketSchema = new mongoose.Schema({
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
  ticketNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room'
  },
  roomNumber: String,
  equipmentName: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    enum: ['plumbing', 'electrical', 'hvac', 'carpentry', 'appliances', 'painting', 'other'],
    default: 'plumbing'
  },
  issueDescription: {
    type: String,
    required: true
  },
  priority: {
    type: String,
    enum: Object.values(PRIORITY),
    default: PRIORITY.MEDIUM
  },
  status: {
    type: String,
    enum: Object.values(MAINTENANCE_STATUS),
    default: MAINTENANCE_STATUS.OPEN,
    index: true
  },
  reportedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedTechnician: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  assignedAt: Date,
  assignmentStatus: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending'
  },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: Date,
  rejectionReason: { type: String, default: '' },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  assignmentHistory: [{
    action: { type: String, enum: ['assigned', 'accepted', 'rejected', 'reassigned'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    previousAssignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    timestamp: { type: Date, required: true },
    reason: { type: String, default: '' }
  }],
  technicianName: String,
  estimatedCost: {
    type: Number,
    default: 0
  },
  actualCost: {
    type: Number,
    default: 0
  },
  materialsUsed: {
    type: String,
    default: ''
  },
  resolutionNotes: {
    type: String,
    default: ''
  },
  takesRoomOutOfService: {
    type: Boolean,
    default: false
  },
  resolvedAt: Date,
  closedAt: Date
}, {
  timestamps: true,
  optimisticConcurrency: true
});

export const MaintenanceTicket = mongoose.models.MaintenanceTicket || mongoose.model('MaintenanceTicket', maintenanceTicketSchema);
