import { Router } from 'express';
import {
  getRooms,
  createRoom,
  getRoomById,
  updateRoom,
  updateRoomStatus,
  checkAvailability
} from '../controllers/roomController.js';
import { authenticate, requireTenant, authorize } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/availability', checkAvailability);
router.get('/', getRooms);
router.post('/', authorize(ROLES.HOTEL_ADMIN), createRoom);
router.get('/:id', getRoomById);
router.put('/:id', authorize(ROLES.HOTEL_ADMIN), updateRoom);
router.patch('/:id/status', updateRoomStatus);

export default router;

