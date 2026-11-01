import { Invoice, Payment, Reservation, Refund, Room } from '../models/index.js';
import { INVOICE_STATUS, PAYMENT_STATUS, PAYMENT_METHODS, RESERVATION_STATUS, ROOM_STATUS } from '../config/constants.js';
import { createRazorpayOrder, verifyRazorpayPayment, verifyWebhookSignature } from '../services/razorpayService.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyRoles } from '../services/notificationService.js';
import { formatCurrency } from '../utils/currency.js';

const applyPaymentToReservation = async (reservationId, amount, processedBy = null) => {
  if (!reservationId) return null;
  const reservation = await Reservation.findById(reservationId);
  if (!reservation) return null;

  reservation.paidAmount = Math.round((reservation.paidAmount + amount) * 100) / 100;
  reservation.balanceAmount = Math.max(0, Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100);
  reservation.paymentStatus = reservation.balanceAmount === 0
    ? PAYMENT_STATUS.PAID
    : PAYMENT_STATUS.PARTIALLY_PAID;

  if (
    reservation.paymentStatus === PAYMENT_STATUS.PAID
    && [RESERVATION_STATUS.APPROVED, RESERVATION_STATUS.CONFIRMED].includes(reservation.status)
  ) {
    reservation.status = RESERVATION_STATUS.CHECKED_IN;
    reservation.checkedInAt = new Date();
    if (processedBy) reservation.checkedInBy = processedBy;
    await Room.updateMany(
      { _id: { $in: reservation.rooms.map((room) => room.roomId) }, hotelId: reservation.hotelId },
      { $set: { roomStatus: ROOM_STATUS.OCCUPIED } }
    );
  }

  await reservation.save();
  return reservation;
};

