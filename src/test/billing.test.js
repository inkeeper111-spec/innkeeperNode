import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';
import { Invoice, Payment, Refund, Reservation, Room, User } from '../models/index.js';

let adminToken = '';
let invoiceId  = '';
let paymentId  = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email:    'admin@grandregal.com',
    password: 'HotelPassword123!'
  });
  adminToken = loginRes.body.data.accessToken;
});

afterAll(async () => { await teardown(); });

// ─── Invoices ─────────────────────────────────────────────────────────────────
describe('GET /api/v1/billing/invoices', () => {
  it('should return invoice list for the hotel', async () => {
    const res = await request(app)
      .get('/api/v1/billing/invoices')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.invoices)).toBe(true);

    if (res.body.data.invoices.length > 0) {
      invoiceId = res.body.data.invoices[0]._id;
    }
  });

  it('should filter invoices by status', async () => {
    const res = await request(app)
      .get('/api/v1/billing/invoices?status=paid')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    res.body.data.invoices.forEach((inv) => {
      expect(inv.status).toBe('paid');
    });
  });
});

describe('GET /api/v1/billing/invoices/:id', () => {
  it('should return invoice details with payments', async () => {
    if (!invoiceId) return;
    const res = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toHaveProperty('items');
    expect(Array.isArray(res.body.data.payments)).toBe(true);
  });

  it('should return 404 for non-existent invoice', async () => {
    const res = await request(app)
      .get('/api/v1/billing/invoices/000000000000000000000001')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// ─── Record Payment ───────────────────────────────────────────────────────────
describe('POST /api/v1/billing/invoices/record-payment', () => {
  it('marks a confirmed reservation checked in after full payment', async () => {
    const source = await Reservation.findOne({ status: 'confirmed' });
    if (!source) return;
    const room = await Room.findOne({
      _id: source.rooms[0]?.roomId,
      hotelId: source.hotelId
    });
    if (!room) return;

    const total = 250;
    const reservation = await Reservation.create({
      hotelId: source.hotelId,
      propertyId: source.propertyId,
      bookingReference: `PAY-CHECKIN-${Date.now()}`,
      guestId: source.guestId,
      guestName: 'Paid Reservation Guest',
      guestEmail: 'paid.checkin@example.com',
      guestPhone: '+1 - 5551234567',
      checkInDate: new Date(),
      checkOutDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      rooms: [{
        roomId: room._id,
        roomTypeId: room.roomTypeId,
        roomNumber: room.roomNumber,
        ratePerNight: total
      }],
      status: 'confirmed',
      paymentStatus: 'unpaid',
      subtotal: total,
      totalAmount: total,
      balanceAmount: total
    });
    const invoice = await Invoice.create({
      hotelId: source.hotelId,
      propertyId: source.propertyId,
      invoiceNumber: `PAY-CHECKIN-${Date.now()}`,
      reservationId: reservation._id,
      guestId: source.guestId,
      items: [{ description: 'Test reservation', quantity: 1, unitPrice: total, amount: total }],
      subtotal: total,
      totalAmount: total,
      balanceAmount: total
    });

    const payment = await request(app)
      .post('/api/v1/billing/invoices/record-payment')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ invoiceId: invoice._id, amount: total, method: 'cash' });

    expect(payment.status).toBe(201);
    const updatedReservation = await Reservation.findById(reservation._id);
    expect(updatedReservation.paymentStatus).toBe('paid');
    expect(updatedReservation.status).toBe('checked_in');
    expect(updatedReservation.checkedInAt).toBeTruthy();
    expect(String(updatedReservation.checkedInBy)).toBe(payment.body.data.payment.recordedBy);
    expect((await Room.findById(room._id)).roomStatus).toBe('occupied');
  });

  it('should record a cash payment against an unpaid invoice', async () => {
    // Find an unpaid/partially-paid invoice
    const invRes = await request(app)
      .get('/api/v1/billing/invoices?status=partially_paid')
      .set('Authorization', `Bearer ${adminToken}`);

    const unpaid = invRes.body.data?.invoices?.find((i) => i.balanceAmount > 0);
    if (!unpaid) return; // nothing unpaid in seeded data — skip

    const res = await request(app)
      .post('/api/v1/billing/invoices/record-payment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        invoiceId: unpaid._id,
        amount:    50,
        method:    'cash',
        notes:     'Test partial payment'
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payment.amount).toBe(50);
    expect(res.body.data.payment.method).toBe('cash');
    paymentId = res.body.data.payment._id;

    // Verify invoice balance was reduced
    expect(res.body.data.invoice.paidAmount).toBeGreaterThan(0);
  });

  it('should reject payment with amount <= 0', async () => {
    if (!invoiceId) return;
    const res = await request(app)
      .post('/api/v1/billing/invoices/record-payment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ invoiceId, amount: -10, method: 'cash' });
    expect(res.status).toBe(400);
  });

  it('should reject payment against non-existent invoice', async () => {
    const res = await request(app)
      .post('/api/v1/billing/invoices/record-payment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ invoiceId: '000000000000000000000001', amount: 100, method: 'cash' });
    expect(res.status).toBe(404);
  });
});

// ─── Razorpay Order Creation ──────────────────────────────────────────────────
describe('POST /api/v1/billing/payments/create-order', () => {
  it('should create a Razorpay order for an invoice', async () => {
    if (!invoiceId) return;
    const res = await request(app)
      .post('/api/v1/billing/payments/create-order')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ invoiceId, amount: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.order).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('keyId');
  });
});

// ─── Get Payments ─────────────────────────────────────────────────────────────
describe('GET /api/v1/billing/payments', () => {
  it('should return payment transaction list', async () => {
    const res = await request(app)
      .get('/api/v1/billing/payments')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.payments)).toBe(true);
  });
});

describe('POST /api/v1/billing/payments/refund', () => {
  const createRefundablePayment = async () => {
    const sourceInvoice = await Invoice.findOne();
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const invoice = await Invoice.create({
      hotelId: sourceInvoice.hotelId,
      propertyId: sourceInvoice.propertyId,
      invoiceNumber: `REFUND-${uniqueId}`,
      guestId: sourceInvoice.guestId,
      items: [{ description: 'Refund test item', quantity: 1, unitPrice: 100, amount: 100 }],
      subtotal: 100,
      totalAmount: 100,
      paidAmount: 100,
      balanceAmount: 0,
      status: 'paid'
    });
    const user = await User.findOne({ hotelId: invoice.hotelId });
    const payment = await Payment.create({
      hotelId: invoice.hotelId,
      invoiceId: invoice._id,
      amount: 100,
      method: 'cash',
      status: 'captured',
      transactionRef: `REFUND-TXN-${uniqueId}`,
      recordedBy: user._id
    });
    return { invoice, payment };
  };

  it('records partial refunds, caps the remaining refund, and updates payment and invoice balances', async () => {
    const { invoice, payment } = await createRefundablePayment();
    const partialRefund = await request(app)
      .post('/api/v1/billing/payments/refund')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentId: payment._id, amount: 30, reason: 'Guest changed plans' });

    expect(partialRefund.status).toBe(200);
    expect(partialRefund.body.data.refund.amount).toBe(30);
    expect(partialRefund.body.data.payment.status).toBe('captured');
    expect(partialRefund.body.data.invoice.paidAmount).toBe(70);
    expect(partialRefund.body.data.invoice.balanceAmount).toBe(30);
    expect(partialRefund.body.data.invoice.status).toBe('partially_paid');

    const overRefund = await request(app)
      .post('/api/v1/billing/payments/refund')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentId: payment._id, amount: 70.01, reason: 'Refund remaining amount' });
    expect(overRefund.status).toBe(409);

    const finalRefund = await request(app)
      .post('/api/v1/billing/payments/refund')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentId: payment._id, amount: 70, reason: 'Refund remaining amount' });

    expect(finalRefund.status).toBe(200);
    expect(finalRefund.body.data.payment.status).toBe('refunded');
    expect(finalRefund.body.data.invoice.paidAmount).toBe(0);
    expect(finalRefund.body.data.invoice.balanceAmount).toBe(100);
    expect(finalRefund.body.data.invoice.status).toBe('refunded');

    const listedPayments = await request(app)
      .get('/api/v1/billing/payments')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const listed = listedPayments.body.data.payments.find((entry) => entry._id === String(payment._id));
    expect(listed.refundedAmount).toBe(100);
    expect(listed.refundableAmount).toBe(0);
    expect(await Refund.countDocuments({ paymentId: payment._id })).toBe(2);
  });

  it('requires a valid amount and a reason', async () => {
    const { payment } = await createRefundablePayment();
    for (const payload of [
      { paymentId: payment._id, amount: 0, reason: 'Invalid amount' },
      { paymentId: payment._id, amount: 1.001, reason: 'Fractional cents' },
      { paymentId: payment._id, amount: 1, reason: '   ' },
      { paymentId: payment._id, amount: 1 }
    ]) {
      const response = await request(app)
        .post('/api/v1/billing/payments/refund')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send(payload);
      expect(response.status).toBe(400);
    }
  });

  it('records a Razorpay-method refund without making an external gateway refund', async () => {
    const { payment } = await createRefundablePayment();
    payment.method = 'razorpay';
    payment.razorpayPaymentId = 'pay_manual_refund_test';
    await payment.save();

    const response = await request(app)
      .post('/api/v1/billing/payments/refund')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentId: payment._id, amount: 25, reason: 'Manual refund recorded' });

    expect(response.status).toBe(200);
    expect(response.body.data.refund.razorpayRefundId).toBeUndefined();
    expect(response.body.data.payment.status).toBe('captured');
  });
});

