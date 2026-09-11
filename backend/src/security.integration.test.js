const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 4600 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}/api`;
const validPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAF';
let processHandle;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function login(email, password = '123456') {
  const result = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await fetch(`${baseUrl}/health`);
      if (result.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Security integration server did not start.');
}

test.before(async () => {
  processHandle = spawn(process.execPath, ['src/server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), AI_AUTOMATION_ENABLED: 'false', SENSOR_SIMULATOR_ENABLED: 'false' },
    stdio: 'ignore'
  });
  await waitForServer();
});

test.after(() => processHandle?.kill());

test('RBAC, IDOR, city isolation, telemetry, and image validation are enforced at the API', async () => {
  const viewer = await login('user@gmail.com');
  const citizen = await login('citizen@gmail.com');
  const admin = await login('saiganesh@gmail.com', 'ultron2026');
  const operator = await login('bhanu@gmail.com', 'ultron2026');

  for (const path of ['/reports', '/incidents', '/ai/status', '/telemetry/HYG-001', '/bins', '/vehicles', '/drivers', '/routes', '/collections', '/agent/query']) {
    const result = await request(path, { method: path === '/agent/query' ? 'POST' : 'GET', headers: auth(viewer), body: path === '/agent/query' ? JSON.stringify({ query: 'dispatch HYG-001' }) : undefined });
    assert.equal(result.response.status, 403, `viewer should be denied ${path}`);
  }
  const citizenAgent = await request('/agent/query', { method: 'POST', headers: auth(citizen), body: JSON.stringify({ query: 'dispatch HYG-001' }) });
  assert.equal(citizenAgent.response.status, 403);

  const fleet = await request('/vehicles', { headers: auth(admin) });
  assert.equal(fleet.response.status, 200);
  for (const vehicle of fleet.body) {
    await request(`/vehicles/${vehicle.id}`, { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ status: 'MAINTENANCE' }) });
  }
  const report = await request('/public-reports', {
    method: 'POST',
    headers: auth(viewer),
    body: JSON.stringify({ issueType: 'OTHER_WASTE_ISSUE', photo: validPng, latitude: 17.3900, longitude: 78.3147, binId: 'HYG-023', description: 'API security test', reporterId: 'FORGED', reporterEmail: 'forged@example.com' })
  });
  assert.equal(report.response.status, 201);
  assert.equal(report.body.data.reporterId, 'U-003');
  assert.equal(report.body.data.reporterEmail, 'user@gmail.com');
  for (const vehicle of fleet.body) {
    await request(`/vehicles/${vehicle.id}`, { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ status: vehicle.status }) });
  }
  const own = await request('/public-reports?mine=true', { headers: auth(viewer) });
  assert.equal(own.response.status, 200);
  const idor = await request(`/public-reports/${report.body.data.id}`, { headers: auth(citizen) });
  assert.equal(idor.response.status, 403);

  const wrongImage = await request('/public-reports', { method: 'POST', headers: auth(viewer), body: JSON.stringify({ issueType: 'OTHER_WASTE_ISSUE', photo: 'data:image/png;base64,' + Buffer.from('not an image').toString('base64'), latitude: 17.44, longitude: 78.35 }) });
  assert.equal(wrongImage.response.status, 400);

  const changeWorkspace = await request('/auth/profile', { method: 'PATCH', headers: auth(operator), body: JSON.stringify({ workspace: 'Warangal Operations' }) });
  assert.equal(changeWorkspace.response.status, 200);
  const adminWorkspace = await request('/auth/profile', { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ workspace: 'Warangal Operations' }) });
  assert.equal(adminWorkspace.response.status, 200);
  const wrongBinMutation = await request('/bins/HYG-001', { method: 'PATCH', headers: auth(operator), body: JSON.stringify({ fill: 10 }) });
  assert.ok([403, 404].includes(wrongBinMutation.response.status));
  const validTelemetry = await request('/telemetry', { method: 'POST', headers: auth(operator), body: JSON.stringify({ binId: 'WYG-001', fillLevel: 50, weightKg: 10, timestamp: new Date().toISOString(), sensorId: 'TEST-WAR-001' }) });
  assert.equal(validTelemetry.response.status, 201);
  const wrongCityTelemetry = await request('/telemetry', { method: 'POST', headers: auth(operator), body: JSON.stringify({ binId: 'HYG-001', fillLevel: 50, weightKg: 10, timestamp: new Date().toISOString(), sensorId: 'TEST-HYD-001' }) });
  assert.equal(wrongCityTelemetry.response.status, 400);
  const invalidFill = await request('/telemetry', { method: 'POST', headers: auth(operator), body: JSON.stringify({ binId: 'WYG-001', fillLevel: 101, weightKg: 10, timestamp: new Date().toISOString() }) });
  assert.equal(invalidFill.response.status, 400);

  const adminReports = await request('/reports', { headers: auth(admin) });
  assert.equal(adminReports.response.status, 200);
  await request('/auth/profile', { method: 'PATCH', headers: auth(operator), body: JSON.stringify({ workspace: 'Hyderabad Operations' }) });
  await request('/auth/profile', { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ workspace: 'Hyderabad Operations' }) });
});
