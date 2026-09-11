const http = require('http');
const store = require('./store');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_SCENARIO = 'NORMAL';
const VALID_SCENARIOS = new Set(['NORMAL', 'HIGH_FILL', 'RAPID_FILL', 'CRITICAL', 'SENSOR_FAILURE']);

let timer = null;
let scenario = String(process.env.SENSOR_SIMULATOR_MODE || process.env.SENSOR_SIMULATOR_SCENARIO || DEFAULT_SCENARIO).toUpperCase();
let sequence = 0;
const states = new Map();
let telemetrySender = requestTelemetry;

function getIntervalMs() { return Math.max(1000, Number(process.env.SENSOR_SIMULATOR_INTERVAL_MS) || DEFAULT_INTERVAL_MS); }
function getScenario() { return VALID_SCENARIOS.has(scenario) ? scenario : DEFAULT_SCENARIO; }
function selectedBinId() { return process.env.SENSOR_SIMULATOR_BIN || 'HYG-001'; }
function setScenario(nextScenario) {
  const normalized = String(nextScenario || '').toUpperCase();
  if (!VALID_SCENARIOS.has(normalized)) throw new Error(`Unsupported sensor scenario: ${nextScenario}`);
  scenario = normalized;
  return scenario;
}
function stateFor(bin, index) {
  if (!states.has(bin.id)) states.set(bin.id, { fill: Number(bin.fill || 0), index, eventTicks: 0 });
  return states.get(bin.id);
}

function generateTelemetry(bin, now = new Date()) {
  const index = Number(bin.id.replace(/^(HYG|WYG)-/, '')) - 1;
  const state = stateFor(bin, index);
  const hour = now.getHours();
  const weekdayFactor = [0.78, 0.94, 1, 1.06, 1.22, 1.3, 0.88][now.getDay()];
  const timeFactor = hour >= 7 && hour <= 10 ? 1.25 : hour >= 17 && hour <= 21 ? 1.2 : hour >= 11 && hour <= 15 ? 1.05 : 0.72;
  const baseRate = 0.35 + (index % 5) * 0.16;
  const highFillBoost = getScenario() === 'HIGH_FILL' ? 0.8 : 0;
  const selected = bin.id === selectedBinId();
  const criticalBoost = getScenario() === 'CRITICAL' && selected ? 4.2 : 0;
  const rapidBoost = getScenario() === 'RAPID_FILL' && selected ? 3.2 : 0;
  const eventBoost = state.eventTicks > 0 ? 1.8 : 0;
  const variation = ((sequence + index * 7) % 5 - 2) * 0.08;
  const increment = Math.max(0.15, baseRate * weekdayFactor * timeFactor + highFillBoost + criticalBoost + rapidBoost + eventBoost + variation);
  state.fill = Math.min(100, Number((state.fill + increment).toFixed(1)));
  state.eventTicks = state.eventTicks > 0 ? state.eventTicks - 1 : ((sequence + index) % 23 === 0 ? 2 : 0);
  const capacityKg = Math.max(50, Number(bin.capacity || 240) * 0.42);
  const weightKg = Math.max(1, Number((capacityKg * (state.fill / 100) + ((sequence + index) % 5 - 2) * 0.35).toFixed(1)));
  const seasonalTemperature = 29 + Math.sin((hour - 6) / 24 * Math.PI * 2) * 4;
  const temperature = Number((seasonalTemperature + (index % 4) * 0.45 + ((sequence + index) % 3 - 1) * 0.25).toFixed(1));
  return { binId: bin.id, sensorId: `SIM-${bin.id}`, fillLevel: state.fill, weight: weightKg, weightKg, temperature, timestamp: now.toISOString(), source: 'SIMULATED', dataSource: 'SIMULATED' };
}

function requestTelemetry(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: process.env.SENSOR_SIMULATOR_HOST || '127.0.0.1', port: Number(process.env.PORT) || 4000, path: '/api/telemetry', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${process.env.SENSOR_SIMULATOR_TOKEN || ''}` } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`Telemetry rejected (${response.statusCode}): ${data}`)));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function runCycle() {
  sequence += 1;
  const readings = [];
  const simulatedBins = store.bins;
  for (const [index, bin] of simulatedBins.entries()) {
    if (getScenario() === 'SENSOR_FAILURE' && bin.id === selectedBinId()) continue;
    const payload = generateTelemetry(bin);
    await telemetrySender(payload);
    readings.push(payload);
    if (readings.length === 1 || readings.length === simulatedBins.length - 1) console.log(`[SENSOR SIM] ${bin.id} | fill=${payload.fillLevel}% | weight=${payload.weightKg}kg | temp=${payload.temperature}C`);
  }
  return readings;
}

function startSensorSimulator() {
  if (timer) return false;
  if (process.env.SENSOR_SIMULATOR_ENABLED !== 'true') return false;
  timer = setInterval(() => runCycle().catch(error => console.error('[SENSOR SIM] cycle failed:', error.message)), getIntervalMs());
  runCycle().catch(error => console.error('[SENSOR SIM] initial cycle failed:', error.message));
  console.log(`[SENSOR SIM] started interval=${getIntervalMs()}ms scenario=${getScenario()}`);
  return true;
}
function stopSensorSimulator() { if (!timer) return false; clearInterval(timer); timer = null; console.log('[SENSOR SIM] stopped'); return true; }
function isRunning() { return Boolean(timer); }

function setTelemetrySender(sender) { telemetrySender = sender || requestTelemetry; }

module.exports = { generateTelemetry, requestTelemetry, runCycle, startSensorSimulator, stopSensorSimulator, setScenario, getScenario, selectedBinId, isRunning, setTelemetrySender, states };