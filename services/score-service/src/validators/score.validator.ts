import { z } from 'zod';

export const createScoreSchema = z.object({
  playerId: z
    .string({ required_error: 'playerId is required' })
    .min(1, 'playerId cannot be empty'),
  score: z
    .number({ required_error: 'score is required', invalid_type_error: 'score must be a number' })
    .int('score must be an integer')
    .min(0, 'score must be non-negative'),
});
