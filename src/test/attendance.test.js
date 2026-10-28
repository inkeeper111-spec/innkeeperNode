import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';
import { User, Attendance, AttendanceLocationAudit, Hotel } from '../models/index.js';

const hotelLatitude = 25.7617;
const hotelLongitude = -80.1918;
const validLocation = {
  latitude: hotelLatitude,
  longitude: hotelLongitude,
  accuracyMeters: 8
};

let employeeToken = '';
let adminToken = '';
let guestToken = '';
let guestId = '';
let hotelId = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const employeeLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'reception@grandregal.com', password: 'StaffPassword123!'
  });
  employeeToken = employeeLogin.body.data.accessToken;
  hotelId = employeeLogin.body.data.user.hotelId;

  const adminLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@grandregal.com', password: 'HotelPassword123!'
  });
  adminToken = adminLogin.body.data.accessToken;

  const guest = await User.create({
    name: 'Attendance Test Guest',
    email: 'attendance-guest@example.com',
    password: 'GuestPassword123!',
    role: 'guest',
    hotelId,
    isActive: true
  });
  guestId = guest._id;

  const guestLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'attendance-guest@example.com', password: 'GuestPassword123!'
  });
  guestToken = guestLogin.body.data.accessToken;
});

beforeEach(async () => {
  await Attendance.deleteMany({});
  await AttendanceLocationAudit.deleteMany({});
  await Hotel.updateOne(
    { _id: hotelId },
    { $set: { attendanceLocation: { latitude: hotelLatitude, longitude: hotelLongitude } } }
  );
});

afterAll(async () => { await teardown(); });

