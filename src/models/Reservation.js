import mongoose from 'mongoose';
import { RESERVATION_STATUS, PAYMENT_STATUS } from '../config/constants.js';

const reservationRoomSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true
  },
  roomTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RoomType',
    required: true
  },
  roomNumber: String,
  ratePerNight: {
    type: Number,
    required: true
  }
}, { _id: false });

const reservationSchema = new mongoose.Schema({
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
  bookingReference: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Guest',
    required: true,
    index: true
  },
  guestName: String,
  guestEmail: String,
  guestPhone: String,
  checkInDate: {
    type: Date,
    required: true,
    index: true
  },
  checkOutDate: {
    type: Date,
    required: true,
    index: true
  },
  rooms: [reservationRoomSchema],
  adultsCount: {
    type: Number,
    default: 1
  },
  childrenCount: {
    type: Number,
    default: 0
  },
  bookingSource: {
    type: String,
    enum: ['walk_in', 'online', 'telephone', 'manual', 'ota'],
    default: 'walk_in'
  },
  status: {
    type: String,
    enum: Object.values(RESERVATION_STATUS),
    default: RESERVATION_STATUS.PENDING_APPROVAL,
    index: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedByRole: String,
  approvedAt: Date,
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectedByRole: String,
  rejectedAt: Date,
  rejectionReason: String,
  paymentStatus: {
    type: String,
    enum: Object.values(PAYMENT_STATUS),
    default: PAYMENT_STATUS.UNPAID,
    index: true
  },
  subtotal: {
    type: Number,
    required: true,
    default: 0
  },
  taxAmount: {
    type: Number,
    default: 0
  },
  discountAmount: {
    type: Number,
    default: 0
  },
  totalAmount: {
    type: Number,
    required: true,
    default: 0
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  balanceAmount: {
    type: Number,
    default: 0
  },
  specialRequests: {
    type: String,
    default: ''
  },
  checkedInAt: Date,
  checkedInBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  checkedOutAt: Date,
  checkedOutBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancellationReason: String,
  cancelledAt: Date
}, {
  timestamps: true
});

reservationSchema.index({ hotelId: 1, 'rooms.roomId': 1, checkInDate: 1, checkOutDate: 1 });

export const Reservation = mongoose.models.Reservation || mongoose.model('Reservation', reservationSchema);
