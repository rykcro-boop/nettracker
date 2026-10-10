import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: path.resolve('server/.env') });

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'nettracker-dev-secret';
const API_KEY = process.env.API_KEY || '';
const execFileAsync = promisify(execFile);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

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
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL,
      device_name VARCHAR(255) NOT NULL,
      action VARCHAR(30) NOT NULL,
      changed_by_id INTEGER,
      changed_by_email VARCHAR(255) NOT NULL,
      details TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS activity_log_created_at_idx ON activity_log (created_at DESC);');

  try {
    await pool.query('SELECT id FROM devices LIMIT 0;');
  } catch {
    throw new Error('Devices schema is missing. Run "node server/migrate.js" before starting the server.');
  }

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

async function recordActivity({ record, action, user, details }) {
  await pool.query(
    `INSERT INTO activity_log (device_id, device_name, action, changed_by_id, changed_by_email, details)
     VALUES ($1, $2, $3, $4, $5, $6);`,
    [record.id, record.name, action, user.id, user.email, details],
  );
}

function normalizeMac(value) {
  return typeof value === 'string' ? value.trim().replaceAll('-', ':').toUpperCase() : '';
}

function validMac(value) {
  return /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value);
}

function validConnectionType(value) {
  return ['wifi', 'wired', 'unknown'].includes(value);
}

function validId(value) {
  return /^\d+$/.test(value) && Number(value) > 0;
}

app.get('/api/devices', authMiddleware, async (req, res) => {
  const where = [];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };

  if (req.query.online !== undefined) {
    if (!['true', 'false'].includes(req.query.online)) {
      return res.status(400).json({ message: 'online must be true or false.' });
    }
    addFilter('is_online = ?', req.query.online === 'true');
  }
  if (req.query.auto !== undefined) {
    if (!['true', 'false'].includes(req.query.auto)) {
      return res.status(400).json({ message: 'auto must be true or false.' });
    }
    addFilter('auto_discovered = ?', req.query.auto === 'true');
  }
  if (req.query.search) {
    const searchIndex = values.length + 1;
    values.push(`%${String(req.query.search).trim().slice(0, 120)}%`);
    where.push(`(hostname ILIKE $${searchIndex} OR ip_address ILIKE $${searchIndex} OR mac_address ILIKE $${searchIndex} OR vendor ILIKE $${searchIndex} OR device_type ILIKE $${searchIndex} OR location ILIKE $${searchIndex})`);
  }
  if (req.query.device_type) addFilter('device_type = ?', String(req.query.device_type).slice(0, 50));
  if (req.query.connection_type) {
    if (!validConnectionType(req.query.connection_type)) {
      return res.status(400).json({ message: 'connection_type must be wifi, wired, or unknown.' });
    }
    addFilter('connection_type = ?', req.query.connection_type);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM devices ${whereClause} ORDER BY first_seen DESC, id DESC;`,
    values,
  );
  res.json({ devices: rows });
});

app.get('/api/stats', authMiddleware, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE is_online) AS online_now,
      COUNT(*) FILTER (WHERE NOT is_online) AS offline,
      COUNT(*) FILTER (WHERE auto_discovered AND first_seen::date = CURRENT_DATE) AS new_today
    FROM devices;
  `);
  const { rows: connectionRows } = await pool.query(
    `SELECT COUNT(*) AS connections_today
     FROM connection_logs
     WHERE created_at::date = CURRENT_DATE AND event IN ('connected', 'reconnected');`,
  );
  res.json({ ...rows[0], connections_today: connectionRows[0].connections_today });
});

app.get('/api/logs', authMiddleware, async (req, res) => {
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ message: 'limit must be an integer from 1 to 500.' });
  }

  const where = [];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };

  if (req.query.event) {
    if (!['connected', 'disconnected', 'reconnected'].includes(req.query.event)) {
      return res.status(400).json({ message: 'event must be connected, disconnected, or reconnected.' });
    }
    addFilter('cl.event = ?', req.query.event);
  }
  if (req.query.device_id !== undefined) {
    if (!validId(String(req.query.device_id))) {
      return res.status(400).json({ message: 'device_id must be a positive integer.' });
    }
    addFilter('cl.device_id = ?', Number(req.query.device_id));
  }
  for (const [queryName, operator] of [['from', '>='], ['to', '<']]) {
    if (req.query[queryName] !== undefined) {
      const date = new Date(String(req.query[queryName]));
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ message: `${queryName} must be a valid date.` });
      }
      addFilter(`cl.created_at ${operator} ?`, date.toISOString());
    }
  }

  values.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT cl.id, cl.device_id, d.hostname, cl.event, cl.ip_address, cl.created_at
     FROM connection_logs cl
     LEFT JOIN devices d ON d.id = cl.device_id
     ${whereClause}
     ORDER BY cl.created_at DESC
     LIMIT $${values.length};`,
    values,
  );
  res.json({ logs: rows });
});

app.post('/api/devices', authMiddleware, requireAdmin, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ message: 'A device object is required.' });
  }
  const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
  const ipAddress = body.ip_address == null || body.ip_address === '' ? null : String(body.ip_address).trim();
  const macAddress = body.mac_address == null || body.mac_address === '' ? null : normalizeMac(body.mac_address);
  const connectionType = body.connection_type || 'unknown';
  for (const field of ['device_type', 'location', 'owner', 'notes']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return res.status(400).json({ message: `${field} must be a string.` });
    }
  }
  if (!hostname || hostname.length > 255) return res.status(400).json({ message: 'hostname is required and must be at most 255 characters.' });
  if (typeof body.ip_address !== 'undefined' && body.ip_address !== null && typeof body.ip_address !== 'string') {
    return res.status(400).json({ message: 'ip_address must be a string.' });
  }
  if (typeof body.mac_address !== 'undefined' && body.mac_address !== null && typeof body.mac_address !== 'string') {
    return res.status(400).json({ message: 'mac_address must be a string.' });
  }
  if (String(body.device_type || '').length > 50 || String(body.location || '').length > 255
      || String(body.owner || '').length > 255 || String(body.notes || '').length > 2000) {
    return res.status(400).json({ message: 'One or more device fields exceed the allowed length.' });
  }
  if (ipAddress && !isIP(ipAddress)) return res.status(400).json({ message: 'ip_address must be a valid IP address.' });
  if (macAddress && !validMac(macAddress)) return res.status(400).json({ message: 'mac_address must be a valid six-octet MAC address.' });
  if (!validConnectionType(connectionType)) return res.status(400).json({ message: 'connection_type must be wifi, wired, or unknown.' });

  const { rows } = await pool.query(
    `INSERT INTO devices (hostname, ip_address, mac_address, device_type, connection_type, location, owner, notes, is_online, auto_discovered)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false)
     RETURNING *;`,
    [hostname, ipAddress, macAddress, String(body.device_type || 'unknown').slice(0, 50), connectionType,
      String(body.location || '').slice(0, 255), String(body.owner || '').slice(0, 255), String(body.notes || '').slice(0, 2000)],
  );
  await recordActivity({ record: rows[0], action: 'created', user: req.user, details: 'Device added' });
  res.status(201).json({ device: rows[0] });
});

app.put('/api/devices/:id', authMiddleware, requireAdmin, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'Device id must be a positive integer.' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ message: 'A device object is required.' });
  }

  const fields = ['hostname', 'connection_type', 'device_type', 'location', 'notes', 'owner'];
  for (const field of fields) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return res.status(400).json({ message: `${field} must be a string.` });
    }
  }
  const fieldLimits = { hostname: 255, device_type: 50, location: 255, notes: 2000, owner: 255 };
  for (const [field, maxLength] of Object.entries(fieldLimits)) {
    if (body[field] !== undefined && body[field].length > maxLength) {
      return res.status(400).json({ message: `${field} must be at most ${maxLength} characters.` });
    }
  }
  if (body.hostname !== undefined && (!body.hostname.trim() || body.hostname.length > 255)) {
    return res.status(400).json({ message: 'hostname is required and must be at most 255 characters.' });
  }
  if (body.connection_type !== undefined && !validConnectionType(body.connection_type)) {
    return res.status(400).json({ message: 'connection_type must be wifi, wired, or unknown.' });
  }
  if (body.ip_address !== undefined && body.ip_address !== null && body.ip_address !== '') {
    if (typeof body.ip_address !== 'string' || !isIP(body.ip_address.trim())) {
      return res.status(400).json({ message: 'ip_address must be a valid IP address.' });
    }
  }

  const columns = ['hostname', 'ip_address', 'connection_type', 'device_type', 'location', 'notes', 'owner'];
  const values = [];
  const assignments = columns.map((column) => {
    if (column === 'ip_address') {
      values.push(body.ip_address !== undefined);
      const shouldSet = values.length;
      values.push(body.ip_address?.trim() || null);
      return `ip_address = CASE WHEN $${shouldSet} THEN $${values.length} ELSE ip_address END`;
    }
    values.push(body[column] === undefined ? null : body[column].trim().slice(0, column === 'notes' ? 2000 : column === 'location' ? 255 : column === 'hostname' ? 255 : column === 'owner' ? 255 : 50));
    return `${column} = COALESCE($${values.length}, ${column})`;
  });
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE devices SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length} RETURNING *;`,
    values,
  );
  if (!rows.length) return res.status(404).json({ message: 'Device not found.' });
  await recordActivity({ record: rows[0], action: 'updated', user: req.user, details: 'Device details updated' });
  res.json({ device: rows[0] });
});

app.delete('/api/devices/:id', authMiddleware, requireAdmin, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'Device id must be a positive integer.' });
  const { rows } = await pool.query('DELETE FROM devices WHERE id = $1 RETURNING id, hostname AS name;', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Device not found.' });
  await recordActivity({ record: rows[0], action: 'deleted', user: req.user, details: 'Device removed' });
  res.json({ success: true, id: req.params.id });
});

app.post('/api/scan/report', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ message: 'Scanner API_KEY is not configured on the server.' });
  const suppliedKey = req.get('x-api-key') || '';
  const expected = Buffer.from(API_KEY);
  const received = Buffer.from(suppliedKey);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return res.status(401).json({ message: 'Invalid scanner API key.' });
  }

  const reports = req.body?.devices;
  if (!Array.isArray(reports) || reports.length === 0 || reports.length > 5000) {
    return res.status(400).json({ message: 'devices must be a non-empty array with at most 5000 entries.' });
  }

  const devices = [];
  for (const [index, report] of reports.entries()) {
    const macAddress = normalizeMac(report?.mac_address ?? report?.mac);
    const ipAddress = typeof report?.ip_address === 'string' ? report.ip_address.trim() : '';
    const connectionType = report?.connection_type || 'unknown';
    if (!validMac(macAddress)) return res.status(400).json({ message: `devices[${index}].mac_address is invalid.` });
    if (!isIP(ipAddress)) return res.status(400).json({ message: `devices[${index}].ip_address is invalid.` });
    if (!validConnectionType(connectionType)) return res.status(400).json({ message: `devices[${index}].connection_type is invalid.` });
    const hostname = typeof report.hostname === 'string' ? report.hostname.trim().slice(0, 255) : '';
    const vendor = typeof report.vendor === 'string' ? report.vendor.trim().slice(0, 150) : '';
    devices.push({ macAddress, ipAddress, connectionType, hostname, vendor });
  }

  const client = await pool.connect();
  let connected = 0;
  let reconnected = 0;
  let disconnected = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(78123014);');

    for (const device of devices) {
      const { rows: existingRows } = await client.query(
        'SELECT id, is_online FROM devices WHERE mac_address = $1 FOR UPDATE;',
        [device.macAddress],
      );
      if (!existingRows.length) {
        const { rows } = await client.query(
          `INSERT INTO devices (mac_address, hostname, vendor, ip_address, device_type, connection_type, is_online, auto_discovered, first_seen, last_seen, status)
           VALUES ($1, $2, $3, $4, 'unknown', $5, true, true, NOW(), NOW(), 'online')
           ON CONFLICT (mac_address) WHERE mac_address IS NOT NULL DO NOTHING
           RETURNING id, hostname, ip_address;`,
          [device.macAddress, device.hostname || device.vendor || 'Unknown device', device.vendor || null, device.ipAddress, device.connectionType],
        );
        if (rows.length) {
          await client.query(
            'INSERT INTO connection_logs (device_id, event, ip_address) VALUES ($1, $2, $3);',
            [rows[0].id, 'connected', device.ipAddress],
          );
          connected += 1;
          continue;
        }
      }

      const { rows: currentRows } = existingRows.length
        ? { rows: existingRows }
        : await client.query('SELECT id, is_online FROM devices WHERE mac_address = $1 FOR UPDATE;', [device.macAddress]);
      if (!currentRows.length) throw new Error('Device upsert did not return a device.');

      const wasOffline = !currentRows[0].is_online;
      const { rows } = await client.query(
        `UPDATE devices SET ip_address = $1, last_seen = NOW(), is_online = true, status = 'online'
         WHERE id = $2 RETURNING id;`,
        [device.ipAddress, currentRows[0].id],
      );
      if (wasOffline) {
        await client.query(
          'INSERT INTO connection_logs (device_id, event, ip_address) VALUES ($1, $2, $3);',
          [rows[0].id, 'reconnected', device.ipAddress],
        );
        reconnected += 1;
      }
    }

    const { rows: offlineRows } = await client.query(
      `UPDATE devices SET is_online = false, status = 'offline', updated_at = NOW()
       WHERE is_online = true AND auto_discovered = true AND last_seen < NOW() - INTERVAL '2 minutes'
       RETURNING id, ip_address;`,
    );
    for (const device of offlineRows) {
      await client.query(
        'INSERT INTO connection_logs (device_id, event, ip_address) VALUES ($1, $2, $3);',
        [device.id, 'disconnected', device.ip_address],
      );
    }
    disconnected = offlineRows.length;
    await client.query('COMMIT');
    res.json({ received: devices.length, connected, reconnected, disconnected });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Scanner report failed:', error.message);
    res.status(500).json({ message: 'Unable to process scan report.' });
  } finally {
    client.release();
  }
});

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
    `SELECT id, hostname AS name, ip_address, status, owner, notes, created_at, updated_at
     FROM devices ORDER BY created_at DESC`,
  );
  res.json({ records: rows });
});

