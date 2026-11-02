import { Router } from 'express';
import { authenticate } from '../middlewares/auth.js';
import {
  getSubscriptionOptions,
  createSubscriptionOrder,
  verifySubscriptionPayment,
  failSubscriptionPayment,
  scheduleModuleRemovals
} from '../controllers/subscriptionController.js';

const router = Router();

router.use(authenticate);
router.get('/options', getSubscriptionOptions);
router.post('/orders', createSubscriptionOrder);
router.post('/verify', verifySubscriptionPayment);
router.post('/failure', failSubscriptionPayment);
router.post('/module-removals', scheduleModuleRemovals);

export default router;
