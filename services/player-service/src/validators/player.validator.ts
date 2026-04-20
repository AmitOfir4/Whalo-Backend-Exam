import { z } from 'zod';

export const createPlayerSchema = z.object({
  username: z
    .string({ required_error: 'Username is required' })
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must be at most 30 characters')
    .regex(/^\S+$/, 'Username must not contain spaces'),
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email format'),
});

export const updatePlayerSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(30, 'Username must be at most 30 characters')
      .regex(/^\S+$/, 'Username must not contain spaces')
      .optional(),
    email: z.string().email('Invalid email format').optional(),
  })
  .refine((data) => data.username || data.email, {
    message: 'At least one field (username or email) must be provided',
  });
