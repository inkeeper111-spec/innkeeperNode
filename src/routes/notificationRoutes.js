import { Router } from 'express';
import { getNotifications, markAsRead, markNotificationAsRead } from '../controllers/notificationController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (req.user?.role === 'super_admin') {
    req.hotelId = null;
    return next();
  }
  return requireTenant(req, res, next);
});

router.get('/', getNotifications);
router.patch('/read-all', markAsRead);
router.patch('/:id/read', markNotificationAsRead);

export default router;
