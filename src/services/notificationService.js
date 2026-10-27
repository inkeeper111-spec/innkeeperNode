import { Notification, User } from '../models/index.js';

const DUPLICATE_KEY = 11000;

const createForRecipient = async ({
  hotelId = null,
  recipientId,
  recipientRole,
  title,
  message,
  module = 'system',
  eventType = '',
  relatedRecordId = null,
  priority = 'medium',
  link = '',
  eventId
}) => {
  if (!recipientId) return null;
  const notificationEventId = eventId ? `${eventId}:${String(recipientId)}` : '';
  try {
    return await Notification.create({
      hotelId,
      userId: recipientId,
      recipientId,
      recipientRole,
      title,
      message,
      type: module,
      module,
      eventType,
      relatedRecordId,
      priority,
      link,
      eventId: notificationEventId
    });
  } catch (error) {
    if (error.code === DUPLICATE_KEY && notificationEventId) {
      return Notification.findOne({ eventId: notificationEventId }).lean();
    }
    throw error;
  }
};

export const notifyUsers = async ({
  hotelId = null,
  userIds,
  roles,
  title,
  message,
  module,
  eventType,
  relatedRecordId = null,
  priority = 'medium',
  link = '',
  eventId
}) => {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!uniqueIds.length) return [];
  const users = await User.find({
    _id: { $in: uniqueIds },
    ...(hotelId ? { hotelId } : {}),
    ...(Array.isArray(roles) && roles.length ? { role: { $in: roles } } : {})
  }).select('_id role hotelId').lean();
  return Promise.all(users.map((user) => createForRecipient({
    hotelId: user.hotelId || hotelId,
    recipientId: user._id,
    recipientRole: user.role,
    title,
    message,
    module,
    eventType,
    relatedRecordId,
    priority,
    link,
    eventId
  })));
};

export const notifyGuestByEmail = async ({
  hotelId,
  email,
  ...notification
}) => {
  if (!hotelId || !email) return [];
  const guestAccount = await User.findOne({
    hotelId,
    role: 'guest',
    isActive: true,
    email: String(email).trim().toLowerCase()
  }).select('_id').lean();
  if (!guestAccount) return [];
  return notifyUsers({ hotelId, userIds: [guestAccount._id], ...notification });
};

export const notifyRoles = async ({
  hotelId,
  roles,
  excludeUserIds = [],
  ...notification
}) => {
  if (!hotelId || !Array.isArray(roles) || roles.length === 0) return [];
  const users = await User.find({
    hotelId,
    role: { $in: roles },
    isActive: true,
    _id: { $nin: excludeUserIds }
  }).select('_id role').lean();
  return Promise.all(users.map((user) => createForRecipient({
    hotelId,
    recipientId: user._id,
    recipientRole: user.role,
    ...notification
  })));
};

export const notifyPlatformAdmins = async (notification) => {
  const admins = await User.find({ role: 'super_admin', isActive: true }).select('_id').lean();
  return Promise.all(admins.map((admin) => createForRecipient({
    recipientId: admin._id,
    recipientRole: 'super_admin',
    ...notification
  })));
};

export const notifyHotelOperations = async (notification) =>
  notifyRoles({
    ...notification,
    roles: ['hotel_admin']
  });
