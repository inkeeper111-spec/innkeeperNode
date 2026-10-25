import { Notification } from '../models/index.js';

export const getNotifications = async (req, res, next) => {
  try {
    const notifications = await Notification.find({ hotelId: req.hotelId })
      .sort({ createdAt: -1 })
      .limit(20);

    const unreadCount = await Notification.countDocuments({ hotelId: req.hotelId, isRead: false });

    res.json({
      success: true,
      data: {
        notifications,
        unreadCount
      }
    });
  } catch (err) {
    next(err);
  }
};

export const markAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      { hotelId: req.hotelId, isRead: false },
      { isRead: true }
    );
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    next(err);
  }
};

