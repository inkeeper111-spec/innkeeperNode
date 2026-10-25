import { AuditLog } from '../models/AuditLog.js';
import { logger } from '../config/logger.js';

export const logAudit = async ({
  hotelId = null,
  userId = null,
  userEmail = '',
  userRole = '',
  action,
  entity,
  entityId = '',
  details = {},
  req = null
}) => {
  try {
    const ipAddress = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '') : '';
    const userAgent = req ? req.headers['user-agent'] : '';

    await AuditLog.create({
      hotelId,
      userId: userId || (req?.user ? req.user._id : null),
      userEmail: userEmail || (req?.user ? req.user.email : ''),
      userRole: userRole || (req?.user ? req.user.role : ''),
      action,
      entity,
      entityId: String(entityId),
      details,
      ipAddress,
      userAgent
    });
  } catch (err) {
    logger.error('Failed to write audit log:', err.message);
  }
};

