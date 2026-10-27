import crypto from 'crypto';
import { User, Hotel, Property, SubscriptionPlan, Subscription } from '../models/index.js';
import { ROLES, HOTEL_STATUS, SUBSCRIPTION_STATUS } from '../config/constants.js';
import { generateTokens, verifyRefreshToken } from '../utils/token.js';
import { sendEmail } from '../services/emailService.js';
import { notifyPlatformAdmins } from '../services/notificationService.js';
import { logAudit } from '../services/auditService.js';

export const register = async (req, res, next) => {
  try {
    const {
      hotelName,
      name,
      email,
      password,
      phone,
      address,
      city,
      state,
      country = 'United States',
      postalCode,
      currency = 'USD'
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'An account with this email address already exists.' });
    }

    // Generate unique slug for hotel
    const baseSlug = hotelName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    let slug = baseSlug;
    let counter = 1;
    while (await Hotel.findOne({ slug })) {
      slug = `${baseSlug}-${counter++}`;
    }

    // Get Starter plan for trial
    let starterPlan = await SubscriptionPlan.findOne({ code: 'starter' });
    if (!starterPlan) {
      starterPlan = await SubscriptionPlan.create({
        name: 'Starter Plan',
        code: 'starter',
        description: 'Ideal for boutique hotels & bed & breakfasts',
        monthlyPrice: 49,
        annualPrice: 490,
        maxRooms: 20,
        maxUsers: 5,
        maxProperties: 1,
        enabledModules: ['rooms', 'reservations', 'guests', 'frontdesk', 'billing', 'housekeeping', 'restaurant', 'inventory', 'expenses', 'maintenance', 'reports'],
        aiUsageAllowance: 100
      });
    }

    // Create Hotel record (Pending approval by Super Admin)
    const hotel = await Hotel.create({
      name: hotelName,
      slug,
      email: email.toLowerCase(),
      phone,
      address,
      city,
      state,
      country,
      postalCode,
      currency,
      status: HOTEL_STATUS.PENDING_APPROVAL,
      currentPlanId: starterPlan._id,
      subscriptionStatus: SUBSCRIPTION_STATUS.TRIALING,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    });

    // Create Main Property/Branch for the hotel
    const property = await Property.create({
      hotelId: hotel._id,
      name: `${hotelName} Main Branch`,
      code: 'MAIN',
      address,
      city,
      state,
      country,
      phone,
      isMainBranch: true,
      status: 'active'
    });

    // Create Hotel Owner / Admin User
    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      role: ROLES.HOTEL_ADMIN,
      hotelId: hotel._id,
      propertyId: property._id,
      phone,
      isActive: true,
      isEmailVerified: true
    });

    // Link owner to hotel
    hotel.ownerId = user._id;
    await hotel.save();

    // Create active subscription entry for the 14-day trial
    await Subscription.create({
      hotelId: hotel._id,
      planId: starterPlan._id,
      status: SUBSCRIPTION_STATUS.TRIALING,
      billingCycle: 'monthly',
      startDate: new Date(),
      endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      amount: 0,
      paymentMethod: 'trial'
    });

    const tokens = generateTokens(user);

    // Store refresh token
    user.refreshTokens.push({
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    user.lastLogin = new Date();
    await user.save();

    await logAudit({
      hotelId: hotel._id,
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'REGISTER_HOTEL',
      entity: 'Hotel',
      entityId: hotel._id,
      details: { hotelName, slug }
    });

    await notifyPlatformAdmins({
      hotelId: hotel._id,
      title: 'New hotel application received',
      message: `${hotel.name} has submitted its first administrator account for approval.`,
      module: 'platform',
      eventType: 'hotel_registered',
      relatedRecordId: hotel._id,
      priority: 'medium',
      link: '/superadmin',
      eventId: `hotel-registered:${hotel._id}`
    });

    // Send Welcome Email
    sendEmail({
      to: user.email,
      subject: 'Welcome to Innkeeper - Hotel Application Received',
      text: `Hello ${user.name},\n\nThank you for registering ${hotel.name} with Innkeeper. Your account is created and pending initial platform verification.\n\nBest regards,\nInnkeeper Team`
    });

    res.status(201).json({
      success: true,
      message: 'Hotel account registered successfully. Pending platform approval.',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          hotelId: user.hotelId,
          propertyId: user.propertyId
        },
        hotel: {
          id: hotel._id,
          name: hotel.name,
          slug: hotel.slug,
          status: hotel.status
        },
        approval: {
          required: true,
          status: hotel.status,
          message: 'Your hotel application was submitted for Product Admin approval. You are registered as the first hotel administrator.'
        },
        ...tokens
      }
    });
  } catch (err) {
    next(err);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password.' });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isMatch = await user.comparePassword(String(password));
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Please contact administrator.' });
    }

    const { portal } = req.body;
    if (portal && !['staff', 'guest'].includes(portal)) {
      return res.status(400).json({ success: false, message: 'Unsupported portal.' });
    }
    if (portal === 'staff' && user.role === ROLES.GUEST) {
      return res.status(403).json({ success: false, message: 'Guest accounts cannot sign in to the staff portal.' });
    }
    if (portal === 'guest' && user.role !== ROLES.GUEST) {
      return res.status(403).json({ success: false, message: 'This account cannot sign in to the guest portal.' });
    }

    let hotel = null;
    if (user.hotelId) {
      hotel = await Hotel.findById(user.hotelId);
    }

    const tokens = generateTokens(user);

    await User.updateOne(
      { _id: user._id },
      {
        $set: { lastLogin: new Date() },
        $push: {
          refreshTokens: {
            token: tokens.refreshToken,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          }
        }
      }
    );

    await logAudit({
      hotelId: user.hotelId,
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'LOGIN',
      entity: 'User',
      entityId: user._id,
      req
    });

    res.json({
      success: true,
      message: 'Logged in successfully',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          hotelId: user.hotelId,
          propertyId: user.propertyId
        },
        hotel: hotel ? {
          id: hotel._id,
          name: hotel.name,
          slug: hotel.slug,
          status: hotel.status,
          currency: hotel.currency,
          attendanceLocation: hotel.attendanceLocation
        } : null,
        homePath: user.role === ROLES.SUPER_ADMIN
          ? '/superadmin'
          : user.role === ROLES.RECEPTIONIST
            ? '/frontdesk'
            : user.role === ROLES.RESTAURANT_STAFF
              ? '/restaurant'
              : user.role === ROLES.HOUSEKEEPING_STAFF
                ? '/housekeeping'
                : user.role === ROLES.MAINTENANCE_STAFF
                  ? '/maintenance'
                  : '/dashboard',
        ...tokens
      }
    });
  } catch (err) {
    next(err);
  }
};

