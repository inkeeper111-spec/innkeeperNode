import { Router } from 'express';
import {
  getTasks,
  createTask,
  updateTaskStatus,
  reportDamage,
  acceptTaskAssignment,
  rejectTaskAssignment,
  reassignRejectedTask
} from '../controllers/housekeepingController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/tasks', getTasks);
router.post('/tasks', createTask);
router.patch('/tasks/:id/status', updateTaskStatus);
router.post('/tasks/:id/accept', acceptTaskAssignment);
router.post('/tasks/:id/reject', rejectTaskAssignment);
router.post('/tasks/:id/assign', reassignRejectedTask);
router.post('/tasks/:id/report-damage', reportDamage);

export default router;
