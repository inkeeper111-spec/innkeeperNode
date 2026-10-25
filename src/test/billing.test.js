import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

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
