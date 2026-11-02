import dayjs from 'dayjs';
import { Hotel, Payment, Subscription, SubscriptionModule, SubscriptionSettings } from '../models/index.js';
import { HOTEL_STATUS, PAYMENT_METHODS, SUBSCRIPTION_STATUS } from '../config/constants.js';
import { createRazorpayOrder, verifyRazorpayPayment } from '../services/razorpayService.js';
import { ensureSubscriptionCatalog } from '../services/subscriptionCatalog.js';
import { logAudit } from '../services/auditService.js';

const isApproved = (hotel) =>
  (hotel.registrationStatus || (hotel.status === HOTEL_STATUS.PENDING_APPROVAL ? 'pending' : 'approved')) === 'approved'
  && ![HOTEL_STATUS.SUSPENDED, HOTEL_STATUS.REJECTED, HOTEL_STATUS.PENDING_APPROVAL].includes(hotel.status);

const getBillingAmount = (modules, billingCycle, minimumMonthlyAmount) => {
  const moduleTotal = modules.reduce((sum, module) => sum + module[`${billingCycle}Price`], 0);
  const configuredMinimum = Math.max(999, Number(minimumMonthlyAmount) || 999);
  const minimum = billingCycle === 'annual' ? configuredMinimum * 12 : configuredMinimum;
  return {
    moduleTotal: Math.round(moduleTotal * 100) / 100,
    finalAmount: Math.round(Math.max(minimum, moduleTotal) * 100) / 100
  };
};

const getHotelSubscriptionContext = async (req, res) => {
  if (!req.user?.hotelId || req.user.role !== 'hotel_admin') {
    res.status(403).json({ success: false, message: 'Only the Hotel Admin can manage this hotel subscription.' });
    return null;
  }
  const hotel = await Hotel.findById(req.user.hotelId);
  if (!hotel) {
    res.status(404).json({ success: false, message: 'Hotel organization not found.' });
    return null;
  }
  if (!isApproved(hotel)) {
    res.status(403).json({
      success: false,
      message: 'Subscription selection is available after Super Admin approval.',
      code: 'REGISTRATION_NOT_APPROVED',
      registrationStatus: hotel.registrationStatus || 'pending'
    });
    return null;
  }
  return hotel;
};

export const getSubscriptionOptions = async (req, res, next) => {
  try {
    const hotel = await getHotelSubscriptionContext(req, res);
    if (!hotel) return;
    await ensureSubscriptionCatalog();
    const [modules, settings, activeSubscription] = await Promise.all([
      SubscriptionModule.find({ enabled: true }).sort({ name: 1 }).lean(),
      SubscriptionSettings.findOne({ key: 'global' }).lean(),
      Subscription.findOne({
        hotelId: hotel._id,
        status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELED] },
        endDate: { $gt: new Date() }
      }).sort({ createdAt: -1 }).lean()
    ]);
    const subscription = activeSubscription || await Subscription.findOne({ hotelId: hotel._id })
      .sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      data: {
        modules,
        minimumMonthlyAmount: Math.max(999, settings.minimumMonthlyAmount),
        currentSubscription: subscription
      }
    });
  } catch (err) {
    next(err);
  }
};

