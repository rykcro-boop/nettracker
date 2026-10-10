const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run the database migration.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const migration = fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8');
    await pool.query(migration);
    console.log('Database migration completed successfully.');
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(`Database migration failed: ${error.message}`);
  process.exitCode = 1;
});