import { Router } from 'express';
import {
  getReservations,
  createReservation,
  getReservationById,
  updateReservation,
  getReservationRequests,
  approveReservationRequest,
  rejectReservationRequest,
  checkInReservation,
  checkOutReservation,
  cancelReservation
} from '../controllers/reservationController.js';
import { authenticate, authorize, requireTenant } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getReservations);
router.post('/', createReservation);
router.get('/requests', authorize(ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST), getReservationRequests);
router.post('/:id/approve', authorize(ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST), approveReservationRequest);
router.post('/:id/reject', authorize(ROLES.HOTEL_ADMIN, ROLES.RECEPTIONIST), rejectReservationRequest);
router.get('/:id', getReservationById);
router.patch('/:id', updateReservation);
router.post('/:id/check-in', checkInReservation);
router.post('/:id/check-out', checkOutReservation);
router.post('/:id/cancel', cancelReservation);

export default router;
