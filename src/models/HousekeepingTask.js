import mongoose from 'mongoose';
import { HOUSEKEEPING_STATUS, PRIORITY } from '../config/constants.js';

const housekeepingTaskSchema = new mongoose.Schema({
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
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true,
    index: true
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  priority: {
    type: String,
    enum: Object.values(PRIORITY),
    default: PRIORITY.MEDIUM
  },
  status: {
    type: String,
    enum: Object.values(HOUSEKEEPING_STATUS),
    default: HOUSEKEEPING_STATUS.DIRTY,
    index: true
  },
  taskType: {
    type: String,
    enum: ['daily_cleaning', 'checkout_cleaning', 'deep_cleaning', 'touch_up'],
    default: 'checkout_cleaning'
  },
  notes: {
    type: String,
    default: ''
  },
  damageReported: {
    type: Boolean,
    default: false
  },
  damageDescription: String,
  startedAt: Date,
  completedAt: Date,
  inspectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  inspectedAt: Date
}, {
  timestamps: true
});

export const HousekeepingTask = mongoose.models.HousekeepingTask || mongoose.model('HousekeepingTask', housekeepingTaskSchema);

