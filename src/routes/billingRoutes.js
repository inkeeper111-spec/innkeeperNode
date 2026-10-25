import { Router } from 'express';
import express from 'express';
import {
  getInvoices,
  getInvoiceById,
  recordPayment,
  getPayments,
  createPaymentOrder,
  verifyPayment,
  refundPayment,
  razorpayWebhook
} from '../controllers/billingController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

// ── Razorpay webhook — unauthenticated, raw body required for HMAC verification ──
router.post(
  '/payments/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    // Expose the raw buffer as a string for the signature check
    req.rawBody = req.body.toString('utf8');
    // Re-parse so controllers can read req.body as JSON
    try { req.body = JSON.parse(req.rawBody); } catch (e) { /* ignore */ }
    next();
  },
  razorpayWebhook
);

// ── All routes below require authentication ──
router.use(authenticate);
router.use(requireTenant);

router.get('/invoices', getInvoices);
router.get('/invoices/:id', getInvoiceById);
router.post('/invoices/record-payment', recordPayment);

router.get('/payments', getPayments);
router.post('/payments/create-order', createPaymentOrder);
router.post('/payments/verify', verifyPayment);
router.post('/payments/refund', refundPayment);

export default router;

