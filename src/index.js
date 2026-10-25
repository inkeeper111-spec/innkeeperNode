import 'dotenv/config';
import app from './app.js';
import { connectDB } from './config/db.js';
import { ensureDemoUsers } from './utils/ensureDemoUsers.js';
import { logger } from './config/logger.js';

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    await ensureDemoUsers();
    app.listen(PORT, () => {
      logger.info(`Innkeeper Server listening on http://localhost:${PORT}`);
      logger.info(`API Base Endpoint: http://localhost:${PORT}/api/v1`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

