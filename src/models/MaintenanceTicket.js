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
  timestamps: true
});

export const MaintenanceTicket = mongoose.models.MaintenanceTicket || mongoose.model('MaintenanceTicket', maintenanceTicketSchema);

