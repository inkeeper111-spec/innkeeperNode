import { Router } from 'express';
import {
  getTickets,
  createTicket,
  updateTicket
} from '../controllers/maintenanceController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getTickets);
router.post('/', createTicket);
router.put('/:id', updateTicket);

export default router;

