import { Router } from 'express';
import { getNotifications, markAsRead } from '../controllers/notificationController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getNotifications);
router.patch('/read-all', markAsRead);

export default router;

