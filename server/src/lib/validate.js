import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Invalid request.', z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}

export const uuidParam = z.object({ id: z.uuid() });
