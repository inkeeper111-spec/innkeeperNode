import { Notification } from '../models/index.js';

export const getNotifications = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      module,
      priority,
      isRead,
      startDate,
      endDate
    } = req.query;
    const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const recipientId = req.user._id;
    if (startDate && Number.isNaN(Date.parse(startDate))) {
      return res.status(400).json({ success: false, message: 'A valid start date is required.' });
    }
    if (endDate && Number.isNaN(Date.parse(endDate))) {
      return res.status(400).json({ success: false, message: 'A valid end date is required.' });
    }
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ success: false, message: 'Start date cannot be after end date.' });
    }
    if (isRead && !['true', 'false', 'all'].includes(isRead)) {
      return res.status(400).json({ success: false, message: 'Read status must be true, false, or all.' });
    }
    const hotelScope = req.user.role === 'super_admin'
      ? {}
      : { hotelId: req.hotelId };
    const filter = {
      ...hotelScope,
      $or: [{ recipientId }, { recipientId: null, userId: recipientId }]
    };
    if (module && module !== 'all') filter.module = module;
    if (priority && priority !== 'all') filter.priority = priority;
    if (isRead === 'true') filter.isRead = true;
    if (isRead === 'false') filter.isRead = false;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
      .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({
        ...hotelScope,
        $or: [{ recipientId }, { recipientId: null, userId: recipientId }],
        isRead: false
      })
    ]);

    res.json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: {
          total,
          page: pageNumber,
          limit: pageSize,
          pages: Math.ceil(total / pageSize)
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const markAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      {
        ...(req.user.role === 'super_admin' ? {} : { hotelId: req.hotelId }),
        $or: [
          { recipientId: req.user._id },
          { recipientId: null, userId: req.user._id }
        ],
        isRead: false
      },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    next(err);
  }
};

export const markNotificationAsRead = async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      {
        _id: req.params.id,
        ...(req.user.role === 'super_admin' ? {} : { hotelId: req.hotelId }),
        $or: [
          { recipientId: req.user._id },
          { recipientId: null, userId: req.user._id }
        ]
      },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    res.json({ success: true, data: notification });
  } catch (err) {
    next(err);
  }
};
