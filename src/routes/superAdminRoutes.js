import { Router } from 'express';
import {
  getPlatformStats,
  getHotels,
  getHotelById,
  updateHotelStatus,
  assignPlanToHotel,
  getPlans,
  createPlan,
  updatePlan,
  getSubscriptions,
  getAuditLogs,
  getPlatformUsers
} from '../controllers/superAdminController.js';
import { authenticate, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';
import {
  getSubscriptionConfiguration,
  updateSubscriptionModule,
  updateSubscriptionSettings,
  getModuleSubscribers,
  updateManagedSubscription
} from '../controllers/subscriptionAdminController.js';

const router = Router();

// All super-admin routes require authentication + super_admin role
router.use(authenticate);
router.use(authorize(ROLES.SUPER_ADMIN));

// Platform overview
router.get('/stats', getPlatformStats);

// Hotel management
router.get('/hotels',              getHotels);
router.get('/hotels/:id',          getHotelById);
router.patch('/hotels/:id/status', updateHotelStatus);
router.patch('/hotels/:id/plan',   assignPlanToHotel);

// Subscription plans
router.get('/plans',         getPlans);
router.post('/plans',        createPlan);
router.put('/plans/:id',     updatePlan);
router.patch('/plans/:id',   updatePlan);   // alias for PATCH callers

// Subscriptions
router.get('/subscriptions', getSubscriptions);
router.patch('/subscriptions/:id/manage', updateManagedSubscription);
router.get('/modules', getSubscriptionConfiguration);
router.put('/modules/:key', updateSubscriptionModule);
router.get('/modules/:key/hotels', getModuleSubscribers);
router.put('/subscription-settings', updateSubscriptionSettings);

// Audit logs
router.get('/audit-logs', getAuditLogs);

// Platform users
router.get('/users', getPlatformUsers);

export default router;
