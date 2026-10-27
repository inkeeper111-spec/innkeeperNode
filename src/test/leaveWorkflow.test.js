import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import request from 'supertest';
import app from '../app.js';
import { Attendance, LeaveRequest, Notification } from '../models/index.js';
import { seedDatabase } from '../utils/seeder.js';
import { setup, teardown } from './setup.js';

let adminToken = '';
let employeeToken = '';
let otherEmployeeToken = '';
let employeeId = '';
let hotelId = '';

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const getDate = (offset) => dayjs().add(offset, 'day').format('YYYY-MM-DD');

beforeAll(async () => {
  await setup();
  await seedDatabase();
  const [adminLogin, employeeLogin, otherEmployeeLogin] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({
      email: 'admin@grandregal.com',
      password: 'HotelPassword123!'
    }),
    request(app).post('/api/v1/auth/login').send({
      email: 'reception@grandregal.com',
      password: 'StaffPassword123!'
    }),
    request(app).post('/api/v1/auth/login').send({
      email: 'chef@grandregal.com',
      password: 'StaffPassword123!'
    })
  ]);
  adminToken = adminLogin.body.data.accessToken;
  employeeToken = employeeLogin.body.data.accessToken;
  otherEmployeeToken = otherEmployeeLogin.body.data.accessToken;
  employeeId = employeeLogin.body.data.user._id || employeeLogin.body.data.user.id;
  hotelId = employeeLogin.body.data.user.hotelId;
});

afterAll(async () => {
  await teardown();
});