export const createSubscriptionOrder = async (req, res, next) => {
  try {
    const hotel = await getHotelSubscriptionContext(req, res);
    if (!hotel) return;
    if (hotel.subscriptionStatus === SUBSCRIPTION_STATUS.SUSPENDED) {
      return res.status(403).json({
        success: false,
        message: 'Your subscription has been suspended by platform administration.',
        code: 'SUBSCRIPTION_SUSPENDED'
      });
    }
    const { selectedModules, billingCycle = 'monthly' } = req.body;
    if (!Array.isArray(selectedModules) || selectedModules.length === 0
      || selectedModules.some((key) => typeof key !== 'string')
      || new Set(selectedModules).size !== selectedModules.length) {
      return res.status(400).json({ success: false, message: 'Select one or more valid subscription modules.' });
    }
    if (!['monthly', 'annual'].includes(billingCycle)) {
      return res.status(400).json({ success: false, message: 'Billing cycle must be monthly or annual.' });
    }

    await ensureSubscriptionCatalog();
    const keys = selectedModules.map((key) => key.trim().toLowerCase());
    if (keys.some((key) => !key)) {
      return res.status(400).json({ success: false, message: 'Selected module keys must not be empty.' });
    }
    const modules = await SubscriptionModule.find({ key: { $in: keys }, enabled: true }).lean();
    if (modules.length !== keys.length) {
      return res.status(400).json({ success: false, message: 'One or more selected modules are unavailable.' });
    }
    const settings = await SubscriptionSettings.findOne({ key: 'global' }).lean();
    const { moduleTotal, finalAmount } = getBillingAmount(modules, billingCycle, settings.minimumMonthlyAmount);
    const currentSubscription = await Subscription.findOne({
      hotelId: hotel._id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      endDate: { $gt: new Date() }
    }).sort({ createdAt: -1 }).lean();
    if (currentSubscription?.selectedModules?.some((key) => !keys.includes(key))) {
      return res.status(409).json({
        success: false,
        message: 'Module removals take effect at the next billing cycle. Schedule removals instead of creating a smaller subscription before then.'
      });
    }
    const periodEnd = billingCycle === 'annual' ? dayjs().add(1, 'year') : dayjs().add(1, 'month');
    const subscription = await Subscription.create({
      hotelId: hotel._id,
      selectedModules: keys,
      selectedModulePrices: modules.map(({ key, monthlyPrice, annualPrice }) => ({ key, monthlyPrice, annualPrice })),
      billingCycle,
      moduleTotal,
      finalAmount,
      amount: finalAmount,
      currency: 'INR',
      status: SUBSCRIPTION_STATUS.PENDING,
      paymentStatus: 'pending',
      startDate: new Date(),
      endDate: periodEnd.toDate(),
      nextBillingDate: periodEnd.toDate(),
      paymentMethod: PAYMENT_METHODS.RAZORPAY
    });
    const order = await createRazorpayOrder({
      amount: finalAmount,
      currency: 'INR',
      receipt: `sub_${subscription._id}`,
      notes: { subscriptionId: String(subscription._id), hotelId: String(hotel._id) }
    });
    subscription.razorpayOrderId = order.id;
    await subscription.save();
    await Payment.create({
      hotelId: hotel._id,
      subscriptionId: subscription._id,
      amount: finalAmount,
      currency: 'INR',
      method: PAYMENT_METHODS.RAZORPAY,
      status: 'pending',
      razorpayOrderId: order.id,
      notes: `Subscription ${billingCycle} payment`
    });
    await logAudit({
      hotelId: hotel._id,
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'SUBSCRIPTION_PAYMENT_ORDER_CREATED',
      entity: 'Subscription',
      entityId: subscription._id,
      details: { selectedModules: keys, billingCycle, moduleTotal, finalAmount },
      req
    });
    res.status(201).json({
      success: true,
      data: {
        order,
        subscriptionId: subscription._id,
        keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder_key_id',
        currency: 'INR',
        moduleTotal,
        minimumAmount: billingCycle === 'annual'
          ? Math.max(999, settings.minimumMonthlyAmount) * 12
          : Math.max(999, settings.minimumMonthlyAmount),
        finalAmount,
        billingCycle,
        selectedModules: keys
      }
    });
  } catch (err) {
    next(err);
  }
};

