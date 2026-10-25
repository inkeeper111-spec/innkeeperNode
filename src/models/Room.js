import mongoose from 'mongoose';
import { ROOM_STATUS, HOUSEKEEPING_STATUS } from '../config/constants.js';

const roomSchema = new mongoose.Schema({
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
  roomNumber: {
    type: String,
    required: true,
    trim: true
  },
  roomTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RoomType',
    required: true,
    index: true
  },
  floor: {
    type: String,
    default: '1'
  },
  roomStatus: {
    type: String,
    enum: Object.values(ROOM_STATUS),
    default: ROOM_STATUS.AVAILABLE,
    index: true
  },
  housekeepingStatus: {
    type: String,
    enum: Object.values(HOUSEKEEPING_STATUS),
    default: HOUSEKEEPING_STATUS.CLEAN,
    index: true
  },
  maintenanceStatus: {
    type: String,
    enum: ['normal', 'under_maintenance', 'out_of_order'],
    default: 'normal'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

roomSchema.index({ hotelId: 1, propertyId: 1, roomNumber: 1 }, { unique: true });

export const Room = mongoose.models.Room || mongoose.model('Room', roomSchema);

