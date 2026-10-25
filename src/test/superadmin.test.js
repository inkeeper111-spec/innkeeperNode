import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

let superToken  = '';
let adminToken  = '';
let hotelId     = '';
let planId      = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  // Login as super admin
  const superRes = await request(app).post('/api/v1/auth/login').send({
    email: 'superadmin@grandstayhms.com', password: 'AdminPassword123!'
  });
  superToken = superRes.body.data.accessToken;

  // Login as hotel admin (to test role enforcement)
  const adminRes = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@grandregal.com', password: 'HotelPassword123!'
  });
  adminToken = adminRes.body.data.accessToken;
  hotelId    = adminRes.body.data.user.hotelId;
});

afterAll(async () => { await teardown(); });

// ─── Platform Stats ───────────────────────────────────────────────────────────
describe('GET /api/v1/superadmin/stats', () => {
  it('should return platform statistics for super admin', async () => {
    const res = await request(app)
      .get('/api/v1/superadmin/stats')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalHotels');
    expect(res.body.data).toHaveProperty('totalUsers');
    expect(res.body.data).toHaveProperty('platformRevenue');
    expect(res.body.data.totalHotels).toBeGreaterThan(0);
  });

  it('should deny hotel admin access to superadmin stats', async () => {
    const res = await request(app)
      .get('/api/v1/superadmin/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('should deny unauthenticated access', async () => {
    const res = await request(app).get('/api/v1/superadmin/stats');
    expect(res.status).toBe(401);
  });
});

// ─── Hotel Management ─────────────────────────────────────────────────────────
describe('GET /api/v1/superadmin/hotels', () => {
  it('should return paginated hotel list', async () => {
    const res = await request(app)
      .get('/api/v1/superadmin/hotels?page=1&limit=5')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.hotels)).toBe(true);
    expect(res.body.data).toHaveProperty('pagination');
  });

  it('should filter by status', async () => {
    const res = await request(app)
      .get('/api/v1/superadmin/hotels?status=active')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    res.body.data.hotels.forEach((h) => {
      expect(h.status).toBe('active');
    });
  });
});

describe('PATCH /api/v1/superadmin/hotels/:id/status', () => {
  it('should approve (activate) a pending hotel', async () => {
    // Register a new hotel to have pending status
    const regRes = await request(app).post('/api/v1/auth/register').send({
      hotelName: 'Pending Approval Hotel',
      name:      'Pending Owner',
      email:     'pending.owner@pendinghotel.test',
      password:  'Pending123!',
      phone:     '+1 555 333 4444',
      address:   '1 Pending Ave',
      city:      'Pending City',
      state:     'PC',
      country:   'Testland',
      postalCode:'11111'
    });
    const pendingHotelId = regRes.body.data.hotel.id;

    const res = await request(app)
      .patch(`/api/v1/superadmin/hotels/${pendingHotelId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
  });

  it('should reject hotel with reason', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      hotelName: 'Hotel To Reject',
      name:      'Reject Owner',
      email:     'reject.owner@rejecthotel.test',
      password:  'Reject123!',
      phone:     '+1 555 444 5555',
      address:   '2 Reject Lane',
      city:      'Reject City',
      state:     'RC',
      country:   'Testland',
      postalCode:'22222'
    });
    const rejectHotelId = regRes.body.data.hotel.id;

    const res = await request(app)
      .patch(`/api/v1/superadmin/hotels/${rejectHotelId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ status: 'rejected', rejectionReason: 'Incomplete documentation.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
  });

  it('should reject invalid status value', async () => {
    const res = await request(app)
      .patch(`/api/v1/superadmin/hotels/${hotelId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ status: 'invalid_status_xyz' });
    expect(res.status).toBe(400);
  });
});

// ─── Subscription Plans ───────────────────────────────────────────────────────
describe('GET /api/v1/superadmin/plans', () => {
  it('should return all subscription plans', async () => {
    const res = await request(app)
      .get('/api/v1/superadmin/plans')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    planId = res.body.data[0]._id;
  });
});

describe('POST /api/v1/superadmin/plans', () => {
  it('should create a new subscription plan', async () => {
    const res = await request(app)
      .post('/api/v1/superadmin/plans')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        name:          'Enterprise Test',
        code:          'enterprise_test',
        description:   'Enterprise plan for testing',
        monthlyPrice:  299,
        annualPrice:   2990,
        maxRooms:      500,
        maxUsers:      100,
        maxProperties: 10,
        enabledModules:['rooms','reservations','billing'],
        aiUsageAllowance: 5005,
        supportLevel:  'dedicated_24_7'
      });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('enterprise_test');
  });

  it('should reject duplicate plan code', async () => {
    await request(app)
      .post('/api/v1/superadmin/plans')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Dup', code: 'enterprise_test', monthlyPrice: 1, maxRooms: 1, maxUsers: 1 });

    const res = await request(app)
      .post('/api/v1/superadmin/plans')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Dup2', code: 'enterprise_test', monthlyPrice: 1, maxRooms: 1, maxUsers: 1 });

    expect(res.status).toBe(409);
  });
});

describe('PUT /api/v1/superadmin/plans/:id', () => {
  it('should update an existing plan', async () => {
    if (!planId) return;
    const res = await request(app)
      .put(`/api/v1/superadmin/plans/${planId}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ monthlyPrice: 59, supportLevel: 'priority' });
    expect(res.status).toBe(200);
    expect(res.body.data.monthlyPrice).toBe(59);
  });
});

// ─── Audit Logs ───────────────────────────────────────────────────────────────
describe('GET /api/v1/superadmin/audit-logs', () => {
  it('should return paginated audit logs', async () => {
    const res = await request(app)
      .get('/api/v1/superadmin/audit-logs?page=1&limit=10')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.logs)).toBe(true);
    expect(res.body.data).toHaveProperty('pagination');
  });
});
