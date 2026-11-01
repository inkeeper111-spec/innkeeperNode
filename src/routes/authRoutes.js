import { Router } from 'express';
import {
  register,
  login,
  refreshAccessToken,
  logout,
  getCurrentUser,
  updateProfile,
  forgotPassword,
  resetPassword
} from '../controllers/authController.js';
import { authenticate } from '../middlewares/auth.js';
import { authLimiter } from '../middlewares/rateLimiter.js';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';

const router = Router();

router.post('/register', authLimiter, validatePhoneFields({ path: 'phone', required: true }), register);
router.post('/login', authLimiter, login);
router.post('/refresh', refreshAccessToken);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, getCurrentUser);
router.put('/profile', authenticate, validatePhoneFields({ path: 'phone' }), updateProfile);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);

export default router;
