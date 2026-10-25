import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

let adminToken  = '';
let roomId      = '';
let taskId      = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@grandregal.com', password: 'HotelPassword123!'
  });
  adminToken = loginRes.body.data.accessToken;

  // Get a room to use in tasks
  const roomsRes = await request(app)
    .get('/api/v1/rooms')
    .set('Authorization', `Bearer ${adminToken}`);
  if (roomsRes.body.data?.length > 0) {
    roomId = roomsRes.body.data[0]._id;
  }
});

afterAll(async () => { await teardown(); });

describe('GET /api/v1/housekeeping/tasks', () => {
  it('should return housekeeping tasks', async () => {
    const res = await request(app)
      .get('/api/v1/housekeeping/tasks')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/v1/housekeeping/tasks', () => {
  it('should create a cleaning task', async () => {
    if (!roomId) return;
    const res = await request(app)
      .post('/api/v1/housekeeping/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roomId, priority: 'high', taskType: 'checkout_cleaning', notes: 'Test task' });
    expect(res.status).toBe(201);
    expect(res.body.data.priority).toBe('high');
    taskId = res.body.data._id;
  });
});

describe('PATCH /api/v1/housekeeping/tasks/:id/status', () => {
  it('should transition task dirty → cleaning_in_progress', async () => {
    if (!taskId) return;
    const res = await request(app)
      .patch(`/api/v1/housekeeping/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cleaning_in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cleaning_in_progress');
  });

  it('should transition task cleaning_in_progress → clean', async () => {
    if (!taskId) return;
    const res = await request(app)
      .patch(`/api/v1/housekeeping/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'clean' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('clean');
  });

  it('should transition task clean → inspected', async () => {
    if (!taskId) return;
    const res = await request(app)
      .patch(`/api/v1/housekeeping/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'inspected' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('inspected');
  });
});

describe('POST /api/v1/housekeeping/tasks/:id/report-damage', () => {
  it('should report damage and create a maintenance ticket', async () => {
    if (!taskId) return;
    const res = await request(app)
      .post(`/api/v1/housekeeping/tasks/${taskId}/report-damage`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        damageDescription:       'Broken mirror in bathroom',
        createMaintenanceTicket: true,
        priority:                'high'
      });
    expect(res.status).toBe(200);
    expect(res.body.data.task.damageReported).toBe(true);
    expect(res.body.data.ticket).not.toBeNull();
    expect(res.body.data.ticket.priority).toBe('high');
  });
});
