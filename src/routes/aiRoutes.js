import { Router } from 'express';
import { askAIAssistant, getAIInsights } from '../controllers/aiController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.post('/query', askAIAssistant);
router.get('/insights', getAIInsights);

export default router;