app.get('/api/activity', authMiddleware, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, device_id, device_name, action, changed_by_email, details, created_at
     FROM activity_log
     ORDER BY created_at DESC
     LIMIT 250;`,
  );
  res.json({ activity: rows });
});

app.post('/api/records', authMiddleware, requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const ipAddress = req.body?.ip_address ? String(req.body.ip_address).trim() : null;
  const status = req.body?.status || 'active';
  if (!name || name.length > 255) return res.status(400).json({ message: 'Record name is required.' });
  if (ipAddress && !isIP(ipAddress)) return res.status(400).json({ message: 'Enter a valid IP address.' });
  if (!['active', 'online', 'warning', 'offline'].includes(status)) return res.status(400).json({ message: 'Invalid device status.' });

  const { rows } = await pool.query(
    `INSERT INTO devices (hostname, ip_address, status, is_online, owner, notes, auto_discovered)
     VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *;`,
    [name, ipAddress, status, status !== 'offline',
      String(req.body?.owner || 'Unknown').slice(0, 255), String(req.body?.notes || '').slice(0, 2000)],
  );
  await recordActivity({ record: rows[0], action: 'created', user: req.user, details: 'Device added' });
  res.status(201).json({ record: rows[0] });
});

app.put('/api/records/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ message: 'Device id must be a positive integer.' });
  const { name, ip_address: ipAddress, status, owner, notes } = req.body || {};

  if (ipAddress !== undefined && ipAddress !== '' && !isIP(String(ipAddress).trim())) {
    return res.status(400).json({ message: 'Enter a valid IPv4 or IPv6 address.' });
  }

  const { rows } = await pool.query(
    `UPDATE devices
     SET hostname = COALESCE($1, hostname),
         ip_address = CASE WHEN $2 THEN $3 ELSE ip_address END,
         status = COALESCE($4, status),
         is_online = CASE WHEN $4 IS NULL THEN is_online ELSE $5 END,
         owner = COALESCE($6, owner),
         notes = COALESCE($7, notes),
         updated_at = NOW()
     WHERE id = $8
     RETURNING *;`,
    [name?.trim() || null, ipAddress !== undefined, ipAddress?.trim() || null, status || null,
      status ? !['offline', 'warning'].includes(status) : null, owner || null, notes || null, id],
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: 'Record not found.' });
  }

  await recordActivity({
    record: rows[0],
    action: 'updated',
    user: req.user,
    details: 'Device details updated',
  });

  res.json({ record: rows[0] });
});

app.post(['/api/devices/:id/ping', '/api/records/:id/ping'], authMiddleware, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ message: 'Device id must be a positive integer.' });
  const { rows } = await pool.query(
    'SELECT id, ip_address FROM devices WHERE id = $1',
    [id],
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: 'Record not found.' });
  }

  const record = rows[0];
  if (!record.ip_address || !isIP(record.ip_address)) {
    return res.status(400).json({ message: 'Add a valid IP address before checking reachability.' });
  }

  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '3000', record.ip_address]
    : process.platform === 'darwin'
      ? ['-c', '1', '-W', '3000', record.ip_address]
      : ['-c', '1', '-W', '3', record.ip_address];

  let reachable;
  try {
    await execFileAsync('ping', args, { timeout: 4000, windowsHide: true });
    reachable = true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(500).json({ message: 'Ping is unavailable on the server.' });
    }
    reachable = false;
  }

  const status = reachable ? 'online' : 'offline';
  const { rows: updatedRows } = await pool.query(
    `UPDATE devices
     SET status = $1, is_online = $2, last_seen = CASE WHEN $2 THEN NOW() ELSE last_seen END, updated_at = NOW()
     WHERE id = $3
     RETURNING *;`,
    [status, reachable, id],
  );

  await recordActivity({
    record: updatedRows[0],
    action: 'pinged',
    user: req.user,
    details: `Reachability check: ${status}`,
  });

  res.json({ record: updatedRows[0], reachable });
});

app.delete('/api/records/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ message: 'Device id must be a positive integer.' });
  const { rows } = await pool.query(
    'DELETE FROM devices WHERE id = $1 RETURNING id, hostname AS name',
    [id],
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: 'Record not found.' });
  }

  await recordActivity({
    record: rows[0],
    action: 'deleted',
    user: req.user,
    details: 'Device removed',
  });

  res.json({ success: true, id });
});

app.use((error, _req, res, _next) => {
  console.error('API request failed:', error.message);
  if (res.headersSent) return;
  const status = error.code === '23505' ? 409 : error.status || 500;
  const message = error.type === 'entity.parse.failed'
    ? 'Request body must contain valid JSON.'
    : error.code === '23505'
      ? 'That MAC address is already registered.'
      : status < 500
        ? error.message
        : 'The server could not complete the request.';
  res.status(status).json({ message });
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
