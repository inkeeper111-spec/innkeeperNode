import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';
import { User, Attendance } from '../models/index.js';

let employeeToken = '';
let guestToken = '';
let guestId = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const employeeLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'reception@grandregal.com', password: 'StaffPassword123!'
  });
  employeeToken = employeeLogin.body.data.accessToken;

  const guest = await User.create({
    name: 'Attendance Test Guest',
    email: 'attendance-guest@example.com',
    password: 'GuestPassword123!',
    role: 'guest',
    hotelId: employeeLogin.body.data.user.hotelId,
    isActive: true
  });
  guestId = guest._id;

  const guestLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'attendance-guest@example.com', password: 'GuestPassword123!'
  });
  guestToken = guestLogin.body.data.accessToken;
});

afterAll(async () => { await teardown(); });

describe('Employee attendance punches', () => {
  it('rejects duplicate check-ins and check-outs without overwriting records', async () => {
    const checkIn = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.data.checkInTime).toMatch(/^\d{2}:\d{2}$/);
    expect(checkIn.body.data.checkInAt).toBeTruthy();

    const duplicateCheckIn = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(duplicateCheckIn.status).toBe(409);

    const checkOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(checkOut.status).toBe(200);
    expect(checkOut.body.data.checkOutAt).toBeTruthy();
    const firstCheckOutTime = checkOut.body.data.checkOutTime;

    const duplicateCheckOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(duplicateCheckOut.status).toBe(409);
    expect(duplicateCheckOut.body.data.checkOutTime).toBe(firstCheckOutTime);
  });

  it('prevents guests from creating attendance records', async () => {
    const checkIn = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${guestToken}`);
    const checkOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', `Bearer ${guestToken}`);

    expect(checkIn.status).toBe(403);
    expect(checkOut.status).toBe(403);
    expect(await Attendance.countDocuments({ userId: guestId })).toBe(0);
  });

  it('prevents non-admin employees from manually creating attendance records', async () => {
    const response = await request(app)
      .post('/api/v1/staff/attendance')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ userId: guestId, date: new Date().toISOString() });

    expect(response.status).toBe(403);
  });
});