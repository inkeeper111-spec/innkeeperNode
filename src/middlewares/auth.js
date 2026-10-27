import jwt from 'jsonwebtoken';
import { User, Hotel } from '../models/index.js';
import { ROLES, HOTEL_STATUS } from '../config/constants.js';

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
    if (!allowedRoles.includes(req.user.role) && req.user.role !== ROLES.SUPER_ADMIN) {
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

  if (hotel.status === HOTEL_STATUS.PENDING_APPROVAL) {
    req.hotelPending = true;
    req.hotel = hotel;
    return next();
  }

  if (hotel.status === HOTEL_STATUS.SUSPENDED) {
    return res.status(403).json({
      success: false,
      message: 'Hotel account has been suspended. Please contact platform support.',
      hotelStatus: hotel.status
    });
  }

  if (hotel.status === HOTEL_STATUS.REJECTED) {
    return res.status(403).json({
      success: false,
      message: 'Hotel account application was rejected.',
      hotelStatus: hotel.status
    });
  }

  req.hotel = hotel;
  next();
};
