const { createClient } = require('@libsql/client');
require('dotenv').config();

// Mesmo cliente funciona local (arquivo SQLite) e em producao (Turso/libSQL remoto).
// Basta trocar DATABASE_URL / DATABASE_AUTH_TOKEN no .env.
const db = createClient({
  url: process.env.DATABASE_URL || 'file:./local.db',
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

module.exports = db;
