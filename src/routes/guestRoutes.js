import { Router } from 'express';
import {
  getGuests,
  createGuest,
  getGuestById,
  updateGuest
} from '../controllers/guestController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getGuests);
router.post('/', validatePhoneFields({ path: 'phone', required: true }), createGuest);
router.get('/:id', getGuestById);
router.put('/:id', validatePhoneFields({ path: 'phone' }), updateGuest);

export default router;
