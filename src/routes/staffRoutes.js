import { Router } from 'express';
import {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  getShifts,
  createShift,
  updateShift,
  getAttendance,
  recordAttendance,
  updateAttendance,
  bulkMarkAttendance,
  getAttendanceSummary,
  getSalaryHistory,
  processSalary,
  checkIn,
  checkOut,
  getMyAttendance,
  getAdvances,
  createAdvance,
  exportSalaryCsv
} from '../controllers/staffController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

// ── Staff directory ───────────────────────────────────────────────────────────
router.get('/',      getStaff);
router.post('/',     authorize(ROLES.HOTEL_ADMIN), createStaff);

// ── Shifts — static sub-routes BEFORE parameterised ones ─────────────────────
router.get('/shifts',       getShifts);
router.post('/shifts',      authorize(ROLES.HOTEL_ADMIN), createShift);
router.patch('/shifts/:id', authorize(ROLES.HOTEL_ADMIN), updateShift);

// ── Attendance — static sub-routes FIRST ─────────────────────────────────────
router.get('/attendance/summary', authorize(ROLES.HOTEL_ADMIN), getAttendanceSummary);
router.post('/attendance/bulk',   authorize(ROLES.HOTEL_ADMIN), bulkMarkAttendance);
router.post('/attendance/check-in', checkIn);
router.post('/attendance/check-out', checkOut);
router.get('/attendance/me', getMyAttendance);
router.get('/attendance',         getAttendance);
router.post('/attendance',        authorize(ROLES.HOTEL_ADMIN), recordAttendance);
router.patch('/attendance/:id',   authorize(ROLES.HOTEL_ADMIN), updateAttendance);

router.get('/advances', authorize(ROLES.HOTEL_ADMIN), getAdvances);
router.post('/advances', authorize(ROLES.HOTEL_ADMIN), createAdvance);

// ── Salary ────────────────────────────────────────────────────────────────────
router.get('/salary',          authorize(ROLES.HOTEL_ADMIN), getSalaryHistory);
router.get('/salary/export',   authorize(ROLES.HOTEL_ADMIN), exportSalaryCsv);
router.post('/salary/process', authorize(ROLES.HOTEL_ADMIN), processSalary);

// ── Staff by ID — parameterised routes LAST ───────────────────────────────────
router.get('/:id',   getStaffById);
router.patch('/:id', authorize(ROLES.HOTEL_ADMIN), updateStaff);

export default router;
