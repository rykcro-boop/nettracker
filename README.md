# Network Device & IP Address Tracker

NetTracker tracks manually managed and automatically discovered network devices. It includes authenticated device management, search and filters, online statistics, CSV export, dark mode, free-IP suggestions, a connection log, and an audit log.

## Requirements

- Node.js 20 or newer
- PostgreSQL, such as Neon
- Nmap on the machine running the scanner

Install Nmap on Windows from [nmap.org/download.html](https://nmap.org/download.html) and include Npcap during installation. For MAC-address discovery, open the scanner terminal as Administrator. On Debian or Ubuntu, install it with `sudo apt install nmap`; on macOS, use `brew install nmap`.

MAC addresses are normally visible only on the scanner's local layer-2 network. Scanning a different subnet, a guest WiFi network, or a network that filters discovery traffic can limit results. The scanner falls back to the local ARP cache when Nmap is unavailable.

## Configuration

From the repository root, copy the example files:

```powershell
Copy-Item server/.env.example server/.env
Copy-Item scanner/.env.example scanner/.env
```

Set these server values in `server/.env` (or the existing root `.env.local`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign login tokens |
| `API_KEY` | Shared secret required by the local scanner |
| `PORT` | Optional API port; defaults to `3001` |

Set these values in `scanner/.env`:

| Variable | Purpose |
| --- | --- |
| `API_URL` | API origin, such as `http://localhost:3001` |
| `API_KEY` | Must exactly match the server's `API_KEY` |
| `SUBNET` | CIDR range to scan, such as `192.168.1.0/24` |
| `INTERVAL_SECONDS` | Scan frequency; defaults to `30` |

The free-IP helper searches addresses already present in the device inventory. It does not reserve an address in DHCP or guarantee that an untracked device is not using it.

## Run Locally

Install dependencies and apply the database migration once:

```powershell
npm install
npm --prefix client install
npm --prefix scanner install
node server/migrate.js
```

Then start each part in a separate terminal, in this order:

```powershell
# Terminal 1: API server, from the repository root
npm run dev
```

```powershell
# Terminal 2: scanner, from the repository root
Push-Location scanner
npm start
Pop-Location
```

```powershell
# Terminal 3: client, from the repository root
Push-Location client
npm run dev
Pop-Location
```

Open the Vite URL printed by the client, normally `http://localhost:5173`. For a production-style server process, use `npm start` in the repository root instead of `npm run dev`.

## Deploy

1. **Database:** Create a Neon PostgreSQL database and provide its connection string as `DATABASE_URL`. Run `node server/migrate.js` against that database before starting the API.
2. **API:** Deploy the repository root to Render with start command `npm start`. Configure `DATABASE_URL`, a strong `JWT_SECRET`, and `API_KEY` in Render's environment settings. The API listens on Render's `PORT`.
3. **Client:** Deploy the existing `client` directory to Vercel with build command `npm run build`, output directory `dist`, and `VITE_API_URL` set to the Render API origin (for example, `https://your-service.onrender.com`, without `/api`).
4. **Scanner:** Keep the scanner running on the local PC. Set `API_URL` in `scanner/.env` to the Render URL and use the same `API_KEY` configured on Render. Configure the local subnet and run the scanner terminal as Administrator on Windows for MAC detection.

The scanner must be able to reach the configured subnet and the Render API. Keep the API key private; do not commit `.env` files.