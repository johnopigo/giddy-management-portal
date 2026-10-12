function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  get ownerDatabaseUrl() { return required('DATABASE_OWNER_URL'); },
  get appDatabaseUrl() { return required('DATABASE_APP_URL'); },
  port: Number(process.env.PORT ?? 4000),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  isTest: process.env.NODE_ENV === 'test',
};