describe('Employee attendance punches', () => {
  it('accepts punches within the geofence and prevents duplicate or invalid sequences', async () => {
    const checkIn = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send(validLocation);
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.data.checkInTime).toMatch(/^\d{2}:\d{2}$/);
    expect(checkIn.body.data.checkInAt).toBeTruthy();

    const duplicateCheckIn = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send(validLocation);
    expect(duplicateCheckIn.status).toBe(409);

    const checkOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send(validLocation);
    expect(checkOut.status).toBe(200);
    expect(checkOut.body.data.checkOutAt).toBeTruthy();

    const duplicateCheckOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send(validLocation);
    expect(duplicateCheckOut.status).toBe(409);

    const audits = await AttendanceLocationAudit.find({ userId: checkIn.body.data.userId })
      .sort({ occurredAt: 1, _id: 1 });
    expect(audits).toHaveLength(4);
    expect(audits[0].validationResult).toBe('valid');
    expect(audits[0].attendanceResult).toBe('recorded');
    expect(audits[0].distanceMeters).toBe(0);
    expect(audits[0].accuracyMeters).toBe(validLocation.accuracyMeters);
    expect(audits[1].attendanceResult).toBe('rejected');
  });

  it('rejects locations outside 50 meters, missing coordinates, and inaccurate GPS fixes', async () => {
    const outsideRadius = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send({ ...validLocation, latitude: hotelLatitude + 0.001 });
    expect(outsideRadius.status).toBe(403);
    expect(outsideRadius.body.message).toContain('outside the permitted 50-meter radius');
    expect(outsideRadius.body.data.distanceMeters).toBeGreaterThan(50);

    const inaccurate = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send({ ...validLocation, accuracyMeters: 30 });
    expect(inaccurate.status).toBe(400);
    expect(inaccurate.body.message).toContain('GPS accuracy is too low');

    const missingLocation = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send({});
    expect(missingLocation.status).toBe(400);
    expect(await Attendance.countDocuments({})).toBe(0);

    const rejectedAudits = await AttendanceLocationAudit.find({ attendanceResult: 'rejected' });
    expect(rejectedAudits).toHaveLength(3);
    expect(rejectedAudits.map((audit) => audit.validationResult)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('validates check-out location and requires a check-in first', async () => {
    const checkOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send(validLocation);
    expect(checkOut.status).toBe(400);
    expect(checkOut.body.message).toBe('Check in before checking out.');
    expect((await AttendanceLocationAudit.findOne()).attendanceResult).toBe('rejected');
  });

  it('rejects attendance until a Hotel Admin configures the location', async () => {
    await Hotel.updateOne({ _id: hotelId }, { $set: { attendanceLocation: null } });

    const response = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send(validLocation);

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('has not been configured');
    expect(await Attendance.countDocuments({})).toBe(0);
    const audit = await AttendanceLocationAudit.findOne();
    expect(audit.validationResult).toBe('invalid');
    expect(audit.attendanceResult).toBe('rejected');
  });

  it('uses the latest Hotel Admin-configured location and denies unauthorized location changes', async () => {
    const changedLocation = { latitude: 25.765, longitude: -80.195 };
    const adminUpdate = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ attendanceLocation: changedLocation });
    expect(adminUpdate.status).toBe(200);
    expect(adminUpdate.body.data.attendanceLocation.radiusMeters).toBe(50);
    expect(adminUpdate.body.data.attendanceLocation.maxAccuracyMeters).toBe(25);

    const oldCoordinates = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send({ ...validLocation, hotelId: '000000000000000000000001' });
    expect(oldCoordinates.status).toBe(403);

    const receptionistUpdate = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send({ attendanceLocation: validLocation });
    expect(receptionistUpdate.status).toBe(403);

    const invalidCoordinates = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ attendanceLocation: { latitude: 91, longitude: 0 } });
    expect(invalidCoordinates.status).toBe(400);
  });

  it('preserves optional hotel coordinates across partial settings updates', async () => {
    const settings = {
      name: 'Grand Regal Updated',
      phone: '+1-555-0101',
      address: '100 Updated Avenue',
      city: 'Miami Beach',
      state: 'Florida',
      country: 'United States',
      postalCode: '33139',
      taxNumber: 'US-TAX-UPDATE',
      currency: 'EUR',
      timezone: 'America/New_York',
      checkInTime: '14:30',
      checkOutTime: '10:30',
      cancellationPolicy: 'Refundable up to 48 hours before arrival',
      invoicePrefix: 'GRU'
    };

    for (const [field, value] of Object.entries(settings)) {
      const response = await request(app)
        .put('/api/v1/hotels')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send({ [field]: value });
      expect(response.status).toBe(200);

      const saved = await Hotel.findById(hotelId).lean();
      expect(saved[field]).toBe(value);
      expect(saved.attendanceLocation.latitude).toBe(hotelLatitude);
      expect(saved.attendanceLocation.longitude).toBe(hotelLongitude);
    }

    const combined = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ name: 'Grand Regal Combined', taxNumber: 'US-TAX-COMBINED' });
    expect(combined.status).toBe(200);

    const refreshed = await request(app)
      .get('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.hotel.attendanceLocation.latitude).toBe(hotelLatitude);
    expect(refreshed.body.data.hotel.attendanceLocation.longitude).toBe(hotelLongitude);
  });

  it('allows coordinate-free settings updates and rejects incomplete coordinate pairs', async () => {
    await Hotel.updateOne(
      { _id: hotelId },
      { $set: { attendanceLocation: null } }
    );

    const unrelatedUpdate = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ currency: 'INR', invoicePrefix: 'INC' });
    expect(unrelatedUpdate.status).toBe(200);

    const incompleteLatitude = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ attendanceLocation: { latitude: 25.765 } });
    expect(incompleteLatitude.status).toBe(400);
    expect(incompleteLatitude.body.message).toContain('latitude and longitude');

    const incompleteLongitude = await request(app)
      .put('/api/v1/hotels')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ attendanceLocation: { longitude: -80.195 } });
    expect(incompleteLongitude.status).toBe(400);

    const saved = await Hotel.findById(hotelId).lean();
    expect(saved.currency).toBe('INR');
    expect(saved.invoicePrefix).toBe('INC');
    expect(saved.attendanceLocation).toBeNull();
  });

  it('prevents guests from creating attendance records', async () => {
    const checkIn = await request(app)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', ['Bearer', guestToken].join(' '))
      .send(validLocation);
    const checkOut = await request(app)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', ['Bearer', guestToken].join(' '))
      .send(validLocation);

    expect(checkIn.status).toBe(403);
    expect(checkOut.status).toBe(403);
    expect(await Attendance.countDocuments({ userId: guestId })).toBe(0);
  });

  it('prevents non-admin employees from manually creating attendance records', async () => {
    const response = await request(app)
      .post('/api/v1/staff/attendance')
      .set('Authorization', ['Bearer', employeeToken].join(' '))
      .send({ userId: guestId, date: new Date().toISOString() });

    expect(response.status).toBe(403);
  });
});
