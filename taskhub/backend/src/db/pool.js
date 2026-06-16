// src/db/pool.js
// Creates a PostgreSQL connection pool.
// In production it fetches DB credentials from AWS Secrets Manager (no hardcoded secrets).
// In local dev it falls back to environment variables.
const { Pool } = require("pg");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

let pool;

async function getCredentials() {
  // If a Secrets Manager secret name is provided, fetch credentials at runtime.
  if (process.env.DB_SECRET_NAME) {
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION || "ap-south-1" });
    const res = await client.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_NAME }));
    const s = JSON.parse(res.SecretString);
    // RDS-managed secrets use {username, password, host, port, dbname} (host/dbname may be absent)
    return {
      host: s.host || process.env.DB_HOST,
      port: s.port || process.env.DB_PORT || 5432,
      user: s.username,
      password: s.password,
      database: s.dbname || process.env.DB_NAME || "taskhub",
    };
  }
  // Local/dev fallback: plain env vars
  return {
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "taskhub",
  };
}

async function initPool() {
  if (pool) return pool;
  const creds = await getCredentials();
  pool = new Pool({
    ...creds,
    max: 10,
    idleTimeoutMillis: 30000,
    // RDS requires SSL; relax cert check for the bundled RDS CA in this demo
    ssl: process.env.DB_SECRET_NAME ? { rejectUnauthorized: false } : false,
  });
  return pool;
}

async function query(text, params) {
  const p = await initPool();
  return p.query(text, params);
}

module.exports = { initPool, query };
