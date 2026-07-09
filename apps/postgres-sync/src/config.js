import dotenv from "dotenv";

dotenv.config();

const DIGITALOCEAN_PLACEHOLDER_CERT_PATH = "/path/to/";
const SSL_FILE_QUERY_PARAMS = ["sslrootcert", "sslcert", "sslkey"];

export function sanitizeDatabaseUrlForPg(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let changed = false;

    for (const param of SSL_FILE_QUERY_PARAMS) {
      const value = url.searchParams.get(param);
      if (value && value.includes(DIGITALOCEAN_PLACEHOLDER_CERT_PATH)) {
        url.searchParams.delete(param);
        changed = true;
      }
    }

    return changed ? url.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

export function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: sanitizeDatabaseUrlForPg(process.env.DATABASE_URL)
    };
  }

  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "bowlus_ops",
    user: process.env.PGUSER || "bowlus_app",
    password: process.env.PGPASSWORD || undefined
  };
}
