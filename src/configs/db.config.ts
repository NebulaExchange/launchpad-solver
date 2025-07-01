function buildConnectionStringFromEnv(): string {
  const { PGHOST, PGUSER, PGPORT, PGDATABASE, PGPASSWORD } = process.env;
  if (!PGHOST || !PGUSER || !PGPORT || !PGDATABASE || !PGPASSWORD) {
    throw new Error('Missing one or more required PostgreSQL environment variables');
  }
  return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(
    PGPASSWORD,
  )}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}

export const dbConnectionString = buildConnectionStringFromEnv();
