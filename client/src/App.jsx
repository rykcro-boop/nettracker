import { useEffect, useMemo, useState } from 'react'
import './App.css'

const initialForm = {
  name: '',
  status: 'active',
  owner: '',
  notes: '',
}

function App() {
  const [credentials, setCredentials] = useState({
    email: 'admin@nettracker.local',
    password: 'Admin123!',
  })
  const [token, setToken] = useState(localStorage.getItem('nettracker_token') || '')
  const [user, setUser] = useState(null)
  const [records, setRecords] = useState([])
  const [users, setUsers] = useState([])
  const [form, setForm] = useState(initialForm)
  const [editingId, setEditingId] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const isAdmin = user?.role === 'admin'
  const roleBadge = useMemo(() => user?.role?.toUpperCase() || '', [user])

  useEffect(() => {
    if (!token) {
      setUser(null)
      setRecords([])
      setUsers([])
      return
    }

    loadSession()
  }, [token])

  async function loadSession() {
    try {
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        throw new Error('Session expired')
      }

      const payload = await response.json()
      setUser(payload.user)
      await loadData(payload.user.role)
    } catch (err) {
      setToken('')
      localStorage.removeItem('nettracker_token')
      setError('Your session expired. Please log in again.')
    }
  }

  async function loadData(role, authToken = token) {
    const headers = { Authorization: `Bearer ${authToken}` }

    const recordsResponse = await fetch('/api/records', { headers })
    if (!recordsResponse.ok) {
      throw new Error('Unable to load records.')
    }
    const recordsPayload = await recordsResponse.json()
    setRecords(recordsPayload.records)

    if (role === 'admin') {
      const usersResponse = await fetch('/api/users', { headers })
      if (!usersResponse.ok) {
        throw new Error('Unable to load users.')
      }
      const usersPayload = await usersResponse.json()
      setUsers(usersPayload.users)
    }
  }

  async function handleLogin(event) {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await fetch('/api/auth/login', {
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
    setForm(initialForm)
    setEditingId(null)
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

    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/records/${editingId}` : '/api/records'

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(form),
      })

      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.message || 'Unable to save record.')
      }

      setForm(initialForm)
      setEditingId(null)
      setError('')
      await loadData('admin', token)
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDelete(recordId) {
    if (!isAdmin) return

    try {
      const response = await fetch(`/api/records/${recordId}`, {
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

  function startEdit(record) {
    setEditingId(record.id)
    setForm({
      name: record.name,
      status: record.status,
      owner: record.owner,
      notes: record.notes,
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(initialForm)
  }

  if (!user) {
    return (
      <div className="page-shell">
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
    <div className="page-shell">
      <div className="topbar">
        <div>
          <div className="eyebrow">NetTracker</div>
          <h2>Network operations dashboard</h2>
        </div>
        <div className="user-summary">
          <span className={`role-pill ${user.role}`}>{roleBadge}</span>
          <span>{user.email}</span>
          <button type="button" className="secondary-button" onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="content-grid">
        <section className="card panel">
          <div className="panel-header">
            <h3>{editingId ? 'Edit record' : 'Add record'}</h3>
            {editingId && <button type="button" className="link-button" onClick={cancelEdit}>Cancel</button>}
          </div>

          <form onSubmit={handleSubmit} className="record-form">
            <label>
              Name
              <input
                value={form.name}
                onChange={(event) => updateForm('name', event.target.value)}
                disabled={!isAdmin}
                required={isAdmin}
              />
            </label>

            <label>
              Status
              <select value={form.status} onChange={(event) => updateForm('status', event.target.value)} disabled={!isAdmin}>
                <option value="active">Active</option>
                <option value="warning">Warning</option>
                <option value="offline">Offline</option>
              </select>
            </label>

            <label>
              Owner
              <input
                value={form.owner}
                onChange={(event) => updateForm('owner', event.target.value)}
                disabled={!isAdmin}
              />
            </label>

            <label>
              Notes
              <textarea
                value={form.notes}
                onChange={(event) => updateForm('notes', event.target.value)}
                disabled={!isAdmin}
                rows="4"
              />
            </label>

            <button type="submit" className="primary-button" disabled={!isAdmin}>
              {editingId ? 'Save changes' : 'Add record'}
            </button>
          </form>
        </section>

        <section className="card panel">
          <div className="panel-header">
            <h3>Tracked records</h3>
          </div>

          <div className="records-list">
            {records.map((record) => (
              <article key={record.id} className="record-item">
                <div className="record-header">
                  <h4>{record.name}</h4>
                  <span className={`status-badge ${record.status}`}>{record.status}</span>
                </div>
                <p><strong>Owner:</strong> {record.owner || 'Unknown'}</p>
                <p><strong>Notes:</strong> {record.notes || 'No notes available.'}</p>

                {isAdmin && (
                  <div className="row-actions">
                    <button type="button" className="secondary-button" onClick={() => startEdit(record)}>Edit</button>
                    <button type="button" className="danger-button" onClick={() => handleDelete(record.id)}>Delete</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        {isAdmin && (
          <section className="card panel full-width">
            <div className="panel-header">
              <h3>User access</h3>
            </div>
            <div className="users-table">
              {users.map((member) => (
                <div key={member.id} className="user-row">
                  <span>{member.email}</span>
                  <span className={`role-pill ${member.role}`}>{member.role}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export default App
