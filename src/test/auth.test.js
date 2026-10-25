import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';

beforeAll(async () => { await setup(); });
afterAll(async ()  => { await teardown(); });

// ─── Helper ───────────────────────────────────────────────────────────────────
const HOTEL_PAYLOAD = {
  hotelName: 'Test Grand Hotel',
  name:      'Test Admin',
  email:     'testadmin@grandtest.com',
  password:  'TestPassword123!',
  phone:     '+1 555 000 0001',
  address:   '1 Test Street',
  city:      'TestCity',
  state:     'TC',
  country:   'Testland',
  postalCode:'00001',
  currency:  'USD'
};

// ─── Registration ─────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/register', () => {
  it('should register a new hotel and return tokens', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(HOTEL_PAYLOAD);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.role).toBe('hotel_admin');
    expect(res.body.data.hotel.status).toBe('pending_approval');
  });

  it('should reject duplicate email registration', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(HOTEL_PAYLOAD);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/login', () => {
  it('should login with valid credentials and return tokens', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    HOTEL_PAYLOAD.email,
      password: HOTEL_PAYLOAD.password
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
  });

  it('should reject invalid password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    HOTEL_PAYLOAD.email,
      password: 'WrongPassword!'
    });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('should reject non-existent email', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    'nobody@nowhere.com',
      password: 'Any1234!'
    });
    expect(res.status).toBe(401);
  });
});

// ─── GET /me ──────────────────────────────────────────────────────────────────
describe('GET /api/v1/auth/me', () => {
  let accessToken = '';

  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email:    HOTEL_PAYLOAD.email,
      password: HOTEL_PAYLOAD.password
    });
    accessToken = res.body.data.accessToken;
  });

  it('should return current user when authenticated', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(HOTEL_PAYLOAD.email);
  });

  it('should reject request without token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});

// ─── Token Refresh ────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/refresh', () => {
  it('should return new tokens with valid refresh token', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email:    HOTEL_PAYLOAD.email,
      password: HOTEL_PAYLOAD.password
    });
    const { refreshToken } = loginRes.body.data;

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
  });

  it('should reject an invalid refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'bad.token.here' });
    expect(res.status).toBe(401);
  });
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────
describe('POST /api/v1/auth/forgot-password', () => {
  it('should return 200 even for unknown email (anti-enumeration)', async () => {
    const res = await request(app).post('/api/v1/auth/forgot-password').send({
      email: 'unknown@example.com'
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should return a devResetToken in non-production mode', async () => {
    const res = await request(app).post('/api/v1/auth/forgot-password').send({
      email: HOTEL_PAYLOAD.email
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('devResetToken');
  });
});
