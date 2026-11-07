import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required to run this utility.');

const candidates = [
  'AdminPassword123!',
  'HotelPassword123!',
  'StaffPassword123!',
  'InnKeeper@2026',
  'Thottam123',
  'Password123!',
  'Continental123!'
];

const run = async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const users = await User.find({}).select('+password email role name isActive');
  for (const user of users) {
    const matches = [];
    for (const candidate of candidates) {
      if (user.password && await bcrypt.compare(candidate, user.password)) matches.push(candidate);
    }
    console.log(JSON.stringify({
      email: user.email,
      role: user.role,
      name: user.name,
      isActive: user.isActive,
      hashPrefix: user.password?.slice(0, 4),
      matches
    }));
  }
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