describe('Leave request workflow', () => {
  it('submits pending requests, rejects overlaps, and allows only hotel admins to decide', async () => {
    const startDate = getDate(7);
    const endDate = getDate(8);
    const submission = await request(app)
      .post('/api/v1/leave/requests')
      .set(auth(employeeToken))
      .send({ leaveType: 'casual', startDate, endDate, reason: 'Family commitment' });

    expect(submission.status).toBe(201);
    expect(submission.body.data.status).toBe('pending');
    expect(submission.body.data.totalDays).toBe(2);
    expect(submission.body.data.decisionHistory[0].actorRole).toBe('receptionist');

    const overlap = await request(app)
      .post('/api/v1/leave/requests')
      .set(auth(employeeToken))
      .send({ leaveType: 'sick', startDate, endDate: getDate(9), reason: 'Overlapping dates' });
    expect(overlap.status).toBe(409);

    const otherEmployeeRequest = await request(app)
      .post('/api/v1/leave/requests')
      .set(auth(otherEmployeeToken))
      .send({ leaveType: 'sick', startDate: getDate(24), endDate: getDate(24), reason: 'Separate employee request' });
    expect(otherEmployeeRequest.status).toBe(201);

    const employeeRequests = await request(app)
      .get('/api/v1/leave/requests')
      .set(auth(employeeToken));
    expect(employeeRequests.status).toBe(200);
    expect(employeeRequests.body.data).toHaveLength(1);
    expect(String(employeeRequests.body.data[0].userId._id || employeeRequests.body.data[0].userId)).toBe(employeeId);
    const adminRequests = await request(app)
      .get('/api/v1/leave/requests?status=all')
      .set(auth(adminToken));
    expect(adminRequests.body.data).toHaveLength(2);

    const forbiddenDecision = await request(app)
      .patch(`/api/v1/leave/requests/${submission.body.data._id}/review`)
      .set(auth(employeeToken))
      .send({ status: 'approved' });
    expect(forbiddenDecision.status).toBe(403);

    const notifications = await Notification.countDocuments({
      hotelId,
      $or: [{ userId: employeeId }, { title: 'Leave request requires review' }]
    });
    expect(notifications).toBeGreaterThanOrEqual(2);
  });

  it('approves once and reflects approved leave in attendance without requiring a stored record', async () => {
    const startDate = getDate(11);
    const endDate = getDate(11);
    const leave = await LeaveRequest.create({
      hotelId,
      userId: employeeId,
      employeeId,
      leaveType: 'casual',
      startDate: dayjs(startDate).startOf('day').toDate(),
      endDate: dayjs(endDate).startOf('day').toDate(),
      totalDays: 1,
      days: 1,
      reason: 'Approved attendance integration test',
      status: 'pending'
    });

    const approval = await request(app)
      .patch(`/api/v1/leave/requests/${leave._id}/review`)
      .set(auth(adminToken))
      .send({ status: 'approved' });
    expect(approval.status).toBe(200);
    expect(approval.body.data.status).toBe('approved');
    expect(approval.body.data.approvedAt).toBeTruthy();

    const duplicateApproval = await request(app)
      .patch(`/api/v1/leave/requests/${leave._id}/review`)
      .set(auth(adminToken))
      .send({ status: 'approved' });
    expect(duplicateApproval.status).toBe(409);

    const attendance = await request(app)
      .get(`/api/v1/staff/attendance?userId=${employeeId}&startDate=${startDate}&endDate=${endDate}`)
      .set(auth(adminToken));
    expect(attendance.status).toBe(200);
    expect(attendance.body.data.attendance).toHaveLength(1);
    expect(attendance.body.data.attendance[0].status).toBe('on_leave');

    const employeeAttendance = await request(app)
      .get(`/api/v1/staff/attendance/me?month=${dayjs(startDate).format('YYYY-MM')}`)
      .set(auth(employeeToken));
    expect(employeeAttendance.body.data.records.some((record) => record.status === 'on_leave')).toBe(true);

    const monthlySummary = await request(app)
      .get(`/api/v1/staff/attendance/summary?month=${dayjs(startDate).format('YYYY-MM')}`)
      .set(auth(adminToken));
    const employeeSummary = monthlySummary.body.data.summary.find((record) => String(record.userId) === employeeId);
    expect(employeeSummary.leaveDays).toBe(1);
    expect(employeeSummary.absentDays).toBe(0);

    const bulkMark = await request(app)
      .post('/api/v1/staff/attendance/bulk')
      .set(auth(adminToken))
      .send({ date: startDate, defaultStatus: 'absent' });
    expect(bulkMark.status).toBe(200);
    const storedAttendance = await Attendance.findOne({ hotelId, userId: employeeId, date: dayjs(startDate).startOf('day').toDate() });
    expect(storedAttendance).toBeNull();
    const attendanceAfterBulkMark = await request(app)
      .get(`/api/v1/staff/attendance?userId=${employeeId}&startDate=${startDate}&endDate=${endDate}`)
      .set(auth(adminToken));
    expect(attendanceAfterBulkMark.body.data.attendance[0].status).toBe('on_leave');
  });

  it('requires a non-whitespace rejection reason and stores rejection metadata', async () => {
    const startDate = getDate(16);
    const submission = await request(app)
      .post('/api/v1/leave/requests')
      .set(auth(employeeToken))
      .send({ leaveType: 'sick', startDate, endDate: startDate, reason: 'Medical appointment' });
    expect(submission.status).toBe(201);

    const emptyReason = await request(app)
      .patch(`/api/v1/leave/requests/${submission.body.data._id}/review`)
      .set(auth(adminToken))
      .send({ status: 'rejected', rejectionReason: '   ' });
    expect(emptyReason.status).toBe(400);

    const rejection = await request(app)
      .patch(`/api/v1/leave/requests/${submission.body.data._id}/review`)
      .set(auth(adminToken))
      .send({ status: 'rejected', rejectionReason: 'Staffing coverage is unavailable.' });
    expect(rejection.status).toBe(200);
    expect(rejection.body.data.status).toBe('rejected');
    expect(rejection.body.data.rejectionReason).toBe('Staffing coverage is unavailable.');
    expect(rejection.body.data.rejectedBy).toBeTruthy();
    expect(rejection.body.data.rejectedAt).toBeTruthy();

    const employeeHistory = await request(app)
      .get('/api/v1/leave/requests')
      .set(auth(employeeToken));
    expect(employeeHistory.body.data.find((item) => item._id === submission.body.data._id).rejectionReason)
      .toBe('Staffing coverage is unavailable.');
  });

  it('prevents concurrent overlapping requests from being created', async () => {
    const startDate = getDate(32);
    const overlapStart = getDate(33);
    const results = await Promise.all([
      request(app)
        .post('/api/v1/leave/requests')
        .set(auth(employeeToken))
        .send({ leaveType: 'casual', startDate, endDate: overlapStart, reason: 'Concurrent request one' }),
      request(app)
        .post('/api/v1/leave/requests')
        .set(auth(employeeToken))
        .send({ leaveType: 'sick', startDate: overlapStart, endDate: getDate(34), reason: 'Concurrent request two' })
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });
});
