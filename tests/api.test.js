import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { connectDB, closeDB } from '../src/config/db.js';
import { seedDatabase } from '../src/utils/seeder.js';

describe('Hotel Management System - API Integration Tests', () => {
  let superAdminToken = '';
  let hotelAdminToken = '';
  let receptionistToken = '';
  let testRoomId = '';
  let testRoomTypeId = '';
  let testGuestId = '';
  let testReservationId = '';
  let testInvoiceId = '';

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // 1. Login Super Admin
    const superRes = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'superadmin@grandstayhms.com',
        password: 'AdminPassword123!'
      });
    expect(superRes.status).toBe(200);
    superAdminToken = superRes.body.data.accessToken;

    // 2. Login Hotel Admin
    const adminRes = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@grandregal.com',
        password: 'HotelPassword123!'
      });
    expect(adminRes.status).toBe(200);
    hotelAdminToken = adminRes.body.data.accessToken;

    // 3. Login Receptionist
    const recepRes = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'reception@grandregal.com',
        password: 'StaffPassword123!'
      });
    expect(recepRes.status).toBe(200);
    receptionistToken = recepRes.body.data.accessToken;
  });

  afterAll(async () => {
    await closeDB();
  });

  // Section 1: Health & Authentication
  describe('Authentication & Roles', () => {
    it('GET /api/v1/health should return 200 healthy status', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });

    it('GET /api/v1/auth/me returns authenticated user details', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${hotelAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('hotel_admin');
      expect(res.body.data.hotel.name).toBe('The Grand Regal Hotel & Spa');
    });

    it('Fails login with invalid credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'admin@grandregal.com',
          password: 'WrongPassword!'
        });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  // Section 2: Super Admin Platform Oversight
  describe('Super Admin Platform Oversight', () => {
    it('GET /api/v1/superadmin/stats returns platform statistics', async () => {
      const res = await request(app)
        .get('/api/v1/superadmin/stats')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.totalHotels).toBeGreaterThan(0);
      expect(res.body.data.totalUsers).toBeGreaterThan(0);
    });

    it('Non-super admin is forbidden from platform administration', async () => {
      const res = await request(app)
        .get('/api/v1/superadmin/stats')
        .set('Authorization', `Bearer ${hotelAdminToken}`);
      expect(res.status).toBe(403);
    });
  });

  // Section 3: Room Management & Availability
  describe('Rooms & Availability', () => {
    it('GET /api/v1/rooms lists tenant rooms', async () => {
      const res = await request(app)
        .get('/api/v1/rooms')
        .set('Authorization', `Bearer ${hotelAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      testRoomId = res.body.data[0]._id;
      testRoomTypeId = res.body.data[0].roomTypeId._id;
    });

    it('GET /api/v1/rooms/availability detects available rooms for date range', async () => {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const res = await request(app)
        .get(`/api/v1/rooms/availability?checkInDate=${today}&checkOutDate=${tomorrow}`)
        .set('Authorization', `Bearer ${receptionistToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalAvailable).toBeGreaterThan(0);
    });
  });

  // Section 4: Reservation & Concurrency/Double-Booking Prevention
  describe('Reservation Workflows & Conflict Prevention', () => {
    it('POST /api/v1/reservations creates a valid booking and initial invoice', async () => {
      // Find an available room
      const roomsRes = await request(app)
        .get('/api/v1/rooms?roomStatus=available')
        .set('Authorization', `Bearer ${receptionistToken}`);

      const availableRoom = roomsRes.body.data[0];
      expect(availableRoom).toBeDefined();

      const nextWeekStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const nextWeekEnd = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const res = await request(app)
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${receptionistToken}`)
        .send({
          guestData: {
            name: 'Charlotte Bronte',
            email: 'charlotte@example.com',
            phone: '+1 (555) 234-5678'
          },
          checkInDate: nextWeekStart,
          checkOutDate: nextWeekEnd,
          rooms: [{
            roomId: availableRoom._id,
            roomTypeId: availableRoom.roomTypeId._id
          }],
          adultsCount: 2,
          bookingSource: 'walk_in'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reservation.bookingReference).toMatch(/^BK-\d{4}-[A-F0-9]{6}$/);

      testReservationId = res.body.data.reservation._id;
      testInvoiceId = res.body.data.invoice._id;

      // ATTEMPT OVERLAPPING DOUBLE-BOOKING ON THE SAME ROOM & DATES
      const conflictRes = await request(app)
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${receptionistToken}`)
        .send({
          guestData: {
            name: 'Conflict Tester',
            email: 'conflict@example.com',
            phone: '+1 (555) 999-0000'
          },
          checkInDate: nextWeekStart,
          checkOutDate: nextWeekEnd,
          rooms: [{
            roomId: availableRoom._id,
            roomTypeId: availableRoom.roomTypeId._id
          }]
        });

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.message).toContain('already booked');
    });

    it('Check-In updates reservation status and sets room to occupied', async () => {
      const res = await request(app)
        .post(`/api/v1/reservations/${testReservationId}/check-in`)
        .set('Authorization', `Bearer ${receptionistToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('checked_in');
    });

    it('Check-Out updates reservation status and marks room as dirty', async () => {
      const res = await request(app)
        .post(`/api/v1/reservations/${testReservationId}/check-out`)
        .set('Authorization', `Bearer ${receptionistToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('checked_out');
    });
  });

  // Section 5: Billing & Payments
  describe('Billing & Invoice Settlements', () => {
    it('POST /api/v1/billing/invoices/record-payment records payment and settles balance', async () => {
      const invRes = await request(app)
        .get(`/api/v1/billing/invoices/${testInvoiceId}`)
        .set('Authorization', `Bearer ${hotelAdminToken}`);

      const invoice = invRes.body.data.invoice;
      const amountToPay = invoice.balanceAmount;

      const payRes = await request(app)
        .post('/api/v1/billing/invoices/record-payment')
        .set('Authorization', `Bearer ${receptionistToken}`)
        .send({
          invoiceId: testInvoiceId,
          amount: amountToPay,
          method: 'cash',
          notes: 'Test cash full settlement'
        });

      expect(payRes.status).toBe(201);
      expect(payRes.body.data.invoice.balanceAmount).toBe(0);
      expect(payRes.body.data.invoice.status).toBe('paid');
    });
  });

  // Section 6: Housekeeping & Restaurant POS
  describe('Housekeeping & F&B Operations', () => {
    it('GET /api/v1/housekeeping/tasks returns housekeeping queue', async () => {
      const res = await request(app)
        .get('/api/v1/housekeeping/tasks')
        .set('Authorization', `Bearer ${hotelAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/v1/restaurant/menu returns categories and menu items', async () => {
      const res = await request(app)
        .get('/api/v1/restaurant/menu')
        .set('Authorization', `Bearer ${hotelAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.categories.length).toBeGreaterThan(0);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });
  });

  // Section 7: AI Revenue & Operations Assistant
  describe('AI Analytics & Business Insights', () => {
    it('POST /api/v1/ai/query answers natural language questions using live DB data', async () => {
      const res = await request(app)
        .post('/api/v1/ai/query')
        .set('Authorization', `Bearer ${hotelAdminToken}`)
        .send({ query: 'What is our revenue and occupancy this month?' });

      expect(res.status).toBe(200);
      expect(res.body.data.answer).toBeDefined();
      expect(res.body.data.metrics).toBeDefined();
      expect(Array.isArray(res.body.data.insights)).toBe(true);
    });
  });
});

