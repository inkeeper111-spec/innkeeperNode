import { Invoice, Payment, Reservation, Refund } from '../models/index.js';
import { INVOICE_STATUS, PAYMENT_STATUS, PAYMENT_METHODS } from '../config/constants.js';
import { createRazorpayOrder, verifyRazorpayPayment, verifyWebhookSignature, processRazorpayRefund } from '../services/razorpayService.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyRoles } from '../services/notificationService.js';

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
      const reservation = await Reservation.findById(invoice.reservationId);
      if (reservation) {
        reservation.paidAmount = Math.round((reservation.paidAmount + payAmount) * 100) / 100;
        reservation.balanceAmount = Math.max(0, Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100);
        reservation.paymentStatus = reservation.balanceAmount === 0 ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.PARTIALLY_PAID;
        await reservation.save();
      }
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

    res.json({
      success: true,
      data: {
        payments,
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
      currency: 'USD',
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
      const reservation = await Reservation.findById(invoice.reservationId);
      if (reservation) {
        reservation.paidAmount = Math.round((reservation.paidAmount + payAmount) * 100) / 100;
        reservation.balanceAmount = Math.max(0, Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100);
        reservation.paymentStatus = reservation.balanceAmount === 0 ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.PARTIALLY_PAID;
        await reservation.save();
      }
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
  try {
    const { paymentId, amount, reason } = req.body;
    const payment = await Payment.findOne({ _id: paymentId, hotelId: req.hotelId });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }

    const refundAmount = Number(amount || payment.amount);
    let razorpayRefund = null;

    if (payment.method === PAYMENT_METHODS.RAZORPAY && payment.razorpayPaymentId) {
      razorpayRefund = await processRazorpayRefund({
        paymentId: payment.razorpayPaymentId,
        amount: refundAmount,
        notes: { reason }
      });
    }

    const refund = await Refund.create({
      hotelId: req.hotelId,
      paymentId: payment._id,
      invoiceId: payment.invoiceId,
      reservationId: payment.reservationId,
      amount: refundAmount,
      reason,
      razorpayRefundId: razorpayRefund?.id,
      status: 'processed',
      processedBy: req.user._id
    });

    payment.status = 'refunded';
    await payment.save();

    // Adjust Invoice
    if (payment.invoiceId) {
      const invoice = await Invoice.findById(payment.invoiceId);
      if (invoice) {
        invoice.paidAmount = Math.max(0, invoice.paidAmount - refundAmount);
        invoice.balanceAmount = Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100;
        invoice.status = INVOICE_STATUS.REFUNDED;
        await invoice.save();
      }
    }

    res.json({
      success: true,
      message: 'Refund processed successfully.',
      data: refund
    });
  } catch (err) {
    next(err);
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
        const reservation = await Reservation.findById(invoice.reservationId);
        if (reservation) {
          reservation.paidAmount    = Math.round((reservation.paidAmount + amount) * 100) / 100;
          reservation.balanceAmount = Math.max(0, Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100);
          reservation.paymentStatus = reservation.balanceAmount === 0
            ? PAYMENT_STATUS.PAID
            : PAYMENT_STATUS.PARTIALLY_PAID;
          await reservation.save();
        }
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