export const refreshAccessToken = async (req, res, next) => {
  try {
    const { refreshToken, expectedUserId } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'Refresh token required.' });
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (expectedUserId && String(decoded.id) !== String(expectedUserId)) {
      return res.status(401).json({ success: false, message: 'Refresh token does not match the authenticated account.' });
    }
    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or inactive.' });
    }

    const tokenDoc = user.refreshTokens.find(t => t.token === refreshToken);
    if (!tokenDoc) {
      return res.status(401).json({ success: false, message: 'Invalid or revoked refresh token.' });
    }

    const tokens = generateTokens(user);

    // Replace old refresh token with new one
    user.refreshTokens = user.refreshTokens.filter(t => t.token !== refreshToken);
    user.refreshTokens.push({
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    await user.save();

    res.json({
      success: true,
      data: tokens
    });
  } catch (err) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(err.name)) {
      return res.status(401).json({ success: false, message: 'Expired or invalid refresh token.' });
    }
    return next(err);
  }
};

export const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (req.user && refreshToken) {
      req.user.refreshTokens = req.user.refreshTokens.filter(t => t.token !== refreshToken);
      await req.user.save();
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
};

export const getCurrentUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    let hotel = null;
    let property = null;

    if (user.hotelId) {
      hotel = await Hotel.findById(user.hotelId);
    }
    if (user.propertyId) {
      property = await Property.findById(user.propertyId);
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone,
          hotelId: user.hotelId,
          propertyId: user.propertyId
        },
        hotel,
        property
      }
    });
  } catch (err) {
    next(err);
  }
};

export const updateProfile = async (req, res, next) => {
  try {
    const { name, phone, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');

    if (name) user.name = name;
    if (phone !== undefined) user.phone = phone;

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: 'Current password required to set a new password.' });
      }
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
      }
      user.password = newPassword;
    }

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (err) {
    next(err);
  }
};

export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Return 200 to prevent user enumeration
      return res.json({ success: true, message: 'If that email is registered, a password reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    const resetUrl = `${req.headers.origin || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Password Reset Request - Innkeeper',
      text: `You requested a password reset. Please click: ${resetUrl}\n\nIf you did not request this, please ignore this email.`
    });

    res.json({
      success: true,
      message: 'If that email is registered, a password reset link has been sent.',
      // For development ease, include token if in non-production
      devResetToken: process.env.NODE_ENV !== 'production' ? resetToken : undefined
    });
  } catch (err) {
    next(err);
  }
};

export const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired password reset token.' });
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.refreshTokens = []; // Revoke previous sessions
    await user.save();

    res.json({ success: true, message: 'Password reset successfully. You may now login.' });
  } catch (err) {
    next(err);
  }
};
