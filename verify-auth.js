const baseUrl = 'http://localhost:3001';

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const payload = await response.json();
  return { response, payload };
}

(async () => {
  const admin = await login('admin@nettracker.local', 'Admin123!');
  const viewer = await login('viewer@nettracker.local', 'Viewer123!');

  if (!admin.response.ok || !viewer.response.ok) {
    throw new Error('Login verification failed');
  }

  const viewerDenied = await fetch(`${baseUrl}/api/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${viewer.payload.token}`,
    },
    body: JSON.stringify({
      name: 'Forbidden record',
      status: 'active',
      owner: 'Viewer',
      notes: 'Should fail',
    }),
  });

  if (viewerDenied.status !== 403) {
    throw new Error(`Viewer was not blocked; status=${viewerDenied.status}`);
  }

  const createResponse = await fetch(`${baseUrl}/api/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${admin.payload.token}`,
    },
    body: JSON.stringify({
      name: 'Edge Switch 7',
      status: 'warning',
      owner: 'Ops',
      notes: 'Needs replacement',
    }),
  });

  const created = await createResponse.json();
  if (!createResponse.ok) {
    throw new Error(`Admin create failed: ${JSON.stringify(created)}`);
  }

  const updateResponse = await fetch(`${baseUrl}/api/records/${created.record.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${admin.payload.token}`,
    },
    body: JSON.stringify({ status: 'offline', notes: 'Updated by admin' }),
  });

  const updated = await updateResponse.json();
  if (!updateResponse.ok) {
    throw new Error(`Admin update failed: ${JSON.stringify(updated)}`);
  }

  const deleteResponse = await fetch(`${baseUrl}/api/records/${created.record.id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${admin.payload.token}`,
    },
  });

  const deleted = await deleteResponse.json();
  if (!deleteResponse.ok) {
    throw new Error(`Admin delete failed: ${JSON.stringify(deleted)}`);
  }

  console.log('AUTH_OK', admin.payload.user.role, viewer.payload.user.role);
  console.log('VIEWER_FORBIDDEN', viewerDenied.status);
  console.log('CRUD_OK', created.record.id, updated.record.status, deleted.success);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
