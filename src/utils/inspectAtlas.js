import dns from 'dns';
import mongoose from 'mongoose';

dns.setServers(['192.168.0.1', '8.8.8.8', '1.1.1.1']);

const uri = 'mongodb+srv://ranjithraja325:Thottam123@cluster0.2bgzz.mongodb.net/hotel';

const run = async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const users = await db.collection('users').find({}, { projection: { email: 1, role: 1, isActive: 1, name: 1 } }).toArray();
  const hotels = await db.collection('hotels').find({}, { projection: { name: 1, status: 1 } }).toArray();
  console.log('USERS', JSON.stringify(users, null, 2));
  console.log('HOTELS', JSON.stringify(hotels, null, 2));
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('CONNECT_FAIL', err.message);
  process.exit(1);
});
