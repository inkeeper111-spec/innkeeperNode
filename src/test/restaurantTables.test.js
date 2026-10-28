import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';
import { AuditLog } from '../models/AuditLog.js';

let adminToken = '';
let restaurantToken = '';
let hotelId = '';
let propertyId = '';
let menuItemId = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const [adminLogin, staffLogin] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({
      email: 'admin@grandregal.com',
      password: 'HotelPassword123!'
    }),
    request(app).post('/api/v1/auth/login').send({
      email: 'chef@grandregal.com',
      password: 'StaffPassword123!'
    })
  ]);
  adminToken = adminLogin.body.data.accessToken;
  restaurantToken = staffLogin.body.data.accessToken;
  hotelId = staffLogin.body.data.user.hotelId;
  propertyId = staffLogin.body.data.user.propertyId;

  const menu = await request(app)
    .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
  menuItemId = menu.body.data.items[0]._id;
});

afterAll(async () => {
  await teardown();
});

describe('Restaurant table management and POS assignment', () => {
  it('creates sequential tables and restricts table management to hotel admins', async () => {
    const first = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 4, name: 'Window' });
    const second = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 2 });

    expect(first.status).toBe(201);
    expect(first.body.data.tableNumber).toBe(1);
    expect(first.body.data.propertyId).toBe(propertyId);
    expect(second.status).toBe(201);
    expect(second.body.data.tableNumber).toBe(2);

    const forbiddenCreate = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', restaurantToken].join(' '))
      .send({ capacity: 4 });
    expect(forbiddenCreate.status).toBe(403);

    const staffTables = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', restaurantToken].join(' '));
    expect(staffTables.status).toBe(200);
    expect(staffTables.body.data).toHaveLength(2);
    expect(staffTables.body.data[0].currentStatus).toBe('available');
  });

  it('atomically assigns one table, preserves its snapshot, and releases only after settlement', async () => {
    const tablesRes = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const table = tablesRes.body.data[0];
    const orderPayload = {
      orderType: 'dine_in',
      tableId: table._id,
      items: [{ menuItemId, quantity: 1 }]
    };

    const results = await Promise.all([
      request(app)
        .post('/api/v1/restaurant/orders')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send(orderPayload),
      request(app)
        .post('/api/v1/restaurant/orders')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send(orderPayload)
    ]);

    const created = results.find((result) => result.status === 201);
    const conflict = results.find((result) => result.status === 409);
    expect(created).toBeTruthy();
    expect(conflict).toBeTruthy();
    const order = created.body.data;
    expect(order.tableId).toBe(table._id);
    expect(order.tableNumber).toBe('Table 1');

    const occupiedTables = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(occupiedTables.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('occupied');

    const rename = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ name: 'Garden' });
    expect(rename.status).toBe(200);

    const cannotDeactivate = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ isActive: false });
    expect(cannotDeactivate.status).toBe(404);

    const orders = await request(app)
      .get('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const kitchenOrder = orders.body.data.find((entry) => entry._id === order._id);
    expect(kitchenOrder.tableNumber).toBe('Table 1');
    expect(kitchenOrder.tableNameSnapshot).toBe('Window');
    expect(kitchenOrder.tableId.name).toBe('Garden');

    const modifiedUnitPrice = await request(app)
      .patch(`/api/v1/restaurant/orders/${order._id}/bill-amounts`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ itemUnitPrices: { 0: 10.25 }, discountAmount: 1, reason: 'Manager approved menu correction' });
    expect(modifiedUnitPrice.status).toBe(200);
    expect(modifiedUnitPrice.body.data.items[0].unitPrice).toBe(10.25);
    expect(modifiedUnitPrice.body.data.discountAmount).toBe(1);
    expect(modifiedUnitPrice.body.data.amountModifications).toHaveLength(2);
    expect(modifiedUnitPrice.body.data.amountModifications[0].reason).toBe('Manager approved menu correction');
    const audit = await AuditLog.findOne({ action: 'UPDATE_RESTAURANT_BILL_AMOUNTS', entityId: order._id });
    expect(audit.details.modifications).toHaveLength(2);

    const persistedBill = await request(app)
      .get('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(persistedBill.body.data.find((entry) => entry._id === order._id).amountModifications).toHaveLength(2);

    for (const status of ['preparing', 'ready', 'served']) {
      const updated = await request(app)
        .patch(`/api/v1/restaurant/orders/${order._id}/status`)
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send({ status });
      expect(updated.status).toBe(200);
    }

    const stillOccupied = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(stillOccupied.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('occupied');

    const settled = await request(app)
      .patch(`/api/v1/restaurant/orders/${order._id}/settle`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentMethod: 'cash' });
    expect(settled.status).toBe(200);
    expect(settled.body.data.paymentStatus).toBe('paid');

    const blockedPaidEdit = await request(app)
      .patch(`/api/v1/restaurant/orders/${order._id}/bill-amounts`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ itemUnitPrices: { 0: 9 }, discountAmount: 0, reason: 'Attempt after payment' });
    expect(blockedPaidEdit.status).toBe(409);

    const availableTables = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(availableTables.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('available');

    const deactivated = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ isActive: false });
    expect(deactivated.status).toBe(200);

    const historicalOrder = await request(app)
      .get('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(historicalOrder.body.data.find((entry) => entry._id === order._id).tableNumber).toBe('Table 1');
  });

  it('releases a table when its dine-in order is cancelled', async () => {
    const tablesRes = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const table = tablesRes.body.data.find((entry) => entry.tableNumber === 2);

    const invalidOrder = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId: table._id,
        items: [{ menuItemId: '000000000000000000000000', quantity: 1 }]
      });
    expect(invalidOrder.status).toBe(400);

    const created = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId: table._id,
        items: [{ menuItemId, quantity: 1 }]
      });
    expect(created.status).toBe(201);

    const cancelled = await request(app)
      .patch(`/api/v1/restaurant/orders/${created.body.data._id}/status`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ status: 'cancelled' });
    expect(cancelled.status).toBe(200);

    const afterCancellation = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(afterCancellation.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('available');
  });
});
