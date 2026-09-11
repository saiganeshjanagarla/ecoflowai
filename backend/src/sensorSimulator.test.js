const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const store = require('./store');
const simulator = require('./sensorSimulator');

test('simulator generates bounded, correlated simulated telemetry for existing bins', () => {
  const bin = store.bins.find(item => item.id === 'HYG-001');
  const before = simulator.states.get(bin.id);
  const reading = simulator.generateTelemetry(bin, new Date('2026-09-11T08:00:00.000Z'));
  assert.equal(reading.binId, bin.id);
  assert.match(reading.sensorId, /^SIM-HYG-001$/);
  assert.equal(reading.source, 'SIMULATED');
  assert.ok(reading.fillLevel >= 0 && reading.fillLevel <= 100);
  assert.ok(reading.weightKg > 0);
  assert.ok(Number.isFinite(reading.temperature));
  assert.ok(Date.parse(reading.timestamp));
  assert.ok(!before || reading.fillLevel >= before.fill);
});

test('simulator scenario controls validate and remain safe to start and stop', () => {
  const previous = process.env.SENSOR_SIMULATOR_ENABLED;
  try {
    process.env.SENSOR_SIMULATOR_ENABLED = 'false';
    assert.equal(simulator.startSensorSimulator(), false);
    assert.equal(simulator.isRunning(), false);
    simulator.setScenario('CRITICAL');
    assert.equal(simulator.getScenario(), 'CRITICAL');
    assert.throws(() => simulator.setScenario('UNKNOWN'), /Unsupported/);
    assert.equal(simulator.stopSensorSimulator(), false);
  } finally {
    if (previous === undefined) delete process.env.SENSOR_SIMULATOR_ENABLED; else process.env.SENSOR_SIMULATOR_ENABLED = previous;
    simulator.setScenario('NORMAL');
  }
});

test('simulator emits one reading per existing bin without creating bins', async () => {
  const originalScenario = simulator.getScenario();
  const originalBins = store.bins.length;
  const sent = [];
  simulator.setTelemetrySender(async payload => { sent.push(payload); return { accepted: true }; });
  try {
    simulator.setScenario('NORMAL');
    await simulator.runCycle();
    assert.equal(sent.length, originalBins);
    assert.equal(new Set(sent.map(item => item.binId)).size, originalBins);
    assert.equal(store.bins.length, originalBins);
    assert.ok(sent.every(item => item.source === 'SIMULATED' && item.sensorId));
  } finally {
    simulator.setTelemetrySender();
    simulator.setScenario(originalScenario);
  }
});

test('simulator submits telemetry through the POST /api/telemetry path', async () => {
  const previousPort = process.env.PORT;
  const received = [];
  const endpoint = http.createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/telemetry');
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { received.push(JSON.parse(body)); response.writeHead(201, { 'Content-Type': 'application/json' }); response.end('{"accepted":true}'); });
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  try {
    process.env.PORT = String(endpoint.address().port);
    const result = await simulator.requestTelemetry({ binId: 'HYG-001', sensorId: 'SIM-HYG-001', fillLevel: 78, weightKg: 75, temperature: 31, timestamp: new Date().toISOString(), source: 'SIMULATED' });
    assert.equal(result.accepted, true);
    assert.equal(received[0].sensorId, 'SIM-HYG-001');
  } finally {
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    await new Promise(resolve => endpoint.close(resolve));
  }
});