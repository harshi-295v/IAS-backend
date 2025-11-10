import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn('Warning: MONGO_URI not set, starting API without database connection.');
    return;
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    dbName: process.env.MONGO_DB || 'invigilator_alloc',
  });
  console.log('MongoDB connected');
}
