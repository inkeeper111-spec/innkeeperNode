import { Router } from 'express';
import {
  getRoomTypes,
  createRoomType,
  getRoomTypeById,
  updateRoomType,
  deleteRoomType
} from '../controllers/roomTypeController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getRoomTypes);
router.post('/', authorize(ROLES.HOTEL_ADMIN), createRoomType);
router.get('/:id', getRoomTypeById);
router.put('/:id', authorize(ROLES.HOTEL_ADMIN), updateRoomType);
router.delete('/:id', authorize(ROLES.HOTEL_ADMIN), deleteRoomType);

export default router;