export const completeSubscriptionPayment = async ({ subscription, razorpayPaymentId, razorpaySignature, userId = null, req = null }) => {
  const alreadyProcessed = await Payment.findOne({
    razorpayPaymentId,
    status: 'captured'
  });
  if (alreadyProcessed) {
    if (String(alreadyProcessed.subscriptionId) !== String(subscription._id)
      || alreadyProcessed.razorpayOrderId !== subscription.razorpayOrderId) {
      const conflict = new Error('This Razorpay payment is already associated with another transaction.');
      conflict.statusCode = 409;
      throw conflict;
    }
    return { subscription, payment: alreadyProcessed, alreadyProcessed: true };
  }
  const pendingPayment = await Payment.findOne({
    subscriptionId: subscription._id,
    razorpayOrderId: subscription.razorpayOrderId,
    status: 'pending'
  });
  if (!pendingPayment) {
    const notFound = new Error('Subscription payment record was not found for the pending order.');
    notFound.statusCode = 404;
    throw notFound;
  }
  const hotel = await Hotel.findById(subscription.hotelId).select('registrationStatus status');
  if (!hotel || hotel.registrationStatus !== 'approved' || hotel.status === HOTEL_STATUS.SUSPENDED) {
    const conflict = new Error('Hotel registration must remain approved to activate the subscription.');
    conflict.statusCode = 409;
    throw conflict;
  }

  const activated = await Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      status: SUBSCRIPTION_STATUS.PENDING,
      paymentStatus: 'pending'
    },
    {
      $set: {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        paymentStatus: 'paid',
        razorpayPaymentId,
        startDate: new Date(),
        endDate: subscription.billingCycle === 'annual' ? dayjs().add(1, 'year').toDate() : dayjs().add(1, 'month').toDate(),
        nextBillingDate: subscription.billingCycle === 'annual' ? dayjs().add(1, 'year').toDate() : dayjs().add(1, 'month').toDate()
      }
    },
    { new: true }
  );
  if (!activated) {
    const current = await Subscription.findById(subscription._id);
    if (current?.status === SUBSCRIPTION_STATUS.ACTIVE && current.razorpayPaymentId === razorpayPaymentId) {
      const payment = await Payment.findOne({ subscriptionId: current._id, razorpayPaymentId });
      return { subscription: current, payment, alreadyProcessed: true };
    }
    const conflict = new Error('This subscription payment has already been processed or is no longer payable.');
    conflict.statusCode = 409;
    throw conflict;
  }

  await Subscription.updateMany(
    { hotelId: activated.hotelId, _id: { $ne: activated._id }, status: SUBSCRIPTION_STATUS.ACTIVE },
    { $set: { status: SUBSCRIPTION_STATUS.CANCELED } }
  );
  const payment = await Payment.findOneAndUpdate(
    { subscriptionId: activated._id, razorpayOrderId: activated.razorpayOrderId },
    {
      $set: {
        status: 'captured',
        amount: activated.finalAmount,
        currency: 'INR',
        razorpayPaymentId,
        razorpaySignature,
        transactionRef: razorpayPaymentId,
        paymentDate: new Date(),
        recordedBy: userId
      }
    },
    { new: true }
  );
  if (!payment) {
    throw new Error('Subscription payment record was not found for the verified order.');
  }
  const hotelUpdate = await Hotel.updateOne(
    {
      _id: activated.hotelId,
      registrationStatus: 'approved',
      status: { $ne: HOTEL_STATUS.SUSPENDED },
      subscriptionStatus: { $ne: SUBSCRIPTION_STATUS.SUSPENDED }
    },
    { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE, status: HOTEL_STATUS.ACTIVE } }
  );
  if (!hotelUpdate.matchedCount) {
    await Subscription.updateOne(
      { _id: activated._id },
      { $set: { status: SUBSCRIPTION_STATUS.SUSPENDED } }
    );
    activated.status = SUBSCRIPTION_STATUS.SUSPENDED;
  }
  await logAudit({
    hotelId: activated.hotelId,
    userId,
    action: 'SUBSCRIPTION_PAYMENT_VERIFIED',
    entity: 'Subscription',
    entityId: activated._id,
    details: {
      razorpayPaymentId,
      selectedModules: activated.selectedModules,
      amount: activated.finalAmount,
      billingCycle: activated.billingCycle
    },
    req
  });
  return { subscription: activated, payment, alreadyProcessed: false };
};

