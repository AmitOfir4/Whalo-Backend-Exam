import { z } from 'zod';

export const createLogSchema = z.object({
  playerId: z
    .string({ required_error: 'playerId is required' })
    .min(1, 'playerId cannot be empty'),
  logData: z
    .string({ required_error: 'logData is required' })
    .min(1, 'logData cannot be empty'),
});
