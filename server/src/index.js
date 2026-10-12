import { createApp } from './app.js';
import { config } from './config.js';
import { sweepHolds } from './routes/public.js';

createApp().listen(config.port, () => {
  console.log(`Giddy API listening on http://localhost:${config.port}`);
});

// Online bookings whose deposit was not paid in time release their room or slot.
setInterval(() => { sweepHolds().catch((err) => console.error('hold sweep', err.message)); }, 60_000).unref();
