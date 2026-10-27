import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

let adminToken  = '';
let receptionistToken = '';
let restaurantToken = '';
let hotelId     = '';
let roomId      = '';
let roomTypeId  = '';
let reservationId = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  // Login as hotel admin
  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email:    'admin@grandregal.com',
    password: 'HotelPassword123!'
  });
  adminToken = loginRes.body.data.accessToken;
  hotelId    = loginRes.body.data.user.hotelId;

  const receptionistLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'reception@grandregal.com',
    password: 'StaffPassword123!'
  });
  receptionistToken = receptionistLogin.body.data.accessToken;

  const restaurantLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'chef@grandregal.com',
    password: 'StaffPassword123!'
  });
  restaurantToken = restaurantLogin.body.data.accessToken;

  // Get an available room
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 5);
  const dayAfter  = new Date(); dayAfter.setDate(dayAfter.getDate() + 7);
  const roomsRes = await request(app)
    .get(`/api/v1/rooms/availability?checkInDate=${tomorrow.toISOString().slice(0,10)}&checkOutDate=${dayAfter.toISOString().slice(0,10)}`)
    .set('Authorization', `Bearer ${adminToken}`);

  const availableRooms = roomsRes.body.data?.rooms || [];
  if (availableRooms.length > 0) {
    roomId     = availableRooms[0]._id;
    roomTypeId = availableRooms[0].roomTypeId?._id || availableRooms[0].roomTypeId;
  }
});

afterAll(async () => { await teardown(); });