export const verifySubscriptionPayment = async (req, res, next) => {
  try {
    const hotel = await getHotelSubscriptionContext(req, res);
    if (!hotel) return;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    if (![razorpayOrderId, razorpayPaymentId, razorpaySignature].every((value) => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ success: false, message: 'Razorpay payment details are incomplete.' });
    }
    const subscription = await Subscription.findOne({
      hotelId: hotel._id,
      razorpayOrderId,
      status: SUBSCRIPTION_STATUS.PENDING,
      paymentStatus: 'pending'
    });
    if (!subscription) {
      const existing = await Subscription.findOne({ hotelId: hotel._id, razorpayOrderId });
      if (existing?.status === SUBSCRIPTION_STATUS.ACTIVE && existing.razorpayPaymentId === razorpayPaymentId) {
        return res.json({ success: true, message: 'Payment was already verified.', data: { subscription: existing } });
      }
      return res.status(404).json({ success: false, message: 'Pending subscription payment order not found.' });
    }
    if (!verifyRazorpayPayment({ orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature })) {
      await Subscription.updateOne({ _id: subscription._id }, { $set: { paymentStatus: 'failed' } });
      await Payment.updateOne(
        { subscriptionId: subscription._id, razorpayOrderId },
        { $set: { status: 'failed', notes: 'Razorpay signature verification failed.' } }
      );
      await logAudit({
        hotelId: hotel._id,
        userId: req.user._id,
        action: 'SUBSCRIPTION_PAYMENT_VERIFICATION_FAILED',
        entity: 'Subscription',
        entityId: subscription._id,
        details: { razorpayOrderId },
        req
      });
      return res.status(400).json({ success: false, message: 'Payment verification failed. Invalid Razorpay signature.' });
    }
    const result = await completeSubscriptionPayment({
      subscription,
      razorpayPaymentId,
      razorpaySignature,
      userId: req.user._id,
      req
    });
    res.json({
      success: true,
      message: 'Payment verified. Your selected modules are now active.',
      data: result
    });
  } catch (err) {
    next(err);
  }
};

export const failSubscriptionPayment = async (req, res, next) => {
  try {
    const hotel = await getHotelSubscriptionContext(req, res);
    if (!hotel) return;
    const { razorpayOrderId } = req.body;
    const subscription = await Subscription.findOne({
      hotelId: hotel._id,
      razorpayOrderId,
      status: SUBSCRIPTION_STATUS.PENDING,
      paymentStatus: 'pending'
    });
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'Pending subscription payment order not found.' });
    }
    subscription.paymentStatus = 'failed';
    subscription.status = SUBSCRIPTION_STATUS.PAST_DUE;
    await subscription.save();
    await Payment.updateOne(
      { subscriptionId: subscription._id, razorpayOrderId },
      { $set: { status: 'failed', notes: 'Razorpay checkout did not complete.' } }
    );
    await logAudit({
      hotelId: hotel._id,
      userId: req.user._id,
      action: 'SUBSCRIPTION_PAYMENT_FAILED',
      entity: 'Subscription',
      entityId: subscription._id,
      details: { razorpayOrderId },
      req
    });
    res.json({ success: true, message: 'Payment failure recorded. You can retry checkout.' });
  } catch (err) {
    next(err);
  }
};

export const scheduleModuleRemovals = async (req, res, next) => {
  try {
    const hotel = await getHotelSubscriptionContext(req, res);
    if (!hotel) return;
    const removals = req.body.moduleKeys;
    if (!Array.isArray(removals) || removals.some((key) => typeof key !== 'string')) {
      return res.status(400).json({ success: false, message: 'Provide module keys to schedule for removal.' });
    }
    const subscription = await Subscription.findOne({
      hotelId: hotel._id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      endDate: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    if (!subscription) {
      return res.status(409).json({ success: false, message: 'An active subscription is required to change modules.' });
    }
    const requested = [...new Set(removals.map((key) => key.trim().toLowerCase()))];
    if (requested.some((key) => !subscription.selectedModules.includes(key))) {
      return res.status(400).json({ success: false, message: 'A removal key is not part of the current subscription.' });
    }
    subscription.scheduledModuleRemovals = requested;
    subscription.scheduledChangesAt = subscription.nextBillingDate || subscription.endDate;
    await subscription.save();
    await logAudit({
      hotelId: hotel._id,
      userId: req.user._id,
      action: 'SUBSCRIPTION_MODULE_REMOVALS_SCHEDULED',
      entity: 'Subscription',
      entityId: subscription._id,
      details: { moduleKeys: requested, effectiveAt: subscription.scheduledChangesAt },
      req
    });
    res.json({
      success: true,
      message: 'Module removals will take effect at the next billing cycle.',
      data: { scheduledModuleRemovals: subscription.scheduledModuleRemovals, scheduledChangesAt: subscription.scheduledChangesAt }
    });
  } catch (err) {
    next(err);
  }
};
