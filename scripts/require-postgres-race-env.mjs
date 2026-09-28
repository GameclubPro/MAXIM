const pg = new URL(process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? 'missing:');
const redis = new URL(process.env.MAXIM_TEST_REDIS_URL ?? 'missing:');
const local = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (!local(pg) || !pg.pathname.includes('race_test') || !local(redis)) {
  throw new Error(
    'PostgreSQL races require local CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL (race_test database) and MAXIM_TEST_REDIS_URL; refusing skipped integration checks.',
  );
}
