import { Router } from 'express';
import {
  getGuests,
  createGuest,
  getGuestById,
  updateGuest
} from '../controllers/guestController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getGuests);
router.post('/', createGuest);
router.get('/:id', getGuestById);
router.put('/:id', updateGuest);

export default router;

