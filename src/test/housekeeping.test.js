import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';
import { User } from '../models/index.js';

let adminToken  = '';
let roomId      = '';
let taskId      = '';
let assignedTaskId = '';
let housekeeperToken = '';
let maintenanceStaffToken = '';
let housekeeperId = '';
let maintenanceStaffId = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@grandregal.com', password: 'HotelPassword123!'
  });
  adminToken = loginRes.body.data.accessToken;

  const housekeeperLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'cleaning@grandregal.com', password: 'StaffPassword123!'
  });
  housekeeperToken = housekeeperLogin.body.data.accessToken;
  housekeeperId = housekeeperLogin.body.data.user.id;

  const maintenanceLogin = await request(app).post('/api/v1/auth/login').send({
    email: 'tech@grandregal.com', password: 'StaffPassword123!'
  });
  maintenanceStaffToken = maintenanceLogin.body.data.accessToken;
  maintenanceStaffId = maintenanceLogin.body.data.user.id;

  // Get a room to use in tasks
  const roomsRes = await request(app)
    .get('/api/v1/rooms')
    .set('Authorization', `Bearer ${adminToken}`);
  if (roomsRes.body.data?.length > 0) {
    roomId = roomsRes.body.data[0]._id;
  }
});

describe('housekeeping assignment rejection', () => {
  it('requires a non-whitespace reason and limits tasks to the assigned employee', async () => {
    if (!roomId) return;
    const assigned = await request(app)
      .post('/api/v1/housekeeping/tasks')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ roomId, assignedTo: housekeeperId, notes: 'Assigned acceptance test' });
    expect(assigned.status).toBe(201);
    assignedTaskId = assigned.body.data._id;
    expect(assigned.body.data.assignedBy).toBeTruthy();
    expect(assigned.body.data.assignmentHistory[0].action).toBe('assigned');
    const assignmentNotification = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', ['Bearer', housekeeperToken].join(' '));
    expect(assignmentNotification.body.data.notifications.some(
      (notification) => notification.relatedRecordId === assignedTaskId
        && notification.eventType === 'housekeeping_task_assigned'
    )).toBe(true);

    const assignedList = await request(app)
      .get('/api/v1/housekeeping/tasks')
      .set('Authorization', ['Bearer', housekeeperToken].join(' '));
    expect(assignedList.body.data.some((task) => task._id === assignedTaskId)).toBe(true);

    const emptyReason = await request(app)
      .post(`/api/v1/housekeeping/tasks/${assignedTaskId}/reject`)
      .set('Authorization', ['Bearer', housekeeperToken].join(' '))
      .send({ reason: '   ' });
    expect(emptyReason.status).toBe(400);

    const outsider = await request(app)
      .post(`/api/v1/housekeeping/tasks/${assignedTaskId}/reject`)
      .set('Authorization', ['Bearer', maintenanceStaffToken].join(' '))
      .send({ reason: 'Cannot access this task' });
    expect(outsider.status).toBe(403);
  });

  it('records an assigned employee rejection and notifies the employee and assigner', async () => {
    const rejected = await request(app)
      .post(`/api/v1/housekeeping/tasks/${assignedTaskId}/reject`)
      .set('Authorization', ['Bearer', housekeeperToken].join(' '))
      .send({ reason: 'Room needs specialized equipment.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    expect(rejected.body.data.rejectionReason).toBe('Room needs specialized equipment.');
    expect(String(rejected.body.data.rejectedBy)).toBe(housekeeperId);
    expect(rejected.body.data.rejectedAt).toBeTruthy();
    expect(rejected.body.data.assignmentHistory.at(-1).action).toBe('rejected');

    const duplicate = await request(app)
      .post(`/api/v1/housekeeping/tasks/${assignedTaskId}/reject`)
      .set('Authorization', ['Bearer', housekeeperToken].join(' '))
      .send({ reason: 'Trying twice' });
    expect(duplicate.status).toBe(409);

    const employeeNotifications = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', ['Bearer', housekeeperToken].join(' '));
    expect(employeeNotifications.body.data.notifications.some(
      (notification) => notification.relatedRecordId === assignedTaskId
        && notification.eventType === 'housekeeping_task_rejected'
    )).toBe(true);

    const adminNotifications = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(adminNotifications.body.data.notifications.some(
      (notification) => notification.relatedRecordId === assignedTaskId
        && notification.eventType === 'housekeeping_task_rejected'
    )).toBe(true);

    const hotelAdmin = await User.findOne({ email: 'admin@grandregal.com' });
    const replacement = await User.create({
      name: 'Replacement Housekeeper',
      email: 'replacement-housekeeper@grandregal.com',
      password: 'StaffPassword123!',
      role: 'housekeeping_staff',
      hotelId: hotelAdmin.hotelId,
      propertyId: hotelAdmin.propertyId,
      isActive: true
    });
    const reassigned = await request(app)
      .post(`/api/v1/housekeeping/tasks/${assignedTaskId}/assign`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ assignedTo: replacement._id });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data.status).toBe('dirty');
    expect(reassigned.body.data.assignmentStatus).toBe('pending');
    expect(reassigned.body.data.assignmentHistory.at(-1).action).toBe('reassigned');
  });

  it('allows the assigned employee to accept a pending task once', async () => {
    const created = await request(app)
      .post('/api/v1/housekeeping/tasks')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ roomId, assignedTo: housekeeperId, notes: 'Acceptance action test' });
    const accepted = await request(app)
      .post(`/api/v1/housekeeping/tasks/${created.body.data._id}/accept`)
      .set('Authorization', ['Bearer', housekeeperToken].join(' '));
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.assignmentStatus).toBe('accepted');

    const duplicate = await request(app)
      .post(`/api/v1/housekeeping/tasks/${created.body.data._id}/accept`)
      .set('Authorization', ['Bearer', housekeeperToken].join(' '));
    expect(duplicate.status).toBe(409);
  });
});

