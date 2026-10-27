import { Router } from 'express';
import {
  getTickets,
  createTicket,
  updateTicket,
  acceptTicketAssignment,
  rejectTicketAssignment
} from '../controllers/maintenanceController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getTickets);
router.post('/', createTicket);
router.put('/:id', updateTicket);
router.post('/:id/accept', acceptTicketAssignment);
router.post('/:id/reject', rejectTicketAssignment);

export default router;
