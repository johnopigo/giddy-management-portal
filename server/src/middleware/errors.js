import { HttpError, fromDatabaseError } from '../lib/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const httpErr = err instanceof HttpError ? err : fromDatabaseError(err);
  if (httpErr) {
    return res.status(httpErr.status).json({ error: httpErr.message, details: httpErr.details });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }
  console.error(`[${req.correlationId}]`, err);
  res.status(500).json({ error: 'Something went wrong.', correlationId: req.correlationId });
}
