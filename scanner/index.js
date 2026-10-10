const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const axios = require('axios');
const dotenv = require('dotenv');
const { parseStringPromise } = require('xml2js');

dotenv.config({ path: path.join(__dirname, '.env') });

const execFileAsync = promisify(execFile);
const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');
const apiKey = process.env.API_KEY || '';
const subnet = process.env.SUBNET || '';
const intervalSeconds = Number.parseInt(process.env.INTERVAL_SECONDS || '30', 10);
let scanRunning = false;

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeMac(value) {
  return typeof value === 'string' ? value.trim().replaceAll('-', ':').toUpperCase() : '';
}

function validMac(value) {
  return /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value);
}

function connectionType(interfaceName) {
  if (/wi-?fi|wlan|wireless/i.test(interfaceName)) return 'wifi';
  if (/ethernet|^eth|^en/i.test(interfaceName)) return 'wired';
  return 'unknown';
}

function parseNmap(document) {
  const hosts = asArray(document?.nmaprun?.host);
  const discovered = [];

  for (const host of hosts) {
    if (host?.status?.$?.state !== 'up') continue;
    const addresses = asArray(host.address);
    const ip = addresses.find((address) => ['ipv4', 'ipv6'].includes(address?.$?.addrtype))?.$?.addr;
    const macAddress = normalizeMac(addresses.find((address) => address?.$?.addrtype === 'mac')?.$?.addr);
    const mac = addresses.find((address) => address?.$?.addrtype === 'mac')?.$;
    const hostname = asArray(host.hostnames?.hostname)
      .map((entry) => entry?.$?.name)
      .find((name) => typeof name === 'string' && name.trim());

    if (ip && validMac(macAddress)) {
      discovered.push({
        ip_address: ip,
        mac_address: macAddress,
        vendor: typeof mac?.vendor === 'string' ? mac.vendor : '',
        hostname: hostname || '',
        connection_type: 'unknown',
      });
    }
  }
  return discovered;
}

function parseArp(output) {
  const discovered = [];
  const lines = output.split(/\r?\n/);
  const patterns = [
    /^\s*([0-9.]+)\s+([0-9a-f-]{17})\s+(?:dynamic|static|permanent)?\s*$/i,
    /\(([^)]+)\)\s+at\s+([0-9a-f:]{17})/i,
  ];

  for (const line of lines) {
    const match = patterns.map((pattern) => line.match(pattern)).find(Boolean);
    if (!match) continue;
    const ip = match[1];
    const macAddress = normalizeMac(match[2]);
    if (validMac(macAddress)) {
      discovered.push({
        ip_address: ip,
        mac_address: macAddress,
        vendor: '',
        hostname: '',
        connection_type: 'unknown',
      });
    }
  }
  return discovered;
}

function localInterfaces() {
  const discovered = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const macAddress = normalizeMac(address.mac);
      if (address.internal || !address.address || !validMac(macAddress)) continue;
      discovered.push({
        ip_address: address.address,
        mac_address: macAddress,
        vendor: '',
        hostname: os.hostname(),
        connection_type: connectionType(name),
      });
    }
  }
  return discovered;
}

async function discoverHosts() {
  let discovered;
  try {
    if (!subnet) throw new Error('SUBNET is not configured.');
    const { stdout } = await execFileAsync('nmap', ['-sn', '-oX', '-', subnet], {
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = await parseStringPromise(stdout, { explicitArray: false });
    discovered = parseNmap(parsed);
  } catch (error) {
    console.error(`nmap scan failed; falling back to arp -a: ${error.message}`);
    try {
      const { stdout } = await execFileAsync('arp', ['-a'], {
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      });
      discovered = parseArp(stdout);
    } catch (arpError) {
      console.error(`arp fallback failed: ${arpError.message}`);
      discovered = [];
    }
  }

  const unique = new Map();
  for (const device of [...discovered, ...localInterfaces()]) {
    const key = normalizeMac(device.mac_address);
    if (validMac(key)) unique.set(key, { ...device, mac_address: key });
  }
  return [...unique.values()];
}

async function scanAndReport() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    if (!apiUrl || !apiKey) {
      console.error('Set API_URL and API_KEY in scanner/.env before scanning.');
      return;
    }
    const devices = await discoverHosts();
    if (devices.length === 0) {
      console.warn('No hosts with a discoverable MAC address were found.');
      return;
    }
    const response = await axios.post(`${apiUrl}/api/scan/report`, { devices }, {
      headers: { 'x-api-key': apiKey },
      timeout: 20000,
    });
    console.log(`Reported ${devices.length} devices: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error(`Scan cycle failed: ${error.response?.data?.message || error.message}`);
  } finally {
    scanRunning = false;
  }
}

if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
  console.error('INTERVAL_SECONDS must be a positive integer.');
  process.exitCode = 1;
} else {
  console.log(`NetTracker scanner polling ${subnet || '(no subnet configured)'} every ${intervalSeconds}s.`);
  scanAndReport();
  const timer = setInterval(scanAndReport, intervalSeconds * 1000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}