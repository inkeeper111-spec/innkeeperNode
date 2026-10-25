import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB, closeDB } from '../config/db.js';
import { User } from '../models/User.js';

const candidates = [
  'AdminPassword123!',
  'HotelPassword123!',
  'StaffPassword123!',
  'InnKeeper@2026'
];

const run = async () => {
  await connectDB();
  const users = await User.find({}).select('+password email role isActive name');
  console.log(`USER_COUNT=${users.length}`);
  for (const user of users) {
    const matches = [];
    for (const candidate of candidates) {
      try {
        if (user.password && await bcrypt.compare(candidate, user.password)) {
          matches.push(candidate);
        }
      } catch {
        // ignore
      }
    }
    console.log(JSON.stringify({
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      name: user.name,
      hashPrefix: user.password?.slice(0, 7),
      hashLen: user.password?.length,
      matches
    }));
  }
  await closeDB();
};

run().catch(async (err) => {
  console.error(err);
  await closeDB();
  process.exit(1);
});
