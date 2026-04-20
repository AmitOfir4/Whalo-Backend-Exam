import mongoose from 'mongoose';

export async function connectDB(uri: string): Promise<void>
{
  try
  {
    await mongoose.connect(uri, {
      maxPoolSize: 20,
      minPoolSize: 5,
    });
    console.log('Connected to MongoDB');
  }
  catch (error)
  {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}
