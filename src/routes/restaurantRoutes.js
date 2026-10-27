import { Router } from 'express';
import {
  getMenu,
  createCategory,
  updateCategory,
  createMenuItem,
  updateMenuItem,
  getOrders,
  getTables,
  createTable,
  updateTable,
  createOrder,
  updateOrderStatus,
  settleOrder,
  transferToRoomFolio
} from '../controllers/restaurantController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/menu', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), getMenu);
router.post('/categories', authorize(ROLES.HOTEL_ADMIN), createCategory);
router.patch('/categories/:id', authorize(ROLES.HOTEL_ADMIN), updateCategory);
router.post('/items', authorize(ROLES.HOTEL_ADMIN), createMenuItem);
router.patch('/items/:id', authorize(ROLES.HOTEL_ADMIN), updateMenuItem);

router.get('/orders', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), getOrders);
router.post('/orders', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), createOrder);
router.patch('/orders/:id/status', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), updateOrderStatus);
router.patch('/orders/:id/settle', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), settleOrder);
router.post('/orders/transfer-to-folio', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), transferToRoomFolio);
router.get('/tables', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), getTables);
router.post('/tables', authorize(ROLES.HOTEL_ADMIN), createTable);
router.patch('/tables/:id', authorize(ROLES.HOTEL_ADMIN), updateTable);

export default router;
