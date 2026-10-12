function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  // The built web app (web/dist) is served by the API when this is set (production: one service, one address).
  webDist: process.env.WEB_DIST ?? '',
  // Apply pending database migrations at startup (safe with several instances: they take a lock).
  runMigrations: process.env.RUN_MIGRATIONS === 'true',
  get ownerDatabaseUrl() { return required('DATABASE_OWNER_URL'); },
  get appDatabaseUrl() { return required('DATABASE_APP_URL'); },
  port: Number(process.env.PORT ?? 4000),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  isTest: process.env.NODE_ENV === 'test',
  isProduction: process.env.NODE_ENV === 'production',
  // Public address of the web app, used for Paystack's return link to the guest's booking page.
  publicUrl: (process.env.PUBLIC_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, ''),
  // Paystack secret key (sk_test_… or sk_live_…). Without it, outside production, a built-in test gateway is used.
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
  // The built-in test gateway (no money moves) must be switched on explicitly, and never in production.
  paymentsTestMode: process.env.PAYMENTS_TEST_MODE === 'true' && process.env.NODE_ENV !== 'production',
};

/** Refuses to start in production with settings that would be unsafe there. */
export function assertProductionConfig() {
  if (!config.isProduction) return;
  const problems = [];
  if (!config.cookieSecure) problems.push('COOKIE_SECURE must be true (the site must be served over HTTPS)');
  if (!/^https:\/\//.test(config.publicUrl)) problems.push('PUBLIC_URL must be the https:// address of the site');
  if (/change-me/.test(process.env.DATABASE_APP_URL ?? '') || /change-me/.test(process.env.DATABASE_OWNER_URL ?? '')) {
    problems.push('database passwords are still the development default "change-me"');
  }
  for (const name of ['DATABASE_OWNER_URL', 'DATABASE_APP_URL']) if (!process.env[name]) problems.push(`${name} is not set`);
  if (process.env.PAYMENTS_TEST_MODE === 'true') problems.push('PAYMENTS_TEST_MODE must not be set in production');
  if (problems.length) throw new Error(`Unsafe production configuration:\n - ${problems.join('\n - ')}`);
  if (!config.paystackSecretKey) console.warn('PAYSTACK_SECRET_KEY is not set: online deposits are disabled until it is.');
}
