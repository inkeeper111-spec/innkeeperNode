import { ROLES } from '../config/constants.js';
import { StaffProfile, User } from '../models/index.js';
import { logAudit } from '../services/auditService.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  getPermissionOverrides,
  isValidPermissionOverride
} from '../services/permissions.js';

const STAFF_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.RESTAURANT_STAFF,
  ROLES.HOUSEKEEPING_STAFF,
  ROLES.MAINTENANCE_STAFF
];

export const getPermissionSettings = async (req, res, next) => {
  try {
    const profiles = await StaffProfile.find({ hotelId: req.hotelId })
      .populate('userId', 'name email role isActive permissionOverrides')
      .sort({ createdAt: -1 });
    const users = profiles
      .filter(({ userId }) => userId && STAFF_ROLES.includes(userId.role))
      .map(({ userId, department, designation }) => ({
        id: String(userId._id),
        name: userId.name,
        email: userId.email,
        role: userId.role,
        isActive: userId.isActive,
        department,
        designation,
        permissionOverrides: getPermissionOverrides(userId)
      }));
    const roleDefaults = Object.fromEntries(STAFF_ROLES.map((role) => {
      const defaults = {};
      PERMISSION_MODULES.forEach(({ key }) => {
        PERMISSION_ACTIONS.forEach((action) => {
          const permission = `${key}.${action}`;
          defaults[permission] = (DEFAULT_ROLE_PERMISSIONS[role] || []).includes(permission);
        });
      });
      return [role, defaults];
    }));

    res.json({
      success: true,
      data: {
        users,
        modules: PERMISSION_MODULES.map(({ key, label }) => ({ key, label })),
        actions: PERMISSION_ACTIONS,
        roleDefaults
      }
    });
  } catch (error) {
    next(error);
  }
};

export const updateUserPermissions = async (req, res, next) => {
  try {
    const { permissionOverrides } = req.body;
    if (!isValidPermissionOverride(permissionOverrides)) {
      return res.status(400).json({
        success: false,
        message: 'Permission overrides must contain valid permission keys with boolean values.'
      });
    }

    const targetUser = await User.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      role: { $in: STAFF_ROLES }
    });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Staff user not found for this hotel.' });
    }

    targetUser.permissionOverrides = permissionOverrides;
    await targetUser.save();
    await logAudit({
      hotelId: req.hotelId,
      action: 'STAFF_PERMISSIONS_UPDATED',
      entity: 'User',
      entityId: targetUser._id,
      details: { permissionOverrides },
      req
    });

    res.json({
      success: true,
      message: `Permissions updated for ${targetUser.name}.`,
      data: {
        id: String(targetUser._id),
        permissionOverrides: getPermissionOverrides(targetUser)
      }
    });
  } catch (error) {
    next(error);
  }
};
