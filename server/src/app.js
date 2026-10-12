import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { requestContext, authenticate, requireAuth, requireCsrfHeader } from './middleware/context.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { orgRoutes } from './routes/org.js';
import { userRoutes } from './routes/users.js';
import { roleRoutes } from './routes/roles.js';
import { assignmentRoutes } from './routes/assignments.js';
import { auditRoutes } from './routes/audit.js';
import { catalogRoutes } from './routes/catalog.js';
import { supplierRoutes } from './routes/suppliers.js';
import { inventoryRoutes } from './routes/inventory.js';
import { customerRoutes } from './routes/customers.js';
import { procurementRoutes } from './routes/procurement.js';
import { transferRoutes } from './routes/transfers.js';
import { requestRoutes } from './routes/requests.js';
import { notificationRoutes } from './routes/notifications.js';
import { posRoutes } from './routes/pos.js';
import { financeRoutes } from './routes/finance.js';
import { recipeRoutes } from './routes/recipes.js';
import { productionRoutes } from './routes/production.js';
import { apartmentRoutes } from './routes/apartments.js';
import { bookingRoutes } from './routes/bookings.js';
import { partnershipRoutes } from './routes/partnership.js';
import { publicRoutes } from './routes/public.js';
import { reportRoutes } from './routes/reports.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({
    limit: '200kb',
    // Paystack signs the exact bytes it sends, so the webhook needs the raw body.
    verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/public/paystack/webhook')) req.rawBody = buf; },
  }));
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, limit: config.isTest ? 100_000 : 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(requestContext);
  app.use('/api', requireCsrfHeader);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authenticate, authRoutes());
  // Public booking pages: no login (see routes/public.js).
  app.use('/api/public', publicRoutes());

  const authed = express.Router();
  authed.use(authenticate, requireAuth);
  authed.use('/me', meRoutes());
  authed.use('/org', orgRoutes());
  authed.use('/users', userRoutes());
  authed.use('/roles', roleRoutes());
  authed.use('/assignments', assignmentRoutes());
  authed.use('/audit', auditRoutes());
  authed.use('/catalog', catalogRoutes());
  authed.use('/suppliers', supplierRoutes());
  authed.use('/inventory', inventoryRoutes());
  authed.use('/customers', customerRoutes());
  authed.use('/procurement', procurementRoutes());
  authed.use('/transfers', transferRoutes());
  authed.use('/requests', requestRoutes());
  authed.use('/notifications', notificationRoutes());
  authed.use('/pos', posRoutes());
  authed.use('/finance', financeRoutes());
  authed.use('/recipes', recipeRoutes());
  authed.use('/production', productionRoutes());
  authed.use('/apartments', apartmentRoutes());
  authed.use('/bookings', bookingRoutes());
  authed.use('/partnership', partnershipRoutes());
  authed.use('/reports', reportRoutes());
  app.use('/api', authed);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
