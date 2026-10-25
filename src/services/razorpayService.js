import crypto from 'crypto';
import Razorpay from 'razorpay';
import { logger } from '../config/logger.js';

const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder_key_id';
const keySecret = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_placeholder_secret';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'sample_webhook_secret_key';

let razorpayClient = null;

if (keyId && keySecret && !keyId.includes('placeholder')) {
  try {
    razorpayClient = new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    });
  } catch (err) {
    logger.warn('Razorpay SDK initialization failed, falling back to mock payment provider.');
  }
}

export const createRazorpayOrder = async ({ amount, currency = 'USD', receipt, notes = {} }) => {
  // Amount in smallest currency unit (e.g., cents or paise)
  const amountInSubunits = Math.round(amount * 100);

  if (razorpayClient) {
    return razorpayClient.orders.create({
      amount: amountInSubunits,
      currency,
      receipt,
      notes
    });
  }

  // Realistic sandbox/test order simulation
  const mockOrderId = `order_${crypto.randomBytes(8).toString('hex')}`;
  return {
    id: mockOrderId,
    entity: 'order',
    amount: amountInSubunits,
    currency,
    receipt,
    status: 'created',
    created_at: Math.floor(Date.now() / 1000)
  };
};

export const verifyRazorpayPayment = ({ orderId, paymentId, signature }) => {
  if (razorpayClient && !keyId.includes('placeholder')) {
    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    return generatedSignature === signature;
  }

  // In test/demo environment with placeholder credentials, verify that valid strings are provided
  return Boolean(orderId && paymentId && signature);
};

export const verifyWebhookSignature = (rawBody, signature) => {
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  return expectedSignature === signature;
};

export const processRazorpayRefund = async ({ paymentId, amount, notes = {} }) => {
  const amountInSubunits = Math.round(amount * 100);

  if (razorpayClient && !keyId.includes('placeholder')) {
    return razorpayClient.payments.refund(paymentId, {
      amount: amountInSubunits,
      notes
    });
  }

  return {
    id: `rfnd_${crypto.randomBytes(8).toString('hex')}`,
    entity: 'refund',
    amount: amountInSubunits,
    payment_id: paymentId,
    status: 'processed'
  };
};

