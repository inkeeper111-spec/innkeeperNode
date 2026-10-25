import { Router } from 'express';
import {
  getReservations,
  createReservation,
  getReservationById,
  updateReservation,
  checkInReservation,
  checkOutReservation,
  cancelReservation
} from '../controllers/reservationController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getReservations);
router.post('/', createReservation);
router.get('/:id', getReservationById);
router.patch('/:id', updateReservation);
router.post('/:id/check-in', checkInReservation);
router.post('/:id/check-out', checkOutReservation);
router.post('/:id/cancel', cancelReservation);

export default router;