// ─── Room Availability ────────────────────────────────────────────────────────
describe('GET /api/v1/rooms/availability', () => {
  it('should return available rooms for valid dates', async () => {
    const ci = new Date(); ci.setDate(ci.getDate() + 10);
    const co = new Date(); co.setDate(co.getDate() + 12);
    const res = await request(app)
      .get(`/api/v1/rooms/availability?checkInDate=${ci.toISOString().slice(0,10)}&checkOutDate=${co.toISOString().slice(0,10)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.rooms)).toBe(true);
  });

  it('should reject missing date parameters', async () => {
    const res = await request(app)
      .get('/api/v1/rooms/availability')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('should reject check-out before check-in', async () => {
    const res = await request(app)
      .get('/api/v1/rooms/availability?checkInDate=2030-12-10&checkOutDate=2030-12-09')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// ─── Create Reservation ───────────────────────────────────────────────────────
describe('POST /api/v1/reservations', () => {
  it('should create a reservation with valid data', async () => {
    if (!roomId || !roomTypeId) return; // skip if no room available in seeded data

    const ci = new Date(); ci.setDate(ci.getDate() + 5);
    const co = new Date(); co.setDate(co.getDate() + 7);

    const res = await request(app)
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        guestData: {
          name:  'Test Guest API',
          phone: '+1 555 999 0001',
          email: 'testguest.api@example.com'
        },
        checkInDate:  ci.toISOString().slice(0, 10),
        checkOutDate: co.toISOString().slice(0, 10),
        rooms: [{ roomId, roomTypeId }],
        adultsCount: 2,
        bookingSource: 'manual'
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reservation).toHaveProperty('bookingReference');
    expect(res.body.data.invoice).toHaveProperty('invoiceNumber');
    reservationId = res.body.data.reservation._id;
  });

  it('should reject reservation with past check-out date', async () => {
    const res = await request(app)
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        guestData:    { name: 'Bad Guest', phone: '0000000000', email: 'bad@test.com' },
        checkInDate:  '2020-01-01',
        checkOutDate: '2020-01-01',
        rooms: [{ roomId: roomId || '000000000000000000000001', roomTypeId: roomTypeId || '000000000000000000000001' }]
      });
    expect(res.status).toBe(400);
  });

  it('should reject reservation without rooms array', async () => {
    const ci = new Date(); ci.setDate(ci.getDate() + 20);
    const co = new Date(); co.setDate(co.getDate() + 22);
    const res = await request(app)
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        guestData:    { name: 'No Room Guest', phone: '0000000001', email: 'noroom@test.com' },
        checkInDate:  ci.toISOString().slice(0, 10),
        checkOutDate: co.toISOString().slice(0, 10),
        rooms: []
      });
    expect(res.status).toBe(400);
  });
});

// ─── Double-Booking Prevention ────────────────────────────────────────────────
describe('Double-booking prevention', () => {
  it('should reject overlapping reservation on same room', async () => {
    if (!roomId || !roomTypeId || !reservationId) return;

    // Attempt booking on same room, same dates (overlap)
    const ci = new Date(); ci.setDate(ci.getDate() + 5);
    const co = new Date(); co.setDate(co.getDate() + 7);

    const res = await request(app)
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        guestData:    { name: 'Overlap Guest', phone: '+1 555 111 2222', email: 'overlap@test.com' },
        checkInDate:  ci.toISOString().slice(0, 10),
        checkOutDate: co.toISOString().slice(0, 10),
        rooms: [{ roomId, roomTypeId }]
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

// ─── Get Reservations ─────────────────────────────────────────────────────────
describe('GET /api/v1/reservations', () => {
  it('should return paginated reservation list', async () => {
    const res = await request(app)
      .get('/api/v1/reservations?page=1&limit=5')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('reservations');
    expect(res.body.data).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data.reservations)).toBe(true);
  });

  it('should filter reservations by status', async () => {
    const res = await request(app)
      .get('/api/v1/reservations?status=confirmed')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    res.body.data.reservations.forEach((r) => {
      expect(r.status).toBe('confirmed');
    });
  });
});

// ─── Check-In / Check-Out ─────────────────────────────────────────────────────
describe('Reservation lifecycle — check-in & check-out', () => {
  it('should check in a confirmed reservation', async () => {
    if (!reservationId) return;
    const res = await request(app)
      .post(`/api/v1/reservations/${reservationId}/check-in`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('checked_in');
  });

  it('should reject duplicate check-in', async () => {
    if (!reservationId) return;
    const res = await request(app)
      .post(`/api/v1/reservations/${reservationId}/check-in`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('should check out a checked-in reservation', async () => {
    if (!reservationId) return;
    const res = await request(app)
      .post(`/api/v1/reservations/${reservationId}/check-out`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('checked_out');
  });
});

// ─── Cancel Reservation ───────────────────────────────────────────────────────
describe('POST /api/v1/reservations/:id/cancel', () => {
  it('should cancel a confirmed reservation', async () => {
    if (!roomId || !roomTypeId) return;

    // Create a fresh reservation to cancel
    const ci = new Date(); ci.setDate(ci.getDate() + 30);
    const co = new Date(); co.setDate(co.getDate() + 32);

    const createRes = await request(app)
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        guestData:    { name: 'Cancel Me Guest', phone: '+1 555 777 8888', email: 'cancelme@test.com' },
        checkInDate:  ci.toISOString().slice(0, 10),
        checkOutDate: co.toISOString().slice(0, 10),
        rooms: [{ roomId, roomTypeId }]
      });

    if (createRes.status !== 201) return; // no room available, skip
    const newId = createRes.body.data.reservation._id;

    const res = await request(app)
      .post(`/api/v1/reservations/${newId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Guest requested cancellation' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });
});

describe('Reservation request approval workflow', () => {
  const createRequest = async (daysFromNow, email) => {
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + daysFromNow);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 2);

    return request(app).post('/api/v1/public/bookings').send({
      hotelId,
      guestName: 'Reservation Request Guest',
      guestEmail: email,
      guestPhone: '+1 555 222 3344',
      checkInDate: checkIn.toISOString().slice(0, 10),
      checkOutDate: checkOut.toISOString().slice(0, 10),
      roomTypeId,
      adultsCount: 1
    });
  };

  it('creates public bookings as pending approval and restricts request access by role', async () => {
    const created = await createRequest(365, 'pending.request@example.com');
    expect(created.status).toBe(201);
    expect(created.body.data.reservation.status).toBe('pending_approval');

    const guestLookup = await request(app)
      .get(`/api/v1/public/bookings/lookup?reference=${created.body.data.bookingReference}&email=pending.request@example.com`);
    expect(guestLookup.status).toBe(200);
    expect(guestLookup.body.data.reservation.status).toBe('pending_approval');

    const invalidGuestLookup = await request(app)
      .get(`/api/v1/public/bookings/lookup?reference=${created.body.data.bookingReference}&email=other@example.com`);
    expect(invalidGuestLookup.status).toBe(404);

    const requests = await request(app)
      .get('/api/v1/reservations/requests')
      .set('Authorization', `Bearer ${receptionistToken}`);
    expect(requests.status).toBe(200);
    expect(requests.body.data.reservations.some(
      (reservation) => reservation._id === created.body.data.reservation._id
    )).toBe(true);

    const forbidden = await request(app)
      .get('/api/v1/reservations/requests')
      .set('Authorization', `Bearer ${restaurantToken}`);
    expect(forbidden.status).toBe(403);

    const hiddenFromList = await request(app)
      .get('/api/v1/reservations?status=pending_approval')
      .set('Authorization', `Bearer ${restaurantToken}`);
    expect(hiddenFromList.status).toBe(403);

    const hiddenDetails = await request(app)
      .get(`/api/v1/reservations/${created.body.data.reservation._id}`)
      .set('Authorization', `Bearer ${restaurantToken}`);
    expect(hiddenDetails.status).toBe(403);
  });

  it('allows an authorized hotel admin to approve once and records the actor', async () => {
    const created = await createRequest(370, 'approve.request@example.com');
    const id = created.body.data.reservation._id;

    const approved = await request(app)
      .post(`/api/v1/reservations/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
    expect(approved.body.data.approvedByRole).toBe('hotel_admin');
    expect(approved.body.data.approvedAt).toBeTruthy();

    const duplicate = await request(app)
      .post(`/api/v1/reservations/${id}/approve`)
      .set('Authorization', `Bearer ${receptionistToken}`);
    expect(duplicate.status).toBe(409);
  });

  it('requires a rejection reason and allows a receptionist to reject', async () => {
    const created = await createRequest(375, 'reject.request@example.com');
    const id = created.body.data.reservation._id;

    const emptyReason = await request(app)
      .post(`/api/v1/reservations/${id}/reject`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({ reason: '   ' });
    expect(emptyReason.status).toBe(400);

    const rejected = await request(app)
      .post(`/api/v1/reservations/${id}/reject`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({ reason: 'Room unavailable for requested dates.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    expect(rejected.body.data.rejectionReason).toBe('Room unavailable for requested dates.');
    expect(rejected.body.data.rejectedByRole).toBe('receptionist');

    const guestLookup = await request(app)
      .get(`/api/v1/public/bookings/lookup?reference=${created.body.data.bookingReference}&email=reject.request@example.com`);
    expect(guestLookup.status).toBe(200);
    expect(guestLookup.body.data.reservation.status).toBe('rejected');
    expect(guestLookup.body.data.reservation.rejectionReason).toBe('Room unavailable for requested dates.');

    const duplicate = await request(app)
      .post(`/api/v1/reservations/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(duplicate.status).toBe(409);
  });
});
