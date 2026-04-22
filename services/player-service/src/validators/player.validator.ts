import { z } from 'zod';

export const createPlayerSchema = z.object({
  username: z
    .string({ required_error: 'Username is required' })
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must be at most 30 characters')
    .regex(/^\S+$/, 'Username must not contain spaces'),
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email format')
    .transform((val) => val.toLowerCase()),
});

export const updatePlayerSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(30, 'Username must be at most 30 characters')
      .regex(/^\S+$/, 'Username must not contain spaces')
      .transform((val) => val.toLowerCase())
      .optional(),
    email: z.string().email('Invalid email format').transform((val) => val.toLowerCase()).optional(),
  })
  .refine((data) => data.username || data.email, {
    message: 'At least one field (username or email) must be provided',
  });

export const listPlayersQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? 1 : Number(val)))
    .pipe(z.number().int().min(1, 'page must be >= 1')),
  limit: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? 20 : Number(val)))
    .pipe(z.number().int().min(1, 'limit must be >= 1').max(100, 'limit must be <= 100')),
});

export type ListPlayersQuery = z.infer<typeof listPlayersQuerySchema>;
