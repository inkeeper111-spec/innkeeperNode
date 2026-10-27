import { Router } from 'express';
import {
  cancelLeaveRequest,
  createLeaveRequest,
  getLeaveRequests,
  getLeaveTypes,
  reviewLeaveRequest,
  updateLeaveTypes
} from '../controllers/leaveController.js';
import { authenticate, authorize, requireTenant } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/types', getLeaveTypes);
router.put('/types', authorize(ROLES.HOTEL_ADMIN), updateLeaveTypes);
router.get('/requests', getLeaveRequests);
router.post('/requests', authorize(
  ROLES.HOTEL_ADMIN,
  ROLES.RECEPTIONIST,
  ROLES.RESTAURANT_STAFF,
  ROLES.HOUSEKEEPING_STAFF,
  ROLES.MAINTENANCE_STAFF
), createLeaveRequest);
router.patch('/requests/:id/review', authorize(ROLES.HOTEL_ADMIN), reviewLeaveRequest);
router.post('/requests/:id/cancel', cancelLeaveRequest);

export default router;
