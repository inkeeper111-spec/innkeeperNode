import { Router } from 'express';
import {
  getDashboardSummary,
  getFinancialReport,
  exportReportCSV
} from '../controllers/reportController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/dashboard', getDashboardSummary);
router.get('/financial', getFinancialReport);
router.get('/export', exportReportCSV);

export default router;

