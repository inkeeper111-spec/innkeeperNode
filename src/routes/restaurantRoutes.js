import { Router } from 'express';
import {
  getMenu,
  createCategory,
  updateCategory,
  createMenuItem,
  updateMenuItem,
  getOrders,
  createOrder,
  updateOrderStatus,
  transferToRoomFolio
} from '../controllers/restaurantController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/menu', getMenu);
router.post('/categories', authorize(ROLES.HOTEL_ADMIN), createCategory);
router.patch('/categories/:id', authorize(ROLES.HOTEL_ADMIN), updateCategory);
router.post('/items', authorize(ROLES.HOTEL_ADMIN), createMenuItem);
router.patch('/items/:id', authorize(ROLES.HOTEL_ADMIN), updateMenuItem);

router.get('/orders', getOrders);
router.post('/orders', createOrder);
router.patch('/orders/:id/status', updateOrderStatus);
router.post('/orders/transfer-to-folio', transferToRoomFolio);

export default router;

