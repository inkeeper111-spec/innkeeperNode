import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    default: null,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  recipientRole: {
    type: String,
    default: ''
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    default: 'system'
  },
  module: {
    type: String,
    default: 'system',
    trim: true,
    index: true
  },
  eventType: {
    type: String,
    default: '',
    trim: true
  },
  relatedRecordId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  priority: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium',
    index: true
  },
  eventId: {
    type: String,
    default: '',
    select: false
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    default: null
  },
  link: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

notificationSchema.index({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string', $gt: '' } } });
notificationSchema.index({ recipientId: 1, hotelId: 1, createdAt: -1 });

export const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
