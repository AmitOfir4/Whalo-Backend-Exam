import Redis from 'ioredis';

let redis: Redis | null = null;

export function connectRedis(url: string): Redis {
  if (redis) return redis;

  redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  redis.on('connect', () => console.log('Connected to Redis'));
  redis.on('error', (err) => console.error('Redis error:', err.message));

  return redis;
}

export function getRedis(): Redis {
  if (!redis) throw new Error('Redis not initialized — call connectRedis first');
  return redis;
}