export const getInvoices = async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const filter = { hotelId: req.hotelId };

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (search) {
      filter.invoiceNumber = { $regex: search, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Invoice.countDocuments(filter);
    const invoices = await Invoice.find(filter)
      .populate('guestId', 'name email phone')
      .populate('reservationId', 'bookingReference checkInDate checkOutDate')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: {
        invoices,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getInvoiceById = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('guestId')
      .populate('reservationId')
      .populate('hotelId', 'name email phone address city state country taxNumber invoicePrefix logo');

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const payments = await Payment.find({ invoiceId: invoice._id, hotelId: req.hotelId })
      .populate('recordedBy', 'name');

    res.json({
      success: true,
      data: {
        invoice,
        payments
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Record Payment (Cash, UPI, Card, Bank Transfer)
 */
export const recordPayment = async (req, res, next) => {
  try {
    const { invoiceId, amount, method, notes, transactionRef } = req.body;

    const invoice = await Invoice.findOne({ _id: invoiceId, hotelId: req.hotelId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const payAmount = Number(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please provide a valid payment amount.' });
    }

    // Create payment entry
    const payment = await Payment.create({
      hotelId: req.hotelId,
      reservationId: invoice.reservationId,
      invoiceId: invoice._id,
      amount: payAmount,
      currency: req.hotel?.currency || 'USD',
      method: method || PAYMENT_METHODS.CASH,
      status: 'captured',
      transactionRef: transactionRef || generateReference('TXN'),
      notes: notes || '',
      recordedBy: req.user._id
    });

    // Update Invoice balances
    const newPaid = Math.round((invoice.paidAmount + payAmount) * 100) / 100;
    const newBalance = Math.max(0, Math.round((invoice.totalAmount - newPaid) * 100) / 100);

    invoice.paidAmount = newPaid;
    invoice.balanceAmount = newBalance;
    invoice.status = newBalance === 0 ? INVOICE_STATUS.PAID : INVOICE_STATUS.PARTIALLY_PAID;
    await invoice.save();

    // Update Reservation balances if linked
    if (invoice.reservationId) {
      await applyPaymentToReservation(invoice.reservationId, payAmount, req.user._id);
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'PAYMENT_RECORDED',
      entity: 'Payment',
      entityId: payment._id,
      details: { invoiceNumber: invoice.invoiceNumber, amount: payAmount, method },
      req
    });

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully.',
      data: {
        payment,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getPayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = { hotelId: req.hotelId };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Payment.countDocuments(filter);
    const payments = await Payment.find(filter)
      .populate('invoiceId', 'invoiceNumber totalAmount balanceAmount')
      .populate('reservationId', 'bookingReference guestName')
      .populate('recordedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    const refundsByPayment = await Refund.aggregate([
      {
        $match: {
          hotelId: req.hotelId,
          status: 'processed',
          paymentId: { $in: payments.map((payment) => payment._id) }
        }
      },
      { $group: { _id: '$paymentId', totalRefunded: { $sum: '$amount' } } }
    ]);
    const refundedAmounts = new Map(
      refundsByPayment.map((refund) => [String(refund._id), Math.round(refund.totalRefunded * 100) / 100])
    );
    const paymentResults = payments.map((payment) => {
      const result = payment.toObject();
      result.refundedAmount = refundedAmounts.get(String(payment._id)) || 0;
      result.refundableAmount = Math.max(0, Math.round((payment.amount - result.refundedAmount) * 100) / 100);
      return result;
    });

    res.json({
      success: true,
      data: {
        payments: paymentResults,
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Razorpay: Create Payment Order
 */
export const createPaymentOrder = async (req, res, next) => {
  try {
    const { invoiceId, amount } = req.body;
    const invoice = await Invoice.findOne({ _id: invoiceId, hotelId: req.hotelId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const payAmount = Number(amount || invoice.balanceAmount);
    const order = await createRazorpayOrder({
      amount: payAmount,
      currency: req.hotel?.currency || 'USD',
      receipt: invoice.invoiceNumber,
      notes: {
        invoiceId: invoice._id.toString(),
        hotelId: req.hotelId.toString()
      }
    });

    res.json({
      success: true,
      data: {
        order,
        invoiceNumber: invoice.invoiceNumber,
        keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder_key_id'
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Razorpay: Verify Payment Signature & Settle
 */
export const verifyPayment = async (req, res, next) => {
  try {
    const { invoiceId, razorpayOrderId, razorpayPaymentId, razorpaySignature, amount } = req.body;

    const isValid = verifyRazorpayPayment({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature
    });

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Payment verification failed. Invalid signature.' });
    }

    const invoice = await Invoice.findOne({ _id: invoiceId, hotelId: req.hotelId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const payAmount = Number(amount || invoice.balanceAmount);

    const payment = await Payment.create({
      hotelId: req.hotelId,
      reservationId: invoice.reservationId,
      invoiceId: invoice._id,
      amount: payAmount,
      method: PAYMENT_METHODS.RAZORPAY,
      status: 'captured',
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      transactionRef: razorpayPaymentId,
      notes: 'Razorpay Online Checkout',
      recordedBy: req.user._id
    });

    // Update Invoice balances
    const newPaid = Math.round((invoice.paidAmount + payAmount) * 100) / 100;
    const newBalance = Math.max(0, Math.round((invoice.totalAmount - newPaid) * 100) / 100);

    invoice.paidAmount = newPaid;
    invoice.balanceAmount = newBalance;
    invoice.status = newBalance === 0 ? INVOICE_STATUS.PAID : INVOICE_STATUS.PARTIALLY_PAID;
    await invoice.save();

    // Update Reservation
    if (invoice.reservationId) {
      await applyPaymentToReservation(invoice.reservationId, payAmount, req.user._id);
    }

    res.json({
      success: true,
      message: 'Payment verified and captured successfully.',
      data: {
        payment,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Process Refund
 */
export const refundPayment = async (req, res, next) => {
  let session;
  try {
    const { paymentId, amount, reason } = req.body;
    const refundAmount = Number(amount);
    const refundReason = typeof reason === 'string' ? reason.trim() : '';
    if (
      !Number.isFinite(refundAmount)
      || refundAmount <= 0
      || Math.abs(refundAmount * 100 - Math.round(refundAmount * 100)) > 0.00001
    ) {
      return res.status(400).json({ success: false, message: 'Please provide a valid refund amount.' });
    }
    if (!refundReason) {
      return res.status(400).json({ success: false, message: 'A refund reason is required.' });
    }

    session = await Payment.db.startSession();
    let result;
    await session.withTransaction(async () => {
      const payment = await Payment.findOne({ _id: paymentId, hotelId: req.hotelId }).session(session);
      if (!payment) {
        const notFound = new Error('Payment record not found.');
        notFound.statusCode = 404;
        throw notFound;
      }
      if (!['captured', 'refunded'].includes(payment.status)) {
        const conflict = new Error('This payment has no refundable balance.');
        conflict.statusCode = 409;
        throw conflict;
      }

      const priorRefunds = await Refund.aggregate([
        { $match: { hotelId: payment.hotelId, paymentId: payment._id, status: 'processed' } },
        { $group: { _id: null, totalRefunded: { $sum: '$amount' } } }
      ]).session(session);
      const previouslyRefunded = Math.round((priorRefunds[0]?.totalRefunded || 0) * 100) / 100;
      const refundableAmount = Math.max(0, Math.round((payment.amount - previouslyRefunded) * 100) / 100);
      if (refundableAmount <= 0) {
        const conflict = new Error('This payment has no refundable balance.');
        conflict.statusCode = 409;
        throw conflict;
      }
      if (refundAmount - refundableAmount > 0.001) {
        const conflict = new Error(`Refund amount exceeds the refundable balance of ${formatCurrency(refundableAmount, req.hotel?.currency || 'USD')}.`);
        conflict.statusCode = 409;
        throw conflict;
      }

      const [refund] = await Refund.create([{
        hotelId: req.hotelId,
        paymentId: payment._id,
        invoiceId: payment.invoiceId,
        reservationId: payment.reservationId,
        amount: refundAmount,
        reason: refundReason,
        status: 'processed',
        processedBy: req.user._id
      }], { session });

      const cumulativeRefund = Math.round((previouslyRefunded + refundAmount) * 100) / 100;
      payment.status = cumulativeRefund >= payment.amount - 0.001 ? 'refunded' : 'captured';
      await payment.save({ session });

      let invoice = null;
      if (payment.invoiceId) {
        invoice = await Invoice.findOne({ _id: payment.invoiceId, hotelId: req.hotelId }).session(session);
        if (invoice) {
          invoice.paidAmount = Math.max(0, Math.round((invoice.paidAmount - refundAmount) * 100) / 100);
          invoice.balanceAmount = Math.max(0, Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100);
          invoice.status = invoice.paidAmount === 0 && cumulativeRefund > 0
            ? INVOICE_STATUS.REFUNDED
            : invoice.balanceAmount === 0
              ? INVOICE_STATUS.PAID
              : invoice.paidAmount > 0
                ? INVOICE_STATUS.PARTIALLY_PAID
                : INVOICE_STATUS.ISSUED;
          await invoice.save({ session });
        }
      }

      let reservation = null;
      if (payment.reservationId) {
        reservation = await Reservation.findOne({
          _id: payment.reservationId,
          hotelId: req.hotelId
        }).session(session);
        if (reservation) {
          reservation.paidAmount = Math.max(0, Math.round((reservation.paidAmount - refundAmount) * 100) / 100);
          reservation.balanceAmount = Math.max(0, Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100);
          reservation.paymentStatus = reservation.paidAmount === 0
            ? PAYMENT_STATUS.REFUNDED
            : reservation.balanceAmount === 0
              ? PAYMENT_STATUS.PAID
              : PAYMENT_STATUS.PARTIALLY_PAID;
          await reservation.save({ session });
        }
      }

      result = { refund, payment, invoice, reservation };
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'PAYMENT_REFUNDED',
      entity: 'Payment',
      entityId: result.payment._id,
      details: {
        refundId: String(result.refund._id),
        invoiceId: result.payment.invoiceId ? String(result.payment.invoiceId) : '',
        amount: refundAmount,
        reason: refundReason,
        method: result.payment.method
      },
      req
    });

    res.json({
      success: true,
      message: 'Refund recorded successfully.',
      data: result
    });
  } catch (err) {
    next(err);
  } finally {
    await session?.endSession();
  }
};


/**
 * Razorpay Webhook Handler
 * Called by Razorpay servers when payment events occur.
 * Uses raw body + HMAC-SHA256 signature verification.
 * Idempotent: skips already-processed payments.
 */
export const razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody; // set by express.raw() middleware on the webhook route

    if (!signature) {
      return res.status(400).json({ success: false, message: 'Missing webhook signature.' });
    }

    const isValid = verifyWebhookSignature(rawBody || JSON.stringify(req.body), signature);
    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
    }

    const event = req.body;
    const eventType = event.event;

    if (eventType === 'payment.captured') {
      const paymentEntity = event.payload?.payment?.entity;
      if (!paymentEntity) {
        return res.status(200).json({ received: true });
      }

      const razorpayPaymentId = paymentEntity.id;
      const razorpayOrderId   = paymentEntity.order_id;
      const amountInSubunits  = paymentEntity.amount;
      const amount            = amountInSubunits / 100;

      // Idempotency: skip if already recorded
      const existing = await Payment.findOne({ razorpayPaymentId });
      if (existing) {
        return res.status(200).json({ received: true, note: 'Already processed.' });
      }

      // Look up invoice via notes stored when creating the order
      const invoiceId = paymentEntity.notes?.invoiceId;
      if (!invoiceId) {
        return res.status(200).json({ received: true, note: 'No invoiceId in notes, skipped.' });
      }

      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) {
        return res.status(200).json({ received: true, note: 'Invoice not found, skipped.' });
      }

      const payment = await Payment.create({
        hotelId: invoice.hotelId,
        reservationId: invoice.reservationId,
        invoiceId: invoice._id,
        amount,
        currency: paymentEntity.currency || 'USD',
        method: PAYMENT_METHODS.RAZORPAY,
        status: 'captured',
        razorpayOrderId,
        razorpayPaymentId,
        transactionRef: razorpayPaymentId,
        notes: `Webhook: ${eventType}`
      });

      const newPaid    = Math.round((invoice.paidAmount + amount) * 100) / 100;
      const newBalance = Math.max(0, Math.round((invoice.totalAmount - newPaid) * 100) / 100);
      invoice.paidAmount    = newPaid;
      invoice.balanceAmount = newBalance;
      invoice.status        = newBalance === 0 ? INVOICE_STATUS.PAID : INVOICE_STATUS.PARTIALLY_PAID;
      await invoice.save();

      if (invoice.reservationId) {
        await applyPaymentToReservation(invoice.reservationId, amount);
      }

      await logAudit({
        hotelId: invoice.hotelId,
        action: 'WEBHOOK_PAYMENT_CAPTURED',
        entity: 'Payment',
        entityId: payment._id,
        details: { razorpayPaymentId, amount, invoiceId: invoice._id }
      });
    }

    if (eventType === 'payment.failed') {
      const paymentEntity = event.payload?.payment?.entity;
      const invoiceId     = paymentEntity?.notes?.invoiceId;
      if (invoiceId) {
        const invoice = await Invoice.findById(invoiceId);
        if (invoice) {
          await notifyRoles({
            hotelId: invoice.hotelId,
            roles: ['hotel_admin', 'receptionist'],
            title: 'Payment Failed',
            message: `A payment for invoice ${invoice.invoiceNumber} failed.`,
            module: 'payments',
            eventType: 'payment_failed',
            relatedRecordId: invoice._id,
            priority: 'high',
            link: '/billing',
            eventId: `payment-failed:${paymentEntity.id || event.id || invoice._id}`
          });
        }
      }
    }

    // Always return 200 to Razorpay to acknowledge receipt
    return res.status(200).json({ received: true });
  } catch (err) {
    // Still return 200 so Razorpay does not retry indefinitely
    console.error('Webhook processing error:', err.message);
    return res.status(200).json({ received: true, error: 'Processing error logged.' });
  }
};
