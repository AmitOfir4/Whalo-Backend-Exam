import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AppError } from './error-handler';

export function validate(schema: ZodSchema)
{
  return (req: Request, _res: Response, next: NextFunction): void =>
  {
    try
    {
      req.body = schema.parse(req.body);
      next();
    }
    catch (error)
    {
      if (error instanceof ZodError)
      {
        const details = error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        next(new AppError('Validation failed', 400, details));
        return;
      }
      next(error);
    }
  };
}

export function validateQuery(schema: ZodSchema)
{
  return (req: Request, _res: Response, next: NextFunction): void =>
  {
    try
    {
      req.query = schema.parse(req.query) as Record<string, string>;
      next();
    }
    catch (error)
    {
      if (error instanceof ZodError)
      {
        const details = error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        next(new AppError('Invalid query parameters', 400, details));
        return;
      }
      next(error);
    }
  };
}
