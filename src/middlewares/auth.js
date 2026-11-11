import jwt from 'jsonwebtoken';
import { User, Hotel, Subscription } from '../models/index.js';
import { ROLES, HOTEL_STATUS } from '../config/constants.js';
import { getRequestPermissionKey, hasExplicitPermission, hasPermission } from '../services/permissions.js';

export const authenticate = async (req, res, next) => {
  let decoded;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication required. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_grandstay_2026');
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired authentication token.' });
  }

  try {
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Account not found or inactive.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return next(err);
  }
};

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
    }
    if (
      !allowedRoles.includes(req.user.role)
      && req.user.role !== ROLES.SUPER_ADMIN
      && (() => {
        const permissionKey = getRequestPermissionKey(req);
        return !permissionKey || !hasExplicitPermission(req.user, permissionKey);
      })()
    ) {
      return res.status(403).json({ success: false, message: 'Forbidden. You do not have permission for this resource.' });
    }
    next();
  };
};

/**
 * Tenant Isolation Middleware
 * Derives hotelId strictly from authenticated user credentials.
 * Never trusts frontend-supplied hotelId.
 */
export const requireTenant = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  // Super admin can inspect any hotel via query/header or view all
  if (req.user.role === ROLES.SUPER_ADMIN) {
    req.hotelId = req.headers['x-hotel-id'] || req.query.hotelId || req.user.hotelId;
    return next();
  }

  if (req.user.role === ROLES.GUEST) {
    return res.status(403).json({ success: false, message: 'Guest accounts cannot access staff operations.' });
  }

  // Regular tenant users must have an assigned hotelId
  if (!req.user.hotelId) {
    return res.status(403).json({ success: false, message: 'No hotel associated with this user account.' });
  }

  req.hotelId = req.user.hotelId;
  req.propertyId = req.user.propertyId;

  // Verify hotel status
  const hotel = await Hotel.findById(req.hotelId);
  if (!hotel) {
    return res.status(404).json({ success: false, message: 'Hotel organization not found.' });
  }

  const path = req.baseUrl.replace(/^\/api\/v1/, '').replace(/^\//, '');
  req.hotel = hotel;
  if (['hotels', 'billing', 'notifications'].includes(path)) return next();

  const registrationStatus = hotel.registrationStatus
    || (hotel.status === HOTEL_STATUS.PENDING_APPROVAL ? 'pending' : hotel.status);
  if (registrationStatus === 'pending') {
    return res.status(403).json({
      success: false,
      message: 'Your hotel registration is awaiting Super Admin approval.',
      code: 'REGISTRATION_PENDING',
      registrationStatus
    });
  }
  if (registrationStatus === 'rejected') {
    return res.status(403).json({
      success: false,
      message: 'Hotel account application was rejected.',
      code: 'REGISTRATION_REJECTED',
      registrationStatus,
      rejectionReason: hotel.rejectionReason
    });
  }
  if (registrationStatus === 'suspended' || hotel.status === HOTEL_STATUS.SUSPENDED) {
    return res.status(403).json({
      success: false,
      message: 'Hotel account has been suspended. Please contact platform support.',
      code: 'HOTEL_SUSPENDED',
      registrationStatus
    });
  }

  if (hotel.subscriptionStatus === 'suspended') {
    return res.status(403).json({
      success: false,
      message: 'Your subscription has been suspended. Contact platform support for assistance.',
      code: 'SUBSCRIPTION_SUSPENDED',
      subscriptionStatus: hotel.subscriptionStatus
    });
  }

  let subscription = await Subscription.findOne({
    hotelId: hotel._id,
    status: { $in: ['active', 'canceled'] },
    paymentStatus: { $ne: 'failed' },
    endDate: { $gt: new Date() }
  }).sort({ createdAt: -1 });
  if (!subscription) {
    subscription = await Subscription.findOne({ hotelId: hotel._id }).sort({ createdAt: -1 });
  }
  const now = new Date();
  const paidThrough = subscription?.endDate && subscription.endDate > now;
  const usableStatus = subscription
    && ['active', 'canceled', 'trialing'].includes(subscription.status)
    && subscription.paymentStatus !== 'failed'
    && paidThrough;
  if (!usableStatus) {
    const status = subscription?.status || hotel.subscriptionStatus || 'not_started';
    const expired = subscription?.endDate && subscription.endDate <= now;
    return res.status(403).json({
      success: false,
      message: expired
        ? 'Your subscription has expired. Renew your subscription to continue.'
        : status === 'pending' || status === 'past_due'
          ? 'Your subscription payment is pending. Complete payment to continue.'
          : 'Choose and pay for a subscription to access hotel modules.',
      code: expired ? 'SUBSCRIPTION_EXPIRED' : status === 'pending' ? 'PAYMENT_PENDING' : 'SUBSCRIPTION_REQUIRED',
      subscriptionStatus: expired ? 'expired' : status
    });
  }

  req.subscription = subscription;
  const moduleByRoute = {
    'room-types': ['rooms', 'frontdesk'],
    rooms: ['rooms', 'frontdesk'],
    reservations: ['reservations', 'frontdesk'],
    guests: ['guests', 'frontdesk'],
    housekeeping: 'housekeeping',
    restaurant: 'restaurant',
    inventory: 'inventory',
    expenses: 'expenses',
    maintenance: 'maintenance',
    staff: 'staff',
    payroll: 'staff',
    leave: 'staff',
    reports: 'reports',
    ai: 'ai_assistant'
  };
  const moduleKeys = path === 'reports' && req.path === '/dashboard'
    ? ['reports', 'dashboard']
    : moduleByRoute[path] ? [moduleByRoute[path]].flat() : [];
  if (moduleKeys.length && Array.isArray(subscription.selectedModules) && subscription.selectedModules.length) {
    if (!moduleKeys.some((moduleKey) => subscription.selectedModules.includes(moduleKey))) {
      const moduleKey = moduleKeys[0];
      return res.status(403).json({
        success: false,
        message: `The ${moduleKey.replace(/_/g, ' ')} module is not included in your subscription.`,
        code: 'MODULE_NOT_SUBSCRIBED',
        module: moduleKey
      });
    }
  } else if (moduleKeys.length && !subscription.planId) {
    return res.status(403).json({
      success: false,
      message: `The ${moduleKeys[0].replace(/_/g, ' ')} module is not included in your subscription.`,
      code: 'MODULE_NOT_SUBSCRIBED',
      module: moduleKeys[0]
    });
  }

  const permissionKey = getRequestPermissionKey(req);
  if (permissionKey && !hasPermission(req.user, permissionKey)) {
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to perform this action.',
      code: 'PERMISSION_DENIED',
      permission: permissionKey
    });
  }
  next();
};