// ─── Tenant Isolation ─────────────────────────────────────────────────────────
describe('Cross-tenant data access prevention', () => {
  let otherToken = '';

  beforeAll(async () => {
    // Register a second hotel
    const regRes = await request(app).post('/api/v1/auth/register').send({
      hotelName: 'Other Hotel LLC',
      name:      'Other Admin',
      email:     'other.admin@otherhotel.test',
      password:  'OtherPass123!',
      phone:     '+1 555 000 9999',
      address:   '99 Other St',
      city:      'OtherCity',
      state:     'OC',
      country:   'Testland',
      postalCode:'99999'
    });
    otherToken = regRes.body.data?.accessToken || '';
  });

  it('should not return hotel-A invoices to hotel-B user', async () => {
    if (!invoiceId || !otherToken) return;

    // Hotel-B user tries to access hotel-A invoice directly
    const res = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    // Must either 404 (not in their tenant) or 403 (pending approval)
    expect([403, 404]).toContain(res.status);
  });

  it('should not list hotel-A invoices for hotel-B user', async () => {
    if (!otherToken) return;
    const res = await request(app)
      .get('/api/v1/billing/invoices')
      .set('Authorization', `Bearer ${otherToken}`);

    // Hotel B is pending_approval — forbidden, OR returns empty list for their own tenant
    if (res.status === 200) {
      // If they somehow pass the approval check, they must see zero invoices
      expect(res.body.data.invoices.length).toBe(0);
    } else {
      expect([403]).toContain(res.status);
    }
  });
});
