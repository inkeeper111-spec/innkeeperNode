import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

let adminToken = '';
let roomTypeId = '';
let roomId     = '';

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

// ─── Room Types ───────────────────────────────────────────────────────────────
describe('GET /api/v1/room-types', () => {
  it('should return room types for the hotel', async () => {
    const res = await request(app)
      .get('/api/v1/room-types')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    roomTypeId = res.body.data[0]._id;
  });
});

describe('POST /api/v1/room-types', () => {
  it('should create a new room type', async () => {
    const res = await request(app)
      .post('/api/v1/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name:             'API Test Suite',
        code:             'ATS',
        description:      'Room type for automated test',
        maxOccupancy:     2,
        adultCapacity:    2,
        childCapacity:    0,
        bedConfiguration: '1 King Bed',
        basePrice:        199,
        amenities:        ['Wi-Fi', 'Smart TV']
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('API Test Suite');
    expect(res.body.data.basePrice).toBe(199);
  });

  it('should reject duplicate room type code', async () => {
    await request(app)
      .post('/api/v1/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Dup Code', code: 'ATS', basePrice: 100, maxOccupancy: 2, bedConfiguration: '1 Bed' });

    const res = await request(app)
      .post('/api/v1/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Dup Code 2', code: 'ATS', basePrice: 100, maxOccupancy: 2, bedConfiguration: '1 Bed' });

    expect(res.status).toBe(409);
  });
});

// ─── Rooms ────────────────────────────────────────────────────────────────────
describe('GET /api/v1/rooms', () => {
  it('should return all rooms for the hotel', async () => {
    const res = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    roomId = res.body.data[0]._id;
  });
});

describe('POST /api/v1/rooms', () => {
  it('should create a new room', async () => {
    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roomNumber: '999', roomTypeId, floor: '9' });
    expect(res.status).toBe(201);
    expect(res.body.data.roomNumber).toBe('999');
    expect(res.body.data.roomStatus).toBe('available');
  });

  it('should reject duplicate room number in same property', async () => {
    await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roomNumber: '998', roomTypeId, floor: '9' });

    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roomNumber: '998', roomTypeId, floor: '9' });

    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/v1/rooms/:id/status', () => {
  it('should update room housekeeping status', async () => {
    if (!roomId) return;
    const res = await request(app)
      .patch(`/api/v1/rooms/${roomId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ housekeepingStatus: 'dirty' });
    expect(res.status).toBe(200);
    expect(res.body.data.housekeepingStatus).toBe('dirty');
  });

  it('should update room operational status', async () => {
    if (!roomId) return;
    const res = await request(app)
      .patch(`/api/v1/rooms/${roomId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roomStatus: 'out_of_service' });
    expect(res.status).toBe(200);
    expect(res.body.data.roomStatus).toBe('out_of_service');
  });
});
