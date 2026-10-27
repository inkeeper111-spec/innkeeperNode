import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes from './routes/authRoutes.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import hotelRoutes from './routes/hotelRoutes.js';
import roomTypeRoutes from './routes/roomTypeRoutes.js';
import roomRoutes from './routes/roomRoutes.js';
import reservationRoutes from './routes/reservationRoutes.js';
import guestRoutes from './routes/guestRoutes.js';
import billingRoutes from './routes/billingRoutes.js';
import housekeepingRoutes from './routes/housekeepingRoutes.js';
import restaurantRoutes from './routes/restaurantRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import expenseRoutes from './routes/expenseRoutes.js';
import staffRoutes from './routes/staffRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import maintenanceRoutes from './routes/maintenanceRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import publicRoutes from './routes/publicRoutes.js';

import { errorHandler } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimiter.js';

const app = express();

// Security and utility middlewares
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// General API rate limiter (1000 req / 15 min per IP)
app.use('/api/', apiLimiter);

// Health Check
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'Innkeeper Hotel Management System API'
  });
});

// Mount Routes under /api/v1
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/superadmin', superAdminRoutes);
app.use('/api/v1/hotels', hotelRoutes);
app.use('/api/v1/room-types', roomTypeRoutes);
app.use('/api/v1/rooms', roomRoutes);
app.use('/api/v1/reservations', reservationRoutes);
app.use('/api/v1/guests', guestRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/housekeeping', housekeepingRoutes);
app.use('/api/v1/restaurant', restaurantRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/expenses', expenseRoutes);
app.use('/api/v1/staff', staffRoutes);
app.use('/api/v1/leave', leaveRoutes);
app.use('/api/v1/maintenance', maintenanceRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/public', publicRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Central Error Handler
app.use(errorHandler);

export default app;
