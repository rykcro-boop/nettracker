BEGIN;

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  hostname VARCHAR(255) NOT NULL DEFAULT 'Unknown device',
  ip_address VARCHAR(45),
  mac_address VARCHAR(17),
  device_type VARCHAR(50) DEFAULT 'unknown',
  connection_type VARCHAR(20) DEFAULT 'unknown',
  is_online BOOLEAN DEFAULT false,
  auto_discovered BOOLEAN DEFAULT false,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP,
  location VARCHAR(255),
  owner VARCHAR(255),
  notes TEXT,
  status VARCHAR(50) DEFAULT 'offline',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS hostname VARCHAR(255) DEFAULT 'Unknown device';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS vendor VARCHAR(150);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS connection_type VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS auto_discovered BOOLEAN DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS first_seen TIMESTAMP DEFAULT NOW();
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_type VARCHAR(50) DEFAULT 'unknown';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS owner VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'offline';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE devices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE devices ALTER COLUMN device_type SET DEFAULT 'unknown';
ALTER TABLE devices ALTER COLUMN connection_type SET DEFAULT 'unknown';
ALTER TABLE devices ALTER COLUMN is_online SET DEFAULT false;
ALTER TABLE devices ALTER COLUMN auto_discovered SET DEFAULT false;
ALTER TABLE devices ALTER COLUMN first_seen SET DEFAULT NOW();

DO $drop_ip_unique$
DECLARE
  ip_column SMALLINT;
  unique_constraint RECORD;
BEGIN
  SELECT attnum INTO ip_column
  FROM pg_attribute
  WHERE attrelid = 'devices'::regclass AND attname = 'ip_address' AND NOT attisdropped;

  FOR unique_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'devices'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[ip_column]::SMALLINT[]
  LOOP
    EXECUTE format('ALTER TABLE devices DROP CONSTRAINT %I', unique_constraint.conname);
  END LOOP;
END
$drop_ip_unique$;

CREATE UNIQUE INDEX IF NOT EXISTS devices_mac_unique
  ON devices(mac_address)
  WHERE mac_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS connection_logs (
  id SERIAL PRIMARY KEY,
  device_id INT REFERENCES devices(id) ON DELETE CASCADE,
  event VARCHAR(20) NOT NULL,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS connection_logs_created_at_idx ON connection_logs(created_at DESC);

DO $import_legacy_records$
BEGIN
  IF to_regclass('public.tracked_records') IS NOT NULL THEN
    EXECUTE $import$
      INSERT INTO devices (id, hostname, ip_address, owner, notes, status, is_online, auto_discovered, first_seen, created_at, updated_at)
      SELECT id,
             COALESCE(NULLIF(name, ''), 'Unknown device'),
             ip_address,
             owner,
             notes,
             status,
             lower(COALESCE(status, '')) IN ('online', 'active'),
             false,
             created_at,
             created_at,
             updated_at
      FROM tracked_records
      ON CONFLICT (id) DO NOTHING
    $import$;
  END IF;
END
$import_legacy_records$;

SELECT setval(
  pg_get_serial_sequence('devices', 'id'),
  GREATEST(COALESCE((SELECT MAX(id) FROM devices), 1), 1),
  EXISTS (SELECT 1 FROM devices)
);

COMMIT;