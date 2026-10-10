import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const initialForm = {
  name: '',
  ip_address: '',
  mac_address: '',
  status: 'active',
  owner: '',
  device_type: 'unknown',
  connection_type: 'unknown',
  location: '',
  notes: '',
}

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const apiFetch = (path, options) => fetch(`${API_BASE_URL}${path}`, options)

function App() {
  const [credentials, setCredentials] = useState({
    email: 'admin@nettracker.local',
    password: 'Admin123!',
  })
  const [token, setToken] = useState(localStorage.getItem('nettracker_token') || '')
  const [user, setUser] = useState(null)
  const [records, setRecords] = useState([])
  const [users, setUsers] = useState([])
  const [activity, setActivity] = useState([])
  const [connectionLogs, setConnectionLogs] = useState([])
  const [stats, setStats] = useState({ online_now: 0, offline: 0, new_today: 0, connections_today: 0 })
  const [activityLoading, setActivityLoading] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState(0)
  const [page, setPage] = useState('devices')
  const [searchText, setSearchText] = useState('')
  const [onlineFilter, setOnlineFilter] = useState('')
  const [autoFilter, setAutoFilter] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [logEventFilter, setLogEventFilter] = useState('')
  const [logDeviceFilter, setLogDeviceFilter] = useState('')
  const [logFrom, setLogFrom] = useState('')
  const [logTo, setLogTo] = useState('')
  const [subnet, setSubnet] = useState('192.168.1.0/24')
  const [formMessage, setFormMessage] = useState('')
  const [darkMode, setDarkMode] = useState(localStorage.getItem('nettracker_theme') !== 'light')
  const [form, setForm] = useState(initialForm)
  const [editingId, setEditingId] = useState(null)
  const [pingingId, setPingingId] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const isAdmin = user?.role === 'admin'
  const roleBadge = useMemo(() => user?.role?.toUpperCase() || '', [user])

  const loadData = useCallback(async (role, authToken = token, quiet = false) => {
    if (!quiet) setDevicesLoading(true)
    try {
      const headers = { Authorization: `Bearer ${authToken}` }
      const params = new URLSearchParams()
      if (searchText.trim()) params.set('search', searchText.trim())
      if (onlineFilter) params.set('online', onlineFilter)
      if (autoFilter) params.set('auto', 'true')
      if (typeFilter) params.set('connection_type', typeFilter)
      const query = params.size ? `?${params}` : ''
      const [devicesResponse, statsResponse] = await Promise.all([
        apiFetch(`/api/devices${query}`, { headers }),
        apiFetch('/api/stats', { headers }),
      ])
      const devicesPayload = await devicesResponse.json()
      const statsPayload = await statsResponse.json()
      if (!devicesResponse.ok) throw new Error(devicesPayload.message || 'Unable to load devices.')
      if (!statsResponse.ok) throw new Error(statsPayload.message || 'Unable to load device statistics.')
      setRecords(devicesPayload.devices)
      setStats(statsPayload)
      setRefreshedAt(Date.now())

      if (role === 'admin') {
        const usersResponse = await apiFetch('/api/users', { headers })
        const usersPayload = await usersResponse.json()
        if (!usersResponse.ok) throw new Error(usersPayload.message || 'Unable to load users.')
        setUsers(usersPayload.users)
      }
    } finally {
      if (!quiet) setDevicesLoading(false)
    }
  }, [autoFilter, onlineFilter, searchText, token, typeFilter])

  useEffect(() => {
    if (!token) return undefined
    const controller = new AbortController()
    const headers = { Authorization: `Bearer ${token}` }
    apiFetch('/api/auth/me', { headers, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.message || 'Session expired.')
        const [devicesResponse, statsResponse] = await Promise.all([
          apiFetch('/api/devices', { headers, signal: controller.signal }),
          apiFetch('/api/stats', { headers, signal: controller.signal }),
        ])
        const [devicesPayload, statsPayload] = await Promise.all([devicesResponse.json(), statsResponse.json()])
        if (!devicesResponse.ok) throw new Error(devicesPayload.message || 'Unable to load devices.')
        if (!statsResponse.ok) throw new Error(statsPayload.message || 'Unable to load statistics.')
        let users = []
        if (payload.user.role === 'admin') {
          const usersResponse = await apiFetch('/api/users', { headers, signal: controller.signal })
          const usersPayload = await usersResponse.json()
          if (!usersResponse.ok) throw new Error(usersPayload.message || 'Unable to load users.')
          users = usersPayload.users
        }
        return { user: payload.user, devices: devicesPayload.devices, stats: statsPayload, users }
      })
      .then((payload) => {
        if (controller.signal.aborted) return
        setUser(payload.user)
        setRecords(payload.devices)
        setStats(payload.stats)
        setUsers(payload.users)
        setRefreshedAt(Date.now())
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        localStorage.removeItem('nettracker_token')
        setToken('')
        setError(err.message || 'Your session expired. Please log in again.')
      })
    return () => controller.abort()
  }, [token])

  useEffect(() => {
    if (!token || !user) return undefined
    const timer = window.setInterval(() => {
      loadData(user.role, token, true).catch((err) => setError(err.message))
    }, 5000)
    return () => window.clearInterval(timer)
  }, [loadData, token, user])

  async function openActivity() {
    setPage('activity')
    setActivityLoading(true)
    setError('')

    try {
      const response = await apiFetch('/api/activity', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.message || 'Unable to load activity.')
      }

      setActivity(payload.activity)
    } catch (err) {
      setError(err.message)
    } finally {
      setActivityLoading(false)
    }
  }

  const loadConnectionLogs = useCallback(async (quiet = false) => {
    if (!quiet) setLogsLoading(true)
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (logEventFilter) params.set('event', logEventFilter)
      if (logDeviceFilter) params.set('device_id', logDeviceFilter)
      if (logFrom) params.set('from', new Date(`${logFrom}T00:00:00`).toISOString())
      if (logTo) {
        const endDate = new Date(`${logTo}T00:00:00`)
        endDate.setDate(endDate.getDate() + 1)
        params.set('to', endDate.toISOString())
      }
      const response = await apiFetch(`/api/logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || 'Unable to load connection logs.')
      setConnectionLogs(payload.logs)
    } catch (err) {
      setError(err.message)
    } finally {
      if (!quiet) setLogsLoading(false)
    }
  }, [logDeviceFilter, logEventFilter, logFrom, logTo, token])

  function openConnectionLog() {
    setPage('connections')
    loadConnectionLogs()
  }

  useEffect(() => {
    if (page !== 'connections' || !token) return undefined
    const timer = window.setInterval(() => loadConnectionLogs(true), 5000)
    return () => window.clearInterval(timer)
  }, [loadConnectionLogs, page, token])

  async function handleLogin(event) {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })

      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.message || 'Login failed')
      }

      localStorage.setItem('nettracker_token', payload.token)
      setToken(payload.token)
      setUser(payload.user)
      await loadData(payload.user.role, payload.token)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem('nettracker_token')
    setToken('')
    setUser(null)
    setRecords([])
    setUsers([])
    setActivity([])
    setConnectionLogs([])
    setForm(initialForm)
    setEditingId(null)
    setPage('devices')
    setError('')
  }

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()

    if (!isAdmin) {
      setError('Only admins can add or edit access records.')
      return
    }

    setSaving(true)
    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/devices/${editingId}` : '/api/devices'
      const body = {
        hostname: form.name,
        ip_address: form.ip_address,
        mac_address: form.mac_address,
        device_type: form.device_type,
        connection_type: form.connection_type,
        location: form.location,
        owner: form.owner,
        notes: form.notes,
      }

      const response = await apiFetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })

      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.message || 'Unable to save record.')
      }

      setForm(initialForm)
      setEditingId(null)
      setError('')
      setFormMessage('Device saved.')
      await loadData('admin', token)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(recordId) {
    if (!isAdmin) return

    try {
      const response = await apiFetch(`/api/devices/${recordId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const payload = await response.json()
        throw new Error(payload.message || 'Deletion failed.')
      }

      setError('')
      await loadData('admin', token)
    } catch (err) {
      setError(err.message)
    }
  }

  async function handlePing(recordId) {
    setPingingId(recordId)
    setError('')

    try {
      const response = await apiFetch(`/api/devices/${recordId}/ping`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.message || 'Unable to check device reachability.')
      }

      setRecords((current) => current.map((record) => (
        record.id === recordId ? (payload.device || payload.record) : record
      )))
    } catch (err) {
      setError(err.message)
    } finally {
      setPingingId(null)
    }
  }

  function startEdit(record) {
    setEditingId(record.id)
    setForm({
      name: record.hostname || record.name,
      ip_address: record.ip_address || '',
      mac_address: record.mac_address || '',
      status: record.status || (record.is_online ? 'online' : 'offline'),
      owner: record.owner || '',
      device_type: record.device_type || 'unknown',
      connection_type: record.connection_type || 'unknown',
      location: record.location || '',
      notes: record.notes || '',
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(initialForm)
  }

  async function findNextFreeIp() {
    const [address, prefixText] = subnet.trim().split('/')
    const octets = address?.split('.').map(Number)
    const prefix = Number(prefixText)
    if (!octets || octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
        || !Number.isInteger(prefix) || prefix < 16 || prefix > 30) {
      setFormMessage('Enter a valid IPv4 subnet with a prefix from /16 through /30.')
      return
    }

    try {
      const response = await apiFetch('/api/devices', { headers: { Authorization: `Bearer ${token}` } })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || 'Unable to inspect device addresses.')
      const used = new Set(payload.devices.map((device) => device.ip_address).filter(Boolean))
      const ipNumber = octets.reduce((value, part) => ((value << 8) | part) >>> 0, 0)
      const mask = (0xffffffff << (32 - prefix)) >>> 0
      const network = (ipNumber & mask) >>> 0
      const hostCount = 2 ** (32 - prefix)

      for (let offset = 1; offset < hostCount - 1; offset += 1) {
        const candidateNumber = (network + offset) >>> 0
        const candidate = [24, 16, 8, 0].map((shift) => (candidateNumber >>> shift) & 255).join('.')
        if (!used.has(candidate)) {
          updateForm('ip_address', candidate)
          setFormMessage(`Next unassigned inventory address: ${candidate}`)
          return
        }
      }
      setFormMessage('No free address was found in this subnet.')
    } catch (err) {
      setError(err.message)
    }
  }

  function exportCsv() {
    const columns = ['hostname', 'ip_address', 'mac_address', 'vendor', 'device_type', 'connection_type', 'is_online', 'location', 'first_seen', 'last_seen']
    const lines = [columns.join(','), ...records.map((record) => columns.map((column) => {
      const value = String(record[column] ?? '').replaceAll('"', '""')
      return `"${value}"`
    }).join(','))]
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'network-devices.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  function toggleDarkMode() {
    setDarkMode((current) => {
      const next = !current
      localStorage.setItem('nettracker_theme', next ? 'dark' : 'light')
      return next
    })
  }

  if (!user) {
    return (
      <div className={`page-shell ${darkMode ? 'dark-mode' : 'light-mode'}`}>
        <div className="card auth-card">
          <div className="eyebrow">NetTracker</div>
          <h1>Secure access</h1>
          <p className="subtitle">Sign in with your account. Admins can manage records; viewers are read-only.</p>

          <form onSubmit={handleLogin} className="auth-form">
            <label>
              Email
              <input
                type="email"
                value={credentials.email}
                onChange={(event) => setCredentials((current) => ({ ...current, email: event.target.value }))}
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={credentials.password}
                onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
                required
              />
            </label>

            {error && <div className="alert error">{error}</div>}

            <button type="submit" className="primary-button" disabled={loading}>
              {loading ? 'Signing in...' : 'Login'}
            </button>
          </form>

          <div className="demo-credentials">
            <p>Demo accounts</p>
            <ul>
              <li><strong>Admin:</strong> admin@nettracker.local / Admin123!</li>
              <li><strong>Viewer:</strong> viewer@nettracker.local / Viewer123!</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`page-shell ${darkMode ? 'dark-mode' : 'light-mode'}`}>
      <div className="topbar">
        <div>
          <div className="eyebrow">NetTracker</div>
          <h2>Network Device &amp; IP Address Tracker</h2>
        </div>
        <div className="user-summary">
          <span className={`role-pill ${user.role}`}>{roleBadge}</span>
          <span>{user.email}</span>
          <button type="button" className="secondary-button" onClick={toggleDarkMode}>
            {darkMode ? 'Light mode' : 'Dark mode'}
          </button>
          <button type="button" className="secondary-button" onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <nav className="view-tabs" aria-label="Dashboard pages">
        <button type="button" className={page === 'devices' ? 'view-tab selected' : 'view-tab'} aria-current={page === 'devices' ? 'page' : undefined} onClick={() => setPage('devices')}>Devices</button>
        <button type="button" className={page === 'connections' ? 'view-tab selected' : 'view-tab'} aria-current={page === 'connections' ? 'page' : undefined} onClick={openConnectionLog}>Connection log</button>
        <button type="button" className={page === 'activity' ? 'view-tab selected' : 'view-tab'} aria-current={page === 'activity' ? 'page' : undefined} onClick={openActivity}>Activity log</button>
      </nav>

      {page === 'devices' && <>
        <section className="stats-grid" aria-label="Device statistics">
          <article className="card stat-card"><span>Online now</span><strong>{stats.online_now || 0}</strong></article>
          <article className="card stat-card"><span>Offline</span><strong>{stats.offline || 0}</strong></article>
          <article className="card stat-card"><span>New today</span><strong>{stats.new_today || 0}</strong></article>
          <article className="card stat-card"><span>Connections today</span><strong>{stats.connections_today || 0}</strong></article>
        </section>

        <div className="content-grid">
          <section className="card panel">
            <div className="panel-header"><h3>Add device</h3></div>
            <form onSubmit={handleSubmit} className="record-form">
              <label>Hostname<input value={form.name} onChange={(event) => updateForm('name', event.target.value)} disabled={!isAdmin} required={isAdmin} maxLength="255" /></label>
              <label>IP address<input value={form.ip_address} onChange={(event) => updateForm('ip_address', event.target.value)} disabled={!isAdmin} placeholder="192.168.1.20" /></label>
              <label>MAC address<input value={form.mac_address} onChange={(event) => updateForm('mac_address', event.target.value)} disabled={!isAdmin} placeholder="AA:BB:CC:DD:EE:FF" /></label>
              <label>Device type<input value={form.device_type} onChange={(event) => updateForm('device_type', event.target.value)} disabled={!isAdmin} placeholder="unknown, laptop, router..." /></label>
              <label>Connection type<select value={form.connection_type} onChange={(event) => updateForm('connection_type', event.target.value)} disabled={!isAdmin}><option value="unknown">Unknown</option><option value="wifi">WiFi</option><option value="wired">Wired</option></select></label>
              <label>Location<input value={form.location} onChange={(event) => updateForm('location', event.target.value)} disabled={!isAdmin} maxLength="255" /></label>
              <label>Owner<input value={form.owner} onChange={(event) => updateForm('owner', event.target.value)} disabled={!isAdmin} maxLength="255" /></label>
              <label>Notes<textarea value={form.notes} onChange={(event) => updateForm('notes', event.target.value)} disabled={!isAdmin} rows="3" maxLength="2000" /></label>
              <div className="ip-finder">
                <label>Subnet<input value={subnet} onChange={(event) => setSubnet(event.target.value)} disabled={!isAdmin} placeholder="192.168.1.0/24" /></label>
                <button type="button" className="secondary-button" onClick={findNextFreeIp} disabled={!isAdmin}>Find next free IP</button>
              </div>
              {formMessage && <p className="form-message" role="status">{formMessage}</p>}
              <button type="submit" className="primary-button" disabled={!isAdmin || saving}>{saving ? 'Saving...' : 'Add device'}</button>
            </form>
          </section>

          <section className="card panel device-panel">
            <div className="panel-header">
              <h3>Devices</h3>
              <button type="button" className="secondary-button" onClick={exportCsv} disabled={!records.length}>Export CSV</button>
            </div>
            <div className="device-filters">
              <label>Search<input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Hostname, IP, MAC, vendor..." /></label>
              <label>Online<select value={onlineFilter} onChange={(event) => setOnlineFilter(event.target.value)}><option value="">All</option><option value="true">Online</option><option value="false">Offline</option></select></label>
              <label>Connection<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All</option><option value="wifi">WiFi</option><option value="wired">Wired</option><option value="unknown">Unknown</option></select></label>
              <label className="checkbox-label"><input type="checkbox" checked={autoFilter} onChange={(event) => setAutoFilter(event.target.checked)} />Auto-discovered</label>
            </div>
            {devicesLoading ? <p className="empty-state">Loading devices...</p> : records.length === 0 ? <p className="empty-state">No devices match these filters.</p> : (
              <div className="device-table-wrap">
                <table className="device-table">
                  <thead><tr><th>Device</th><th>IP address</th><th>MAC address</th><th>Type / vendor</th><th>Connection</th><th>Status</th><th>Last seen</th><th>Actions</th></tr></thead>
                  <tbody>{records.map((record) => {
                    const isNew = refreshedAt > 0 && record.auto_discovered && refreshedAt - new Date(record.first_seen).getTime() < 10 * 60 * 1000
                    return (
                      <tr key={record.id}>
                        <td><strong>{record.hostname}</strong>{isNew && <span className="new-badge">NEW</span>}<small>{record.location || record.vendor || ' '}</small></td>
                        <td>{record.ip_address || '—'}</td>
                        <td>{record.mac_address || '—'}</td>
                        <td>{record.device_type || 'unknown'}{record.vendor && <small>{record.vendor}</small>}</td>
                        <td><span className={`connection-badge ${record.connection_type || 'unknown'}`}>{record.connection_type || 'unknown'}</span></td>
                        <td><span className={`online-state ${record.is_online ? 'online' : 'offline'}`}><i />{record.is_online ? 'Online' : 'Offline'}</span></td>
                        <td>{record.last_seen ? new Date(record.last_seen).toLocaleString() : 'Never'}</td>
                        <td><div className="row-actions"><button type="button" className="secondary-button" onClick={() => handlePing(record.id)} disabled={pingingId === record.id || !record.ip_address}>{pingingId === record.id ? 'Pinging...' : 'Ping'}</button>{isAdmin && <><button type="button" className="secondary-button" onClick={() => startEdit(record)}>Edit</button><button type="button" className="danger-button" onClick={() => handleDelete(record.id)}>Delete</button></>}</div></td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            )}
          </section>
          {isAdmin && <section className="card panel full-width"><div className="panel-header"><h3>User access</h3></div><div className="users-table">{users.map((member) => <div key={member.id} className="user-row"><span>{member.email}</span><span className={`role-pill ${member.role}`}>{member.role}</span></div>)}</div></section>}
        </div>
      </>}

      {page === 'connections' && <section className="card panel log-panel">
        <div className="panel-header"><h3>Connection log</h3><div className="row-actions"><button type="button" className="secondary-button" onClick={() => loadConnectionLogs()}>Refresh</button>{logsLoading && <span className="loading-note">Refreshing...</span>}</div></div>
        <div className="log-filters">
          <label>Event<select value={logEventFilter} onChange={(event) => setLogEventFilter(event.target.value)}><option value="">All events</option><option value="connected">Connected</option><option value="reconnected">Reconnected</option><option value="disconnected">Disconnected</option></select></label>
          <label>Device<select value={logDeviceFilter} onChange={(event) => setLogDeviceFilter(event.target.value)}><option value="">All devices</option>{records.map((record) => <option key={record.id} value={record.id}>{record.hostname}</option>)}</select></label>
          <label>From<input type="date" value={logFrom} onChange={(event) => setLogFrom(event.target.value)} /></label>
          <label>To<input type="date" value={logTo} onChange={(event) => setLogTo(event.target.value)} /></label>
        </div>
        {logsLoading && connectionLogs.length === 0 ? <p className="empty-state">Loading connection log...</p> : connectionLogs.length === 0 ? <p className="empty-state">No connection events match these filters.</p> : (
          <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>When</th><th>Event</th><th>Device</th><th>IP address</th></tr></thead><tbody>{connectionLogs.map((entry) => <tr key={entry.id}><td>{new Date(entry.created_at).toLocaleString()}</td><td><span className={`activity-action ${entry.event}`}>{entry.event}</span></td><td>{entry.hostname || `Device #${entry.device_id}`}</td><td>{entry.ip_address || '—'}</td></tr>)}</tbody></table></div>
        )}
      </section>}

      {page === 'activity' && <section className="card panel log-panel">
        <div className="panel-header"><h3>Activity log</h3>{activityLoading && <span className="loading-note">Loading...</span>}</div>
        {activity.length === 0 ? <p className="empty-state">No device activity recorded yet.</p> : (
          <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>When</th><th>Device</th><th>Action</th><th>Changed by</th><th>Details</th></tr></thead><tbody>{activity.map((entry) => <tr key={entry.id}><td>{new Date(entry.created_at).toLocaleString()}</td><td>{entry.device_name} <span className="device-id">#{entry.device_id}</span></td><td><span className={`activity-action ${entry.action}`}>{entry.action}</span></td><td>{entry.changed_by_email}</td><td>{entry.details}</td></tr>)}</tbody></table></div>
        )}
      </section>}

      {editingId && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelEdit() }}>
        <section className="card edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-device-heading">
          <div className="panel-header"><h3 id="edit-device-heading">Edit device</h3><button type="button" className="link-button" onClick={cancelEdit}>Close</button></div>
          <form onSubmit={handleSubmit} className="record-form modal-form">
            <label>Hostname<input value={form.name} onChange={(event) => updateForm('name', event.target.value)} required maxLength="255" /></label>
            <label>IP address<input value={form.ip_address} onChange={(event) => updateForm('ip_address', event.target.value)} /></label>
            <label>MAC address<input value={form.mac_address} disabled /></label>
            <label>Device type<input value={form.device_type} onChange={(event) => updateForm('device_type', event.target.value)} maxLength="50" /></label>
            <label>Connection type<select value={form.connection_type} onChange={(event) => updateForm('connection_type', event.target.value)}><option value="unknown">Unknown</option><option value="wifi">WiFi</option><option value="wired">Wired</option></select></label>
            <label>Location<input value={form.location} onChange={(event) => updateForm('location', event.target.value)} maxLength="255" /></label>
            <label>Owner<input value={form.owner} onChange={(event) => updateForm('owner', event.target.value)} maxLength="255" /></label>
            <label>Notes<textarea value={form.notes} onChange={(event) => updateForm('notes', event.target.value)} rows="3" maxLength="2000" /></label>
            <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</button>
          </form>
        </section>
      </div>}
    </div>
  )
}

export default App
