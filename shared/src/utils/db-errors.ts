import { AppError } from '../middleware/error-handler';

/**
 * MongoDB duplicate-key error helpers.
 *
 * A unique-index violation surfaces as either a MongoServerError with
 * `code === 11000` or a Mongoose ValidationError wrapping it. Translating
 * these to 409 Conflict closes the TOCTOU race in check-then-insert flows
 * (e.g. createPlayer) — the unique index is the real source of truth; the
 * app layer just has to react to its verdict.
 */

interface MongoDuplicateKeyError extends Error
{
  code?: number;
  keyValue?: Record<string, unknown>;
}

export function isDuplicateKeyError(err: unknown): err is MongoDuplicateKeyError
{
  if (!err || typeof err !== 'object')
  {
    return false;
  }
  return (err as { code?: unknown }).code === 11000;
}

/**
 * If `err` is a Mongo E11000 duplicate-key error, throw an AppError(409)
 * whose message is taken from `fieldMessages` based on the violated key —
 * e.g. `{ playerId: 'Player ID already exists', username: '...' }`.
 * Otherwise rethrow the original error untouched.
 */
export function throwConflictIfDuplicate(
  err: unknown,
  fieldMessages: Record<string, string>,
  fallbackMessage: string = 'Resource already exists',
): never
{
  if (isDuplicateKeyError(err))
  {
    const key = err.keyValue ? Object.keys(err.keyValue)[0] : undefined;
    const message = (key && fieldMessages[key]) || fallbackMessage;
    throw new AppError(message, 409, err.keyValue ? { duplicate: err.keyValue } : undefined);
  }
  throw err as Error;
}
