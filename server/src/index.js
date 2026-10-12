import { createApp } from './app.js';
import { assertProductionConfig, config } from './config.js';
import { sweepHolds } from './routes/public.js';
import { migrate } from './db/migrate.js';
import { closePools } from './db/pool.js';

assertProductionConfig();
if (config.runMigrations) await migrate();

const server = createApp().listen(config.port, () => {
  console.log(`Giddy API listening on http://localhost:${config.port}`);
});

// Online bookings whose deposit was not paid in time release their room or slot.
setInterval(() => { sweepHolds().catch((err) => console.error('hold sweep', err.message)); }, 60_000).unref();

// Finish the requests in flight, then close the database pool (containers send SIGTERM before stopping).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    server.close(async () => { await closePools(); process.exit(0); });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
