import { Hotel, Subscription, SubscriptionModule, SubscriptionSettings, Payment } from '../models/index.js';
import { SUBSCRIPTION_STATUS } from '../config/constants.js';
import { ensureSubscriptionCatalog } from '../services/subscriptionCatalog.js';
import { logAudit } from '../services/auditService.js';
import { notifyUsers } from '../services/notificationService.js';

export const getSubscriptionConfiguration = async (req, res, next) => {
  try {
    await ensureSubscriptionCatalog();
    const [modules, settings] = await Promise.all([
      SubscriptionModule.find().sort({ name: 1 }).lean(),
      SubscriptionSettings.findOne({ key: 'global' }).lean()
    ]);
    res.json({ success: true, data: { modules, settings } });
  } catch (err) {
    next(err);
  }
};

export const updateSubscriptionModule = async (req, res, next) => {
  try {
    await ensureSubscriptionCatalog();
    const { monthlyPrice, annualPrice, enabled, name, description } = req.body;
    const updates = {};
    for (const [field, value] of Object.entries({ monthlyPrice, annualPrice })) {
      if (value !== undefined) {
        const price = Number(value);
        if (!Number.isFinite(price) || price < 0 || Math.abs(price * 100 - Math.round(price * 100)) > 0.0000001) {
          return res.status(400).json({ success: false, message: `${field} must be a non-negative amount with at most two decimal places.` });
        }
        updates[field] = price;
      }
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'enabled must be a boolean.' });
      }
      updates.enabled = enabled;
    }
    if (name !== undefined) updates.name = String(name).trim();
    if (description !== undefined) updates.description = String(description).trim();
    const module = await SubscriptionModule.findOneAndUpdate(
      { key: req.params.key.toLowerCase() },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!module) return res.status(404).json({ success: false, message: 'Subscription module not found.' });
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'SUBSCRIPTION_MODULE_CONFIGURATION_UPDATED',
      entity: 'SubscriptionModule',
      entityId: module._id,
      details: updates,
      req
    });
    res.json({ success: true, message: 'Module subscription configuration updated.', data: module });
  } catch (err) {
    next(err);
  }
};

export const updateSubscriptionSettings = async (req, res, next) => {
  try {
    const minimumMonthlyAmount = Number(req.body.minimumMonthlyAmount);
    if (!Number.isFinite(minimumMonthlyAmount) || minimumMonthlyAmount < 999
      || Math.abs(minimumMonthlyAmount * 100 - Math.round(minimumMonthlyAmount * 100)) > 0.0000001) {
      return res.status(400).json({ success: false, message: 'Minimum monthly amount cannot be less than ₹999 and may have at most two decimal places.' });
    }
    const settings = await SubscriptionSettings.findOneAndUpdate(
      { key: 'global' },
      { $set: { minimumMonthlyAmount } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'SUBSCRIPTION_MINIMUM_UPDATED',
      entity: 'SubscriptionSettings',
      entityId: settings._id,
      details: { minimumMonthlyAmount },
      req
    });
    res.json({ success: true, message: 'Minimum subscription amount updated.', data: settings });
  } catch (err) {
    next(err);
  }
};

export const getModuleSubscribers = async (req, res, next) => {
  try {
    await ensureSubscriptionCatalog();
    const module = await SubscriptionModule.findOne({ key: req.params.key.toLowerCase() }).lean();
    if (!module) return res.status(404).json({ success: false, message: 'Subscription module not found.' });
    const subscriptions = await Subscription.find({
      selectedModules: module.key,
      status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELED] },
      endDate: { $gt: new Date() }
    })
      .populate('hotelId', 'name email phone city registrationStatus status')
      .sort({ endDate: 1 })
      .lean();
    res.json({ success: true, data: { module, subscriptions } });
  } catch (err) {
    next(err);
  }
};

export const updateManagedSubscription = async (req, res, next) => {
  try {
    const { action, days } = req.body;
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) return res.status(404).json({ success: false, message: 'Subscription not found.' });
    const hotel = await Hotel.findById(subscription.hotelId);
    if (!hotel) return res.status(404).json({ success: false, message: 'Hotel not found.' });
    if (action === 'activate' && hotel.registrationStatus !== 'approved') {
      return res.status(409).json({ success: false, message: 'Hotel registration must be approved before activating a subscription.' });
    }

    if (action === 'activate' || action === 'suspend') {
      const newStatus = action === 'activate' ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.SUSPENDED;
      subscription.status = newStatus;
      if (action === 'activate') {
        subscription.paymentStatus = 'paid';
        if (!subscription.startDate || subscription.startDate > new Date()) subscription.startDate = new Date();
        if (!subscription.endDate || subscription.endDate <= new Date()) {
          subscription.endDate = subscription.billingCycle === 'annual'
            ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        }
        subscription.nextBillingDate = subscription.endDate;
        hotel.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
      } else {
        hotel.subscriptionStatus = SUBSCRIPTION_STATUS.SUSPENDED;
      }
      await hotel.save();
    } else if (action === 'extend') {
      const additionalDays = Number(days);
      if (!Number.isInteger(additionalDays) || additionalDays < 1 || additionalDays > 3650) {
        return res.status(400).json({ success: false, message: 'Extension must be between 1 and 3650 days.' });
      }
      const from = subscription.endDate > new Date() ? subscription.endDate : new Date();
      subscription.endDate = new Date(from.getTime() + additionalDays * 24 * 60 * 60 * 1000);
      subscription.nextBillingDate = subscription.endDate;
      if (subscription.status === SUBSCRIPTION_STATUS.EXPIRED) {
        subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
        subscription.paymentStatus = 'paid';
        hotel.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
        await hotel.save();
      }
    } else {
      return res.status(400).json({ success: false, message: 'Action must be activate, suspend, or extend.' });
    }
    await subscription.save();
    await logAudit({
      hotelId: hotel._id,
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: `SUBSCRIPTION_${action.toUpperCase()}`,
      entity: 'Subscription',
      entityId: subscription._id,
      details: { days: action === 'extend' ? Number(days) : undefined, status: subscription.status },
      req
    });
    await notifyUsers({
      hotelId: hotel._id,
      userIds: [hotel.ownerId],
      title: 'Subscription updated by platform administration',
      message: action === 'suspend'
        ? 'Your hotel subscription has been suspended. Contact platform support for assistance.'
        : action === 'extend'
          ? `Your subscription expiry has been extended by ${days} days.`
          : 'Your subscription has been activated by platform administration.',
      module: 'platform',
      eventType: 'subscription_admin_update',
      relatedRecordId: subscription._id,
      priority: action === 'suspend' ? 'high' : 'medium',
      link: '/subscription',
      eventId: `subscription-admin:${subscription._id}:${action}:${subscription.updatedAt.getTime()}`
    });
    const payments = await Payment.find({ subscriptionId: subscription._id }).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      message: `Subscription ${action} completed.`,
      data: { subscription, payments }
    });
  } catch (err) {
    next(err);
  }
};
