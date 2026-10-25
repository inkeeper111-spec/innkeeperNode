import { connectDB, closeDB } from '../config/db.js';

// Use a fresh in-memory DB for every test run
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_grandstay_2026';
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret_grandstay_2026';
process.env.MONGODB_URI = ''; // force in-memory

export const setup   = connectDB;
export const teardown = closeDB;