describe('maintenance job rejection and reassignment', () => {
  it('rejects with a required reason, notifies operations, and supports explicit reassignment', async () => {
    if (!roomId) return;
    const created = await request(app)
      .post('/api/v1/maintenance')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        roomId,
        category: 'plumbing',
        issueDescription: 'Leaking sink test ticket',
        assignedTechnician: maintenanceStaffId
      });
    expect(created.status).toBe(201);
    const ticketId = created.body.data._id;

    const noReason = await request(app)
      .post(`/api/v1/maintenance/${ticketId}/reject`)
      .set('Authorization', ['Bearer', maintenanceStaffToken].join(' '))
      .send({ reason: '  ' });
    expect(noReason.status).toBe(400);

    const unauthorized = await request(app)
      .post(`/api/v1/maintenance/${ticketId}/reject`)
      .set('Authorization', ['Bearer', housekeeperToken].join(' '))
      .send({ reason: 'Not assigned to this user.' });
    expect(unauthorized.status).toBe(403);

    const rejected = await request(app)
      .post(`/api/v1/maintenance/${ticketId}/reject`)
      .set('Authorization', ['Bearer', maintenanceStaffToken].join(' '))
      .send({ reason: 'Required replacement part is unavailable.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    expect(rejected.body.data.rejectionReason).toBe('Required replacement part is unavailable.');
    expect(rejected.body.data.assignmentHistory.at(-1).action).toBe('rejected');

    const duplicate = await request(app)
      .post(`/api/v1/maintenance/${ticketId}/reject`)
      .set('Authorization', ['Bearer', maintenanceStaffToken].join(' '))
      .send({ reason: 'Second rejection attempt.' });
    expect(duplicate.status).toBe(409);

    const hotelAdmin = await User.findOne({ email: 'admin@grandregal.com' });
    const replacement = await User.create({
      name: 'Replacement Technician',
      email: 'replacement-technician@grandregal.com',
      password: 'StaffPassword123!',
      role: 'maintenance_staff',
      hotelId: hotelAdmin.hotelId,
      propertyId: hotelAdmin.propertyId,
      isActive: true
    });
    const reassigned = await request(app)
      .put(`/api/v1/maintenance/${ticketId}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ assignedTechnician: replacement._id });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data.status).toBe('assigned');
    expect(reassigned.body.data.assignmentStatus).toBe('pending');
    expect(reassigned.body.data.assignmentHistory.at(-1).action).toBe('reassigned');

    const newAssigneeLogin = await request(app).post('/api/v1/auth/login').send({
      email: replacement.email,
      password: 'StaffPassword123!'
    });
    const newAssigneeNotifications = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${newAssigneeLogin.body.data.accessToken}`);
    expect(newAssigneeNotifications.body.data.notifications.some(
      (notification) => notification.relatedRecordId === ticketId
        && notification.eventType === 'maintenance_ticket_assigned'
    )).toBe(true);
  });
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

  it('rejects a status transition that skips the next stage', async () => {
    if (!taskId) return;
    const invalid = await request(app)
      .patch(`/api/v1/housekeeping/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'inspected' });
    expect(invalid.status).toBe(409);
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
