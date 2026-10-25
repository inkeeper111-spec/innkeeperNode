import mongoose from 'mongoose';
import dns from 'dns';
import { logger } from './logger.js';

let memoryServer = null;

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI || '';

  if (process.env.MONGODB_DNS_SERVER) {
    dns.setServers([process.env.MONGODB_DNS_SERVER, '8.8.8.8', '1.1.1.1']);
  }

  if (uri) {
    const attempts = 3;
    for (let i = 1; i <= attempts; i++) {
      try {
        await mongoose.connect(uri, {
          serverSelectionTimeoutMS: 15000,
          connectTimeoutMS: 15000
        });
        logger.info(`MongoDB connected: ${uri.replace(/\/\/.*@/, '//***@')}`);
        return;
      } catch (err) {
        logger.warn(`MongoDB connection attempt ${i}/${attempts} failed: ${err.message}`);
        if (i === attempts) {
          if (process.env.NODE_ENV === 'production') {
            throw err;
          }
          logger.warn('Falling back to in-memory MongoDB for local development.');
        }
      }
    }
  }

  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create({
      instance: { storageEngine: 'wiredTiger' }
    });
    await mongoose.connect(memoryServer.getUri());
    logger.info(`Connected to in-memory MongoDB: ${memoryServer.getUri()}`);
    logger.warn('In-memory database is ephemeral. Set a reachable MONGODB_URI to persist data.');
  } catch (memErr) {
    logger.error('Failed to start in-memory MongoDB:', memErr.message);
    throw memErr;
  }
};

export const closeDB = async () => {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
};
