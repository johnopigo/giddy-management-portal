export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Not signed in.') => new HttpError(401, msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

/** Translates PostgreSQL errors raised by constraints, triggers and row-level security into HTTP errors. */
export function fromDatabaseError(err) {
  switch (err.code) {
    case '42501': // insufficient_privilege, including row-level security violations
      return forbidden(err.message.includes('row-level security') ? undefined : err.message);
    case 'P0002': // no_data_found, raised by workflow functions
      return notFound(err.message.charAt(0).toUpperCase() + err.message.slice(1) + '.');
    case '23505':
      return conflict('That record already exists.');
    case '23503':
      return badRequest('A referenced record does not exist.');
    case '23514':
    case '22P02':
      return badRequest(err.message);
    case '40001':
    case '40P01':
      return conflict('The record was changed by someone else. Please retry.');
    default:
      return null;
  }
}
