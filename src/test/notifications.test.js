import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { Notification } from '../models/index.js';
import { notifyPlatformAdmins, notifyRoles } from '../services/notificationService.js';
import { seedDatabase } from '../utils/seeder.js';
import { setup, teardown } from './setup.js';

let adminToken = '';
let receptionistToken = '';
let restaurantToken = '';
let superAdminToken = '';
let hotelId = '';

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await setup();
  await seedDatabase();
  const [admin, receptionist, restaurant, superAdmin] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({ email: 'admin@grandregal.com', password: 'HotelPassword123!' }),
    request(app).post('/api/v1/auth/login').send({ email: 'reception@grandregal.com', password: 'StaffPassword123!' }),
    request(app).post('/api/v1/auth/login').send({ email: 'chef@grandregal.com', password: 'StaffPassword123!' }),
    request(app).post('/api/v1/auth/login').send({ email: 'superadmin@grandstayhms.com', password: 'AdminPassword123!' })
  ]);
  adminToken = admin.body.data.accessToken;
  receptionistToken = receptionist.body.data.accessToken;
  restaurantToken = restaurant.body.data.accessToken;
  superAdminToken = superAdmin.body.data.accessToken;
  hotelId = admin.body.data.user.hotelId;
});

afterAll(async () => {
  await teardown();
});

describe('Role-based notification delivery', () => {
  it('delivers an idempotent hotel event only to its role recipients', async () => {
    const event = {
      hotelId,
      roles: ['receptionist'],
      title: 'Test reservation alert',
      message: 'A reservation needs review.',
      module: 'reservations',
      eventType: 'reservation_created',
      priority: 'high',
      link: '/reservations',
      eventId: 'notification-test:reservation-1'
    };
    await notifyRoles(event);
    await notifyRoles(event);

    const receptionistNotifications = await request(app)
      .get('/api/v1/notifications?module=reservations&priority=high&isRead=false')
      .set(auth(receptionistToken));
    expect(receptionistNotifications.status).toBe(200);
    expect(receptionistNotifications.body.data.notifications).toHaveLength(1);
    expect(receptionistNotifications.body.data.notifications[0].eventType).toBe('reservation_created');
    expect(receptionistNotifications.body.data.pagination.total).toBe(1);

    const adminNotifications = await request(app)
      .get('/api/v1/notifications?module=reservations')
      .set(auth(adminToken));
    expect(adminNotifications.body.data.notifications).toHaveLength(0);

    const restaurantNotifications = await request(app)
      .get('/api/v1/notifications?module=reservations')
      .set(auth(restaurantToken));
    expect(restaurantNotifications.body.data.notifications).toHaveLength(0);

    const wrongRecipientRead = await request(app)
      .patch(`/api/v1/notifications/${receptionistNotifications.body.data.notifications[0]._id}/read`)
      .set(auth(adminToken));
    expect(wrongRecipientRead.status).toBe(404);

    const read = await request(app)
      .patch(`/api/v1/notifications/${receptionistNotifications.body.data.notifications[0]._id}/read`)
      .set(auth(receptionistToken));
    expect(read.status).toBe(200);
    expect(read.body.data.isRead).toBe(true);
    expect(read.body.data.readAt).toBeTruthy();
  });

  it('keeps platform notifications limited to super admins', async () => {
    await notifyPlatformAdmins({
      title: 'Test platform alert',
      message: 'A platform-level action completed.',
      module: 'platform',
      eventType: 'platform_test',
      priority: 'critical',
      link: '/superadmin',
      eventId: 'notification-test:platform-1'
    });

    const superAdminNotifications = await request(app)
      .get('/api/v1/notifications?module=platform&priority=critical')
      .set(auth(superAdminToken));
    expect(superAdminNotifications.status).toBe(200);
    expect(superAdminNotifications.body.data.notifications).toHaveLength(1);
    expect(superAdminNotifications.body.data.notifications[0].recipientRole).toBe('super_admin');

    const hotelAdminNotifications = await request(app)
      .get('/api/v1/notifications?module=platform&priority=critical')
      .set(auth(adminToken));
    expect(hotelAdminNotifications.body.data.notifications).toHaveLength(0);

    const saved = await Notification.findOne({ eventType: 'platform_test' }).lean();
    expect(saved.hotelId).toBeNull();
  });
});
