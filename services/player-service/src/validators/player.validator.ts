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

// Max playerIds accepted in a single GET /players?ids=... call.
// Bounded to protect Mongo `$in` plans and to keep response payloads small.
// Tuned for typical leaderboard page sizes (10–100).
const MAX_BATCH_IDS = 100;

// Batch-resolve playerIds → usernames. Sole read path for GET /players.
// Powers client-side leaderboard / top-scores enrichment: the client hands
// us a page's worth of playerIds and gets the display names back in one
// round-trip, instead of N parallel GET /players/:id calls.
export const resolvePlayersQuerySchema = z.object({
  ids: z
    .string({ required_error: 'ids is required' })
    .transform((val, ctx) =>
    {
      const parts = Array.from(new Set(
        val.split(',').map((s) => s.trim()).filter(Boolean),
      ));
      if (parts.length === 0)
      {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ids must contain at least one non-empty value' });
        return z.NEVER;
      }
      if (parts.length > MAX_BATCH_IDS)
      {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ids must not exceed ${MAX_BATCH_IDS} entries`,
        });
        return z.NEVER;
      }
      return parts;
    }),
});

export type ResolvePlayersQuery = z.infer<typeof resolvePlayersQuerySchema>;
