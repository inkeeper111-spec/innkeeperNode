import dayjs from 'dayjs';
import { Hotel, User, Property, Reservation, SubscriptionPlan, Subscription, Invoice, Payment, AuditLog } from '../models/index.js';
import { HOTEL_STATUS, SUBSCRIPTION_STATUS } from '../config/constants.js';
import { logAudit } from '../services/auditService.js';
import { sendEmail } from '../services/emailService.js';
import { notifyPlatformAdmins, notifyUsers } from '../services/notificationService.js';

export const getPlatformStats = async (req, res, next) => {
  try {
    const totalHotels      = await Hotel.countDocuments();
    const activeHotels     = await Hotel.countDocuments({ status: HOTEL_STATUS.ACTIVE });
    const pendingHotels    = await Hotel.countDocuments({ status: HOTEL_STATUS.PENDING_APPROVAL });
    const suspendedHotels  = await Hotel.countDocuments({ status: HOTEL_STATUS.SUSPENDED });
    const rejectedHotels   = await Hotel.countDocuments({ status: HOTEL_STATUS.REJECTED });
    const totalUsers       = await User.countDocuments();
    const totalBookings    = await Reservation.countDocuments();
    const totalProperties  = await Property.countDocuments();

    // Active subscription revenue
    const subscriptionsAgg = await Subscription.aggregate([
      { $match: { status: SUBSCRIPTION_STATUS.ACTIVE } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const platformRevenue = subscriptionsAgg[0]?.total || 0;

    // Monthly revenue trend (last 6 months of subscription payments)
    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = dayjs().subtract(i, 'month').startOf('month').toDate();
      const monthEnd   = dayjs().subtract(i, 'month').endOf('month').toDate();
      const agg = await Payment.aggregate([
        { $match: { createdAt: { $gte: monthStart, $lte: monthEnd }, status: 'captured' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      monthlyTrend.push({
        month: dayjs().subtract(i, 'month').format('MMM YYYY'),
        revenue: agg[0]?.total || 0
      });
    }

    // Recent hotel registrations
    const recentHotels = await Hotel.find()
      .sort({ createdAt: -1 })
      .limit(8)
      .populate('currentPlanId', 'name code monthlyPrice')
      .populate('ownerId', 'name email');

    res.json({
      success: true,
      data: {
        totalHotels,
        activeHotels,
        pendingHotels,
        suspendedHotels,
        rejectedHotels,
        totalUsers,
        totalBookings,
        totalProperties,
        platformRevenue,
        monthlyTrend,
        recentHotels
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getHotels = async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 15 } = req.query;
    const filter = {};

    if (status && status !== 'all') filter.status = status;

    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { city:  { $regex: search, $options: 'i' } }
      ];
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Hotel.countDocuments(filter);
    const hotels = await Hotel.find(filter)
      .populate('currentPlanId', 'name code monthlyPrice maxRooms maxUsers')
      .populate('ownerId', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: {
        hotels,
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getHotelById = async (req, res, next) => {
  try {
    const hotel = await Hotel.findById(req.params.id)
      .populate('currentPlanId')
      .populate('ownerId', 'name email phone role isActive');

    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }

    const properties  = await Property.find({ hotelId: hotel._id });
    const staffCount  = await User.countDocuments({ hotelId: hotel._id });
    const bookingCount = await Reservation.countDocuments({ hotelId: hotel._id });
    const subscription = await Subscription.findOne({ hotelId: hotel._id })
      .sort({ createdAt: -1 })
      .populate('planId', 'name code monthlyPrice');

    res.json({
      success: true,
      data: { hotel, properties, staffCount, bookingCount, subscription }
    });
  } catch (err) {
    next(err);
  }
};

export const updateHotelStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    if (!Object.values(HOTEL_STATUS).includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid hotel status value.' });
    }

    const hotel = await Hotel.findById(id).populate('ownerId', 'email name');
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }

    const previousStatus = hotel.status; // capture BEFORE mutation
    hotel.status = status;
    if (status === HOTEL_STATUS.REJECTED && rejectionReason) {
      hotel.rejectionReason = rejectionReason;
    }
    await hotel.save();

    await logAudit({
      hotelId: hotel._id,
      action: `HOTEL_STATUS_UPDATED_${status.toUpperCase()}`,
      entity: 'Hotel',
      entityId: hotel._id,
      details: { previousStatus, newStatus: status, rejectionReason },
      req
    });

    if (previousStatus !== status) {
      await notifyPlatformAdmins({
        title: 'Hotel status changed',
        message: `${hotel.name} is now ${status.replace(/_/g, ' ')}.`,
        module: 'platform',
        eventType: 'hotel_status_changed',
        relatedRecordId: hotel._id,
        priority: status === HOTEL_STATUS.SUSPENDED ? 'high' : 'medium',
        link: '/superadmin',
        eventId: `hotel-status:${hotel._id}:${status}:${hotel.updatedAt.getTime()}`
      });
      await notifyUsers({
        hotelId: hotel._id,
        userIds: [hotel.ownerId?._id],
        title: 'Hotel account status updated',
        message: `Your hotel account is now ${status.replace(/_/g, ' ')}.`,
        module: 'platform',
        eventType: 'hotel_status_changed',
        relatedRecordId: hotel._id,
        priority: status === HOTEL_STATUS.SUSPENDED ? 'high' : 'medium',
        link: '/dashboard',
        eventId: `hotel-status-owner:${hotel._id}:${status}:${hotel.updatedAt.getTime()}`
      });
    }

    // Notify hotel owner by email
    if (hotel.ownerId?.email) {
      const statusMessages = {
        [HOTEL_STATUS.ACTIVE]:           'Your hotel account has been approved and is now active. You can log in and begin operations.',
        [HOTEL_STATUS.SUSPENDED]:        'Your hotel account has been temporarily suspended. Please contact platform support for assistance.',
        [HOTEL_STATUS.REJECTED]:         `Your hotel account application has been rejected. Reason: ${rejectionReason || 'Please contact support.'}`,
        [HOTEL_STATUS.PENDING_APPROVAL]: 'Your hotel account has been set back to pending review.'
      };

      sendEmail({
        to: hotel.ownerId.email,
        subject: `Innkeeper — Hotel Account Update: ${hotel.name}`,
        text: `Hello ${hotel.ownerId.name},\n\n${statusMessages[status] || `Your account status is now: ${status}.`}\n\nBest regards,\nInnkeeper Platform Administration`
      });
    }

    res.json({
      success: true,
      message: `Hotel "${hotel.name}" status updated to ${status}.`,
      data: hotel
    });
  } catch (err) {
    next(err);
  }
};

export const assignPlanToHotel = async (req, res, next) => {
  try {
    const { planId, billingCycle = 'monthly' } = req.body;
    const hotel = await Hotel.findById(req.params.id);
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }

    const plan = await SubscriptionPlan.findById(planId);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Subscription plan not found.' });
    }

    const amount = billingCycle === 'annual' ? plan.annualPrice : plan.monthlyPrice;
    const endDate = billingCycle === 'annual'
      ? dayjs().add(1, 'year').toDate()
      : dayjs().add(1, 'month').toDate();

    // Expire old subscription
    await Subscription.updateMany(
      { hotelId: hotel._id, status: SUBSCRIPTION_STATUS.ACTIVE },
      { status: SUBSCRIPTION_STATUS.CANCELED }
    );

    const subscription = await Subscription.create({
      hotelId: hotel._id,
      planId: plan._id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      billingCycle,
      startDate: new Date(),
      endDate,
      amount,
      paymentMethod: 'manual_admin'
    });

    hotel.currentPlanId       = plan._id;
    hotel.subscriptionStatus  = SUBSCRIPTION_STATUS.ACTIVE;
    await hotel.save();

    await logAudit({
      hotelId: hotel._id,
      action: 'PLAN_ASSIGNED',
      entity: 'Hotel',
      entityId: hotel._id,
      details: { planName: plan.name, billingCycle, amount },
      req
    });

    res.json({
      success: true,
      message: `Plan "${plan.name}" assigned to ${hotel.name}.`,
      data: { hotel, subscription }
    });
  } catch (err) {
    next(err);
  }
};

export const getPlans = async (req, res, next) => {
  try {
    const plans = await SubscriptionPlan.find().sort({ monthlyPrice: 1 });
    res.json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
};

export const createPlan = async (req, res, next) => {
  try {
    const {
      name, code, description, monthlyPrice, annualPrice,
      maxRooms, maxUsers, maxProperties, enabledModules,
      aiUsageAllowance, supportLevel, trialDays
    } = req.body;

    // Prevent duplicate codes
    const existing = await SubscriptionPlan.findOne({ code: code.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: `A plan with code "${code}" already exists.` });
    }

    const plan = await SubscriptionPlan.create({
      name, code: code.toLowerCase(), description,
      monthlyPrice: Number(monthlyPrice),
      annualPrice: Number(annualPrice || monthlyPrice * 10),
      maxRooms: Number(maxRooms || 50),
      maxUsers: Number(maxUsers || 10),
      maxProperties: Number(maxProperties || 1),
      enabledModules: enabledModules || [],
      aiUsageAllowance: Number(aiUsageAllowance || 0),
      supportLevel: supportLevel || 'standard',
      trialDays: Number(trialDays || 14)
    });

    res.status(201).json({ success: true, message: 'Plan created.', data: plan });
  } catch (err) {
    next(err);
  }
};

export const updatePlan = async (req, res, next) => {
  try {
    const plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found.' });
    }
    res.json({ success: true, message: 'Plan updated.', data: plan });
  } catch (err) {
    next(err);
  }
};

export const getSubscriptions = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Subscription.countDocuments(filter);
    const subscriptions = await Subscription.find(filter)
      .populate('hotelId', 'name email status city country')
      .populate('planId',  'name code monthlyPrice maxRooms')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: {
        subscriptions,
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getAuditLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, action, hotelId } = req.query;
    const filter = {};
    if (action)  filter.action  = { $regex: action, $options: 'i' };
    if (hotelId) filter.hotelId = hotelId;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await AuditLog.countDocuments(filter);
    const logs  = await AuditLog.find(filter)
      .populate('hotelId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: {
        logs,
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getPlatformUsers = async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .populate('hotelId', 'name status')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-password -refreshTokens -resetPasswordToken');

    res.json({
      success: true,
      data: { users, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } }
    });
  } catch (err) {
    next(err);
  }
};
