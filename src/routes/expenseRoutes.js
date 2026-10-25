import { Router } from 'express';
import {
  getExpenses,
  createExpense,
  updateExpenseStatus
} from '../controllers/expenseController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/', getExpenses);
router.post('/', createExpense);
router.patch('/:id/status', updateExpenseStatus);

export default router;

