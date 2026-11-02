import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { Payment, Subscription } from '../models/index.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

let superAdminToken;
let hotelAdminToken;
let hotelId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await setup();
  await seedDatabase();
  const superAdminLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'superadmin@grandstayhms.com',
    password: 'AdminPassword123!'
  });
  superAdminToken = superAdminLogin.body.data.accessToken;
});

afterAll(async () => {
  await teardown();
});

describe('approval-first module subscriptions', () => {
  it('blocks module access and subscription options until the hotel is approved', async () => {
    const registration = await request(app).post('/api/v1/auth/register').send({
      hotelName: 'Subscription Test Hotel',
      name: 'Subscription Owner',
      email: 'subscription-owner@example.test',
      password: 'Subscription123!',
      phone: '+1 - 5551112233',
      address: '5 Test Street',
      city: 'Test City',
      state: 'TS',
      country: 'Testland',
      postalCode: '10001'
    });
    expect(registration.status).toBe(201);
    expect(registration.body.data.hotel.registrationStatus).toBe('pending');
    expect(registration.body.data.hotel.subscriptionStatus).toBe('not_started');
    hotelId = registration.body.data.hotel.id;

    const pendingToken = registration.body.data.accessToken;
    const protectedRequest = await request(app).get('/api/v1/rooms').set(auth(pendingToken));
    expect(protectedRequest.status).toBe(403);
    expect(protectedRequest.body.code).toBe('REGISTRATION_PENDING');
    const unavailableOptions = await request(app).get('/api/v1/subscriptions/options').set(auth(pendingToken));
    expect(unavailableOptions.status).toBe(403);

    await request(app)
      .patch(`/api/v1/superadmin/hotels/${hotelId}/status`)
      .set(auth(superAdminToken))
      .send({ status: 'active' })
      .expect(200);
    const login = await request(app).post('/api/v1/auth/login').send({
      email: 'subscription-owner@example.test',
      password: 'Subscription123!'
    });
    hotelAdminToken = login.body.data.accessToken;
    const noSubscriptionAccess = await request(app).get('/api/v1/rooms').set(auth(hotelAdminToken));
    expect(noSubscriptionAccess.status).toBe(403);
    expect(noSubscriptionAccess.body.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('calculates server-side prices with the minimum rather than adding a base fee', async () => {
    const modulePrices = [
      { key: 'rooms', monthlyPrice: 600, annualPrice: 600 },
      { key: 'reservations', monthlyPrice: 399, annualPrice: 399 },
      { key: 'guests', monthlyPrice: 1200, annualPrice: 1200 },
      { key: 'frontdesk', monthlyPrice: 1300, annualPrice: 1300 },
      { key: 'housekeeping', monthlyPrice: 850, annualPrice: 850 }
    ];
    for (const module of modulePrices) {
      await request(app)
        .put(`/api/v1/superadmin/modules/${module.key}`)
        .set(auth(superAdminToken))
        .send(module)
        .expect(200);
    }

    const scenarios = [
      { selectedModules: ['rooms'], moduleTotal: 600, finalAmount: 999 },
      { selectedModules: ['housekeeping'], moduleTotal: 850, finalAmount: 999 },
      { selectedModules: ['rooms', 'reservations'], moduleTotal: 999, finalAmount: 999 },
      { selectedModules: ['guests'], moduleTotal: 1200, finalAmount: 1200 },
      { selectedModules: ['guests', 'frontdesk'], moduleTotal: 2500, finalAmount: 2500 }
    ];
    for (const scenario of scenarios) {
      const response = await request(app)
        .post('/api/v1/subscriptions/orders')
        .set(auth(hotelAdminToken))
        .send({
          ...scenario,
          amount: 1,
          modulePrices: { rooms: 0.01 },
          billingCycle: 'monthly'
        })
        .expect(201);
      expect(response.body.data.moduleTotal).toBe(scenario.moduleTotal);
      expect(response.body.data.finalAmount).toBe(scenario.finalAmount);
      expect(response.body.data.order.amount).toBe(scenario.finalAmount * 100);
    }

    const annual = await request(app)
      .post('/api/v1/subscriptions/orders')
      .set(auth(hotelAdminToken))
      .send({ selectedModules: ['guests'], billingCycle: 'annual' })
      .expect(201);
    expect(annual.body.data.moduleTotal).toBe(1200);
    expect(annual.body.data.finalAmount).toBe(11988);
    expect(annual.body.data.order.amount).toBe(1198800);

    await request(app)
      .put('/api/v1/superadmin/subscription-settings')
      .set(auth(superAdminToken))
      .send({ minimumMonthlyAmount: 1200 })
      .expect(200);
    const updatedMinimum = await request(app)
      .post('/api/v1/subscriptions/orders')
      .set(auth(hotelAdminToken))
      .send({ selectedModules: ['rooms'], billingCycle: 'monthly' })
      .expect(201);
    expect(updatedMinimum.body.data.finalAmount).toBe(1200);
    await request(app)
      .put('/api/v1/superadmin/subscription-settings')
      .set(auth(superAdminToken))
      .send({ minimumMonthlyAmount: 999 })
      .expect(200);

    const invalidModule = await request(app)
      .post('/api/v1/subscriptions/orders')
      .set(auth(hotelAdminToken))
      .send({ selectedModules: ['unconfigured-module'], billingCycle: 'monthly' });
    expect(invalidModule.status).toBe(400);
  });

  it('activates selected entitlements only after payment verification and is idempotent', async () => {
    const orderResponse = await request(app)
      .post('/api/v1/subscriptions/orders')
      .set(auth(hotelAdminToken))
      .send({ selectedModules: ['rooms', 'reservations'], billingCycle: 'monthly' })
      .expect(201);
    const orderId = orderResponse.body.data.order.id;
    const verifyPayload = {
      razorpayOrderId: orderId,
      razorpayPaymentId: 'pay_subscription_activation_test',
      razorpaySignature: 'test_signature'
    };

    const verified = await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(auth(hotelAdminToken))
      .send(verifyPayload)
      .expect(200);
    expect(verified.body.data.subscription.status).toBe('active');
    expect(verified.body.data.subscription.selectedModules).toEqual(['rooms', 'reservations']);

    const roomAccess = await request(app).get('/api/v1/rooms').set(auth(hotelAdminToken));
    expect(roomAccess.status).toBe(200);
    const unpurchasedAccess = await request(app).get('/api/v1/guests').set(auth(hotelAdminToken));
    expect(unpurchasedAccess.status).toBe(403);
    expect(unpurchasedAccess.body.code).toBe('MODULE_NOT_SUBSCRIBED');

    const scheduled = await request(app)
      .post('/api/v1/subscriptions/module-removals')
      .set(auth(hotelAdminToken))
      .send({ moduleKeys: ['reservations'] })
      .expect(200);
    expect(scheduled.body.data.scheduledModuleRemovals).toEqual(['reservations']);
    expect((await request(app).get('/api/v1/reservations').set(auth(hotelAdminToken))).status).toBe(200);

    await request(app)
      .post('/api/v1/subscriptions/verify')
      .set(auth(hotelAdminToken))
      .send(verifyPayload)
      .expect(200);
    const subscription = await Subscription.findOne({ hotelId });
    expect(await Payment.countDocuments({ razorpayPaymentId: verifyPayload.razorpayPaymentId })).toBe(1);
    expect(subscription.finalAmount).toBe(999);
  });
});
