import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'nettracker-dev-secret';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

async function ensureDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'viewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_records (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      owner VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const adminEmail = 'admin@nettracker.local';
  const adminPasswordHash = await bcrypt.hash('Admin123!', 10);
  await pool.query(
    `
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (email) DO NOTHING;
    `,
    [adminEmail, adminPasswordHash],
  );

  const viewerEmail = 'viewer@nettracker.local';
  const viewerPasswordHash = await bcrypt.hash('Viewer123!', 10);
  await pool.query(
    `
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, 'viewer')
      ON CONFLICT (email) DO NOTHING;
    `,
    [viewerEmail, viewerPasswordHash],
  );

  const { rowCount } = await pool.query('SELECT 1 FROM tracked_records LIMIT 1;');
  if (rowCount === 0) {
    await pool.query(
      `
        INSERT INTO tracked_records (name, status, owner, notes)
        VALUES
          ('Primary Gateway', 'online', 'IT Ops', 'Main edge route with healthy latency.'),
          ('Backup Link', 'warning', 'Network Team', 'Secondary path is degraded after the last outage.'),
          ('Warehouse Router', 'offline', 'Ops', 'Recently powered down for maintenance.');
      `,
    );
  }
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '8h' },
  );
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [payload.id],
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'User no longer exists.' });
    }

    req.user = rows[0];
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admins only.' });
  }
  return next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'NetTracker API is running.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).trim()]);

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const user = rows[0];
    const passwordMatches = await bcrypt.compare(String(password), user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const safeUser = { id: user.id, email: user.email, role: user.role };
    return res.json({
      token: createToken(safeUser),
      user: safeUser,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to login right now.', error: error.message });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/users', authMiddleware, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, role, created_at FROM users ORDER BY created_at ASC',
  );
  res.json({ users: rows });
});

app.get('/api/records', authMiddleware, async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM tracked_records ORDER BY created_at DESC',
  );
  res.json({ records: rows });
});

app.post('/api/records', authMiddleware, requireAdmin, async (req, res) => {
  const { name, status, owner, notes } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Record name is required.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO tracked_records (name, status, owner, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *;`,
    [name.trim(), status || 'active', owner || 'Unknown', notes || ''],
  );

  res.status(201).json({ record: rows[0] });
});

app.put('/api/records/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, status, owner, notes } = req.body || {};

  const { rows } = await pool.query(
    `UPDATE tracked_records
     SET name = COALESCE($1, name),
         status = COALESCE($2, status),
         owner = COALESCE($3, owner),
         notes = COALESCE($4, notes),
         updated_at = NOW()
     WHERE id = $5
     RETURNING *;`,
    [name?.trim() || null, status || null, owner || null, notes || null, id],
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: 'Record not found.' });
  }

  res.json({ record: rows[0] });
});

app.delete('/api/records/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { rowCount } = await pool.query('DELETE FROM tracked_records WHERE id = $1', [id]);

  if (rowCount === 0) {
    return res.status(404).json({ message: 'Record not found.' });
  }

  res.json({ success: true, id });
});

async function startServer() {
  await ensureDatabase();
  app.listen(PORT, () => {
    console.log(`NetTracker API listening on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
