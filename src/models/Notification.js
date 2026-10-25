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
    enum: ['booking', 'payment', 'housekeeping', 'maintenance', 'inventory', 'system'],
    default: 'system'
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  link: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

export const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

