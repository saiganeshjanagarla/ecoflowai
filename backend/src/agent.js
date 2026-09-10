const store = require('./store');
const fs = require('fs');
const path = require('path');

// This is operational memory, not model reasoning. It is deliberately small,
// JSON-backed, and contains only auditable outcomes/rationales.
const MEMORY_FILE = path.join(__dirname, '..', 'agent-memory.json');
const TERMINAL_TASK_STATUSES = new Set(['COMPLETED', 'VERIFIED', 'CANCELLED']);
const agentRuntime = { state: 'ONLINE', updatedAt: new Date().toISOString(), lastError: null };
function setAgentState(state, error = null) { agentRuntime.state = state; agentRuntime.updatedAt = new Date().toISOString(); agentRuntime.lastError = error; }
function persistOperationalMemory() {
  const payload = {
    savedAt: new Date().toISOString(),
    runs: store.agentRuns.slice(0, 100),
    decisions: store.agentDecisions.slice(0, 250),
    timeline: store.agentTimeline.slice(0, 250)
  };
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(payload, null, 2), 'utf8'); } catch (_) { /* memory persistence must not halt dispatch */ }
  try { store.persistOperationalState(); } catch (_) { /* state persistence must not halt dispatch */ }
}
function restoreOperationalMemory() {
  try {
    const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    for (const [key, values, max] of [['agentRuns', saved.runs, 100], ['agentDecisions', saved.decisions, 250], ['agentTimeline', saved.timeline, 250]]) {
      if (Array.isArray(values) && !store[key].length) store[key].push(...values.slice(0, max));
    }
  } catch (_) { /* first run / malformed optional memory */ }
}
restoreOperationalMemory();

const TASK_TRANSITIONS = {
  CREATED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['DRIVER_EN_ROUTE', 'CANCELLED'],
  DRIVER_EN_ROUTE: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['COLLECTING', 'CANCELLED'],
  COLLECTING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['VERIFIED'],
  VERIFIED: [],
  // retained for existing seed records and API clients during migration
  PENDING: ['ASSIGNED', 'CANCELLED'], ASSIGNED: ['EN_ROUTE', 'IN_PROGRESS', 'CANCELLED'],
  EN_ROUTE: ['COLLECTING', 'IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COLLECTING', 'COMPLETED', 'CANCELLED'],
  CANCELLED: []
};

function distanceBetween(a, b) {
  const lat = (a.latitude - b.latitude) * 111;
  const lon = (a.longitude - b.longitude) * 96;
  return Math.sqrt(lat * lat + lon * lon);
}

function estimateWasteKg(bin) {
  return Math.max(40, (bin.capacity * (bin.fill || 0) / 100) * 0.76);
}

function syncVehicleAvailability() {
  const activeVehicleIds = new Set(
    store.tasks
      .filter(task => task.vehicle && !TERMINAL_TASK_STATUSES.has(task.status))
      .map(task => task.vehicle)
  );

  for (const vehicle of store.vehicles) {
    if (vehicle.status === 'MAINTENANCE') continue;
    vehicle.status = activeVehicleIds.has(vehicle.id) ? 'ASSIGNED' : 'AVAILABLE';
    if (!activeVehicleIds.has(vehicle.id) && vehicle.currentLoad > 0) {
      vehicle.currentLoad = 0;
    }
  }
}

function releaseVehicleForTask(task) {
  const vehicle = store.vehicles.find(item => item.id === task.vehicle);
  if (!vehicle || vehicle.status === 'MAINTENANCE') return vehicle;
  const hasOtherActiveTask = store.tasks.some(other =>
    other.id !== task.id &&
    other.vehicle === vehicle.id &&
    !TERMINAL_TASK_STATUSES.has(other.status)
  );

  if (!hasOtherActiveTask) {
    vehicle.status = 'AVAILABLE';
    vehicle.currentLoad = 0;
  }

  return vehicle;
}

function predictedOverflow(bin) {
  if (!bin || !Number.isFinite(bin.fill) || !Number.isFinite(bin.fillRate)) {
    return { hours: 0, at: new Date().toISOString() };
  }
  const hours = Math.max(0.3, (100 - bin.fill) / Math.max(bin.fillRate, 0.2));
  return { hours: Number(hours.toFixed(1)), at: new Date(Date.now() + hours * 3600000).toISOString() };
}

function priorityFor(bin, forecast) {
  if (!bin) return 'LOW';
  if (bin.fill >= 95 || forecast.hours < 2) return 'CRITICAL';
  if (bin.fill >= 85 || forecast.hours < 6) return 'HIGH';
  if (bin.fill >= 70) return 'MEDIUM';
  return 'LOW';
}

function getBinStatus() {
  return store.bins.map(bin => {
    const forecast = predictedOverflow(bin);
    const priority = priorityFor(bin, forecast);
    return {
      ...bin,
      forecast,
      priority,
      predictedOverflowTime: forecast.at,
      status: priority === 'CRITICAL' ? 'CRITICAL' : priority === 'HIGH' ? 'HIGH' : priority === 'MEDIUM' ? 'MEDIUM' : 'NORMAL'
    };
  });
}

function getWorkspaceBins(workspaceName = 'Hyderabad Operations') {
  return store.bins.map(bin => ({
    ...bin,
    workspace: workspaceName || 'Hyderabad Operations'
  }));
}

function getAvailableVehiclesForBins(selectedBins = []) {
  const estimatedDemand = selectedBins.reduce((sum, bin) => sum + estimateWasteKg(bin), 0);
  return store.vehicles
    .filter(vehicle => vehicle.status !== 'MAINTENANCE')
    .map(vehicle => ({
      ...vehicle,
      availableCapacity: Math.max(0, vehicle.capacity - vehicle.currentLoad),
      driverAvailable: Boolean(getAvailableDriver(vehicle)),
      canHandle: Math.max(0, vehicle.capacity - vehicle.currentLoad) >= estimatedDemand && Boolean(getAvailableDriver(vehicle))
    }))
    .filter(vehicle => vehicle.canHandle)
    .sort((a, b) => a.availableCapacity - b.availableCapacity);
}

function getAvailableDriver(vehicle, requestedDriverId = null, excludedTaskId = null) {
  const driver = requestedDriverId
    ? store.drivers.find(item => item.id === requestedDriverId)
    : store.drivers.find(item => item.vehicleId === vehicle.id || item.name === vehicle.driver);
  if (!driver || driver.status !== 'ONLINE') return null;
  const activeTask = store.tasks.some(task => task.id !== excludedTaskId && task.driver === driver.name && !TERMINAL_TASK_STATUSES.has(task.status));
  return activeTask ? null : driver;
}

function historicalCollectionScore(bin) {
  const completed = store.collectionHistory.filter(outcome => outcome.bins?.includes(bin.id));
  const lastCollection = completed
    .map(outcome => outcome.completedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const hoursSinceCollection = lastCollection ? (Date.now() - Date.parse(lastCollection)) / 3600000 : 24;
  const scheduledSoon = bin.nextScheduledCollection && Date.parse(bin.nextScheduledCollection) <= Date.now() + 6 * 3600000;
  const averageAccuracy = completed.length
    ? completed.reduce((sum, outcome) => sum + (outcome.prediction?.priority === outcome.actualPriority ? 0.1 : 0), 0)
      / completed.length
    : 0;
  return Number((completed.length * 0.1 + averageAccuracy + Math.min(hoursSinceCollection / 24, 2) + (scheduledSoon ? 0.5 : 0)).toFixed(2));
}

function recordAgentPhase(phase, action, rationale, result = {}) {
  store.agentTimeline.unshift({
    id: `AT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    phase,
    action,
    rationale: String(rationale || '').slice(0, 240),
    result
  });
}

function replanActiveTasks() {
  const replanned = [];
  for (const task of store.tasks.filter(item => !TERMINAL_TASK_STATUSES.has(item.status))) {
    const vehicle = store.vehicles.find(item => item.id === task.vehicle);
    const driver = store.drivers.find(item => item.id === task.driverId || item.name === task.driver);
    const taskBins = (task.bins || []).map(id => store.bins.find(bin => bin.id === id)).filter(Boolean);
    const routeDemand = taskBins.reduce((sum, bin) => sum + estimateWasteKg(bin), 0);
    const invalidRoute = taskBins.length !== (task.bins || []).length || routeDemand > (vehicle?.capacity || 0);
    const unavailable = !vehicle || ['MAINTENANCE', 'OFFLINE'].includes(vehicle.status) || !driver || !['ONLINE', 'ON_ROUTE'].includes(driver.status);
    if (!unavailable && !invalidRoute) continue;

    if (vehicle && vehicle.status !== 'MAINTENANCE') {
      vehicle.status = 'AVAILABLE';
      vehicle.currentLoad = 0;
    }
    if (driver) driver.status = 'ONLINE';
    const replacement = getAvailableVehiclesForBins(taskBins)[0];
    if (!replacement) {
      recordAgentPhase('RE-PLAN', 'DEFER_TASK', `No vehicle and driver pair can cover ${task.id} after an operational change.`, { taskId: task.id });
      continue;
    }

    const replacementDriver = getAvailableDriver(replacement);
    const replacementRoute = optimizeRoute(taskBins, replacement);
    task.vehicle = replacement.id;
    task.driver = replacementDriver.name;
    task.driverId = replacementDriver.id;
    task.distance = replacementRoute.distance;
    task.duration = replacementRoute.duration;
    task.bins = replacementRoute.sequence;
    task.replanned = true;
    task.reason = `${task.reason} Re-planned after ${unavailable ? 'vehicle or driver availability changed' : 'route capacity or validity changed'}.`;
    replacement.status = 'ASSIGNED';
    replacement.currentLoad = replacementRoute.estimatedWasteCollected;
    replacementDriver.status = 'ON_ROUTE';
    replanned.push(task.id);
    recordAgentPhase('RE-PLAN', 'REASSIGN_TASK', `Reassigned ${task.id} to a validated available vehicle and driver.`, { taskId: task.id, vehicleId: replacement.id, driverId: replacementDriver.id });
    store.notifications.unshift({ id: `N-${Date.now()}-${task.id}`, type: 'TASK_REPLANNED', title: `Task ${task.id} re-planned`, body: `Assigned ${replacement.id} and ${replacementDriver.name} after an operational change.`, time: 'just now', read: false });
    store.auditLogs.unshift({ id: `AL-${Date.now()}-${task.id}`, timestamp: new Date().toISOString(), agent: 'EcoFlow Orchestrator', action: 'Re-planned collection task', resource: 'task', resourceId: task.id, status: 'SUCCESS', metadata: { vehicleId: replacement.id, driverId: replacementDriver.id, rationale: 'Validated fleet, driver, route, and capacity replacement.' } });
  }
  if (replanned.length) persistOperationalMemory();
  return replanned;
}

function optimizeRoute(selectedBins, vehicle) {
  const depot = { latitude: 17.3850, longitude: 78.4867 };
  const routeQueue = [...selectedBins].sort((a, b) => {
    const aPriority = a.priority === 'CRITICAL' ? 3 : a.priority === 'HIGH' ? 2 : a.priority === 'MEDIUM' ? 1 : 0;
    const bPriority = b.priority === 'CRITICAL' ? 3 : b.priority === 'HIGH' ? 2 : b.priority === 'MEDIUM' ? 1 : 0;
    if (bPriority !== aPriority) return bPriority - aPriority;
    return distanceBetween(depot, a) - distanceBetween(depot, b);
  });

  const route = [];
  let current = depot;
  let totalDistance = 0;
  let totalWaste = 0;
  let remainingCapacity = vehicle.capacity - vehicle.currentLoad;

  while (routeQueue.length) {
    const nextIndex = routeQueue
      .map((bin, index) => ({ bin, index, dist: distanceBetween(current, bin) }))
      .sort((a, b) => a.dist - b.dist)[0];

    const next = nextIndex.bin;
    const nextWaste = estimateWasteKg(next);
    if (nextWaste > remainingCapacity) {
      routeQueue.splice(nextIndex.index, 1);
      continue;
    }

    totalDistance += distanceBetween(current, next);
    totalWaste += nextWaste;
    remainingCapacity -= nextWaste;
    route.push(next.id);
    current = next;
    routeQueue.splice(nextIndex.index, 1);
  }

  const returnDistance = distanceBetween(current, depot);
  totalDistance += returnDistance;

  return {
    sequence: route,
    distance: Number(totalDistance.toFixed(1)),
    duration: Math.round((totalDistance / 0.75) * 60),
    fuel: Number((totalDistance * 0.16).toFixed(1)),
    capacityRequired: Number(totalWaste.toFixed(1)),
    remainingCapacity: Number(Math.max(0, remainingCapacity).toFixed(1)),
    vehicle: vehicle.id,
    estimatedWasteCollected: Number(totalWaste.toFixed(1))
  };
}

function createCollectionTask({ bins: selectedBinIds, vehicleId, driverId = null, source = 'AI', priority = 'HIGH', reason = '', assigneeId = null }) {
  const vehicle = store.vehicles.find(item => item.id === vehicleId);
  if (!vehicle) throw new Error('Vehicle not found');
  if (vehicle.status === 'MAINTENANCE' || vehicle.status === 'OFFLINE') throw new Error(`${vehicle.id} is unavailable for dispatch.`);

  const selectedBins = store.bins.filter(bin => selectedBinIds.includes(bin.id));
  if (selectedBins.length !== [...new Set(selectedBinIds)].length) throw new Error('One or more bins were not found');
  const driver = getAvailableDriver(vehicle, driverId);
  if (!driver) throw new Error(`No available driver for ${vehicle.id}.`);
  const duplicate = store.tasks.find(task => !TERMINAL_TASK_STATUSES.has(task.status) && (task.bins || []).some(binId => selectedBinIds.includes(binId)));
  if (duplicate) throw new Error(`An active collection task already covers ${duplicate.bins.join(', ')}.`);
  const route = optimizeRoute(selectedBins, vehicle);
  if (route.sequence.length !== selectedBins.length) throw new Error(`${vehicle.id} does not have enough remaining capacity for all selected bins.`);
  const task = {
    id: `CT-${String(Date.now()).slice(-6)}`,
    priority,
    source,
    bins: route.sequence,
    vehicle: vehicleId,
    driver: driver.name,
    driverId: driver.id,
    assigneeId,
    distance: route.distance,
    duration: route.duration,
    status: 'CREATED',
    reason: reason || `${selectedBins[0]?.id || 'Collection'} requires immediate attention.`,
    createdAt: new Date().toISOString(),
    collectedQuantity: 0,
    notes: '',
    contaminationLevel: 'MEDIUM'
  };

  store.tasks.unshift(task);
  vehicle.status = 'ASSIGNED';
  vehicle.currentLoad = route.estimatedWasteCollected;
  driver.status = 'ON_ROUTE';
  store.notifications.unshift({
    id: `N-${Date.now()}`,
    type: 'TASK_ASSIGNED',
    title: `Task ${task.id} assigned`,
    body: `${driver.name} assigned ${vehicle.id} for ${task.bins.join(', ')}.`,
    time: 'just now',
    read: false
  });
  persistOperationalMemory();
  return task;
}

function transitionTask(task, nextStatus) {
  const valid = TASK_TRANSITIONS[task.status] || [];
  if (!valid.includes(nextStatus)) {
    throw new Error(`Invalid task transition: ${task.status} -> ${nextStatus}`);
  }

  task.status = nextStatus;
  if (nextStatus === 'ASSIGNED') {
    const vehicle = store.vehicles.find(item => item.id === task.vehicle);
    if (vehicle && vehicle.status !== 'MAINTENANCE') vehicle.status = 'ASSIGNED';
  }

  if (nextStatus === 'IN_PROGRESS') {
    const vehicle = store.vehicles.find(item => item.id === task.vehicle);
    if (vehicle && vehicle.status !== 'MAINTENANCE') vehicle.status = 'ASSIGNED';
  }

  if (nextStatus === 'COMPLETED') {
    releaseVehicleForTask(task);
    const driver = store.drivers.find(item => item.id === task.driverId || item.name === task.driver);
    if (driver) driver.status = 'ONLINE';
  }

  if (nextStatus === 'CANCELLED') {
    releaseVehicleForTask(task);
    const driver = store.drivers.find(item => item.id === task.driverId || item.name === task.driver);
    if (driver) driver.status = 'ONLINE';
  }
  persistOperationalMemory();
  return task;
}

function completeTask(taskId, payload = {}) {
  const task = store.tasks.find(item => item.id === taskId);
  if (!task) throw new Error('Collection task not found');
  if (task.status === 'VERIFIED') return task;
  if (!['COLLECTING', 'IN_PROGRESS', 'COMPLETED'].includes(task.status)) {
    throw new Error(`Collection can only be completed from COLLECTING, IN_PROGRESS, or COMPLETED; current state is ${task.status}.`);
  }

  const collectedQuantity = Number(payload.collectedQuantity);
  const maximumPlausibleQuantity = task.bins.reduce((sum, binId) => sum + (store.bins.find(bin => bin.id === binId)?.capacity || 0), 0);
  if (!Number.isFinite(collectedQuantity) || collectedQuantity <= 0 || collectedQuantity > maximumPlausibleQuantity) {
    throw new Error(`Collected quantity must be greater than 0 and no more than ${maximumPlausibleQuantity} kg.`);
  }
  const notes = String(payload.notes || '');
  const contaminationLevel = String(payload.contaminationLevel || 'MEDIUM');

  task.status = 'COMPLETED';
  task.collectedQuantity = collectedQuantity;
  task.notes = notes;
  task.contaminationLevel = contaminationLevel;
  task.completedAt = new Date().toISOString();

  const vehicle = store.vehicles.find(item => item.id === task.vehicle);
  if (vehicle && vehicle.status !== 'MAINTENANCE') {
    vehicle.status = 'AVAILABLE';
    vehicle.currentLoad = 0;
  }
  const driver = store.drivers.find(item => item.id === task.driverId || item.name === task.driver);
  if (driver) driver.status = 'ONLINE';

  for (const binId of task.bins) {
    const bin = store.bins.find(item => item.id === binId);
    if (!bin) continue;
    const reduction = Math.min(bin.fill, Math.max(8, (collectedQuantity / Math.max(task.bins.length, 1)) / 2));
    bin.fill = Math.max(0, Number((bin.fill - reduction).toFixed(1)));
    bin.lastCollected = new Date().toISOString();
    bin.priority = priorityFor(bin, predictedOverflow(bin));
    bin.status = bin.fill >= 95 ? 'CRITICAL' : bin.fill >= 85 ? 'HIGH' : bin.fill >= 70 ? 'MEDIUM' : 'NORMAL';
  }

  store.collectionHistory.unshift({
    id: `CO-${Date.now()}`,
    taskId: task.id,
    bins: [...task.bins],
    prediction: { priority: task.priority, reason: task.reason },
    actualPriority: task.bins.map(binId => store.bins.find(bin => bin.id === binId)).find(Boolean)?.priority || 'LOW',
    collectedAmount: collectedQuantity,
    route: [...task.bins],
    vehicle: task.vehicle,
    driver: task.driverId,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    durationMinutes: task.createdAt ? Math.max(0, Math.round((Date.parse(task.completedAt) - Date.parse(task.createdAt)) / 60000)) : null,
    replanned: Boolean(task.replanned),
    simulatedTelemetry: payload.simulatedTelemetry === true
  });

  task.simulatedTelemetry = payload.simulatedTelemetry === true;

  const notification = {
    id: `N-${Date.now()}`,
    type: 'TASK_COMPLETED',
    title: `Task ${task.id} completed`,
    body: `${task.vehicle} completed collection for ${task.bins.join(', ')}.${task.simulatedTelemetry ? ' Simulated telemetry.' : ''}`,
    time: 'just now',
    read: false
  };
  store.notifications.unshift(notification);

  store.auditLogs.unshift({
    id: `AL-${Date.now()}`,
    timestamp: new Date().toISOString(),
    agent: 'EcoFlow Orchestrator',
    action: 'Completed collection task',
    reason: notes || `Collected ${collectedQuantity} kg`,
    input: task.bins.join(', '),
    result: `${task.id} / ${task.vehicle}`,
    status: 'SUCCESS'
  });

  task.status = 'VERIFIED';
  task.verifiedAt = new Date().toISOString();
  task.simulatedTelemetry = payload.simulatedTelemetry === true;
  recordAgentPhase('VERIFY', 'VERIFY_COLLECTION', `${task.simulatedTelemetry ? 'Verified simulated field telemetry' : 'Verified collection telemetry'} for ${task.id}; bins, vehicle, driver, and route were updated.`, { taskId: task.id, collectedQuantity, simulatedTelemetry: task.simulatedTelemetry });
  persistOperationalMemory();
  return task;
}

function authorizeRole(role, requiredRole) {
  if (role === 'VIEWER' && requiredRole !== 'VIEWER') {
    throw new Error('Viewer is not permitted to execute this operation.');
  }
  if (requiredRole === 'ADMIN' && role !== 'ADMIN') {
    throw new Error('Admin privileges are required for this action.');
  }
  if (requiredRole === 'OPERATOR' && !['ADMIN', 'OPERATOR'].includes(role)) {
    throw new Error('Operator privileges are required for this action.');
  }
  return true;
}

function reportIncident({ location, wasteType, severity = 'MEDIUM', description, reporter = 'system@ecoflow.local' }) {
  const incident = {
    id: `INC-${Date.now()}`,
    location,
    wasteType,
    severity,
    description,
    reporter,
    status: 'OPEN',
    reportedAt: new Date().toISOString(),
    aiReview: null
  };

  store.incidents.unshift(incident);
  store.notifications.unshift({
    id: `N-${Date.now()}`,
    type: 'INCIDENT_REPORTED',
    title: 'Waste issue reported',
    body: `${severity} ${wasteType} issue reported at ${location}.`,
    time: 'just now',
    read: false
  });

  return incident;
}

function reviewIncident(incidentId, status = 'AI_REVIEWED') {
  const incident = store.incidents.find(item => item.id === incidentId);
  if (!incident) throw new Error('Incident not found');
  incident.status = status;
  incident.aiReview = new Date().toISOString();
  return incident;
}

function updateIncident(incidentId, status) {
  const allowed = ['OPEN', 'NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED'];
  if (!allowed.includes(status)) throw new Error('Invalid incident status');
  const incident = store.incidents.find(item => item.id === incidentId);
  if (!incident) throw new Error('Incident not found');
  if (incident.status === 'RESOLVED' && status !== 'RESOLVED') throw new Error('Resolved incidents cannot be reopened');
  incident.status = status;
  incident.updatedAt = new Date().toISOString();
  return incident;
}

function ensureActiveVehicle(vehicleId) {
  const vehicle = store.vehicles.find(item => item.id === vehicleId);
  if (!vehicle) throw new Error(`Vehicle ${vehicleId} not found in Hyderabad fleet.`);
  if (vehicle.status === 'MAINTENANCE' || vehicle.status === 'OFFLINE') throw new Error(`${vehicleId} is unavailable for dispatch.`);
  return vehicle;
}

function ensureBinIds(binIds = []) {
  const ids = Array.isArray(binIds) ? binIds : [binIds];
  const normalized = [...new Set(ids.filter(Boolean))];
  const bins = normalized.map(id => {
    const bin = store.bins.find(item => item.id === id);
    if (!bin) throw new Error(`Bin ${id} not found in Hyderabad operations.`);
    return bin;
  });
  return bins;
}

function ensureDriver(driverId) {
  const driver = store.drivers.find(item => item.id === driverId);
  if (!driver) throw new Error(`Driver ${driverId} not found in Hyderabad roster.`);
  return driver;
}

function reassignTaskResources(taskId, { vehicleId, driverId } = {}) {
  const task = store.tasks.find(item => item.id === taskId);
  if (!task) throw new Error('Collection task not found');
  if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error('Terminal tasks cannot be reassigned.');
  const vehicle = ensureActiveVehicle(vehicleId || task.vehicle);
  const driver = ensureDriver(driverId || store.drivers.find(item => item.vehicleId === vehicle.id || item.name === vehicle.driver)?.id);
  if (driver.status !== 'ONLINE' && driver.id !== task.driverId) throw new Error(`${driver.id} is not available.`);
  if (driver.vehicleId && driver.vehicleId !== vehicle.id) throw new Error(`${driver.id} is not assigned to ${vehicle.id}.`);
  if (store.tasks.some(other => other.id !== task.id && !TERMINAL_TASK_STATUSES.has(other.status) && (other.vehicle === vehicle.id || other.driverId === driver.id))) throw new Error('Vehicle or driver already has an active collection task.');
  const selectedBins = ensureBinIds(task.bins);
  const route = optimizeRoute(selectedBins, { ...vehicle, currentLoad: 0 });
  if (route.sequence.length !== selectedBins.length) throw new Error(`${vehicle.id} cannot safely carry this task.`);
  const oldVehicle = store.vehicles.find(item => item.id === task.vehicle);
  const oldDriver = store.drivers.find(item => item.id === task.driverId);
  if (oldVehicle && oldVehicle.id !== vehicle.id && oldVehicle.status !== 'MAINTENANCE') { oldVehicle.status = 'AVAILABLE'; oldVehicle.currentLoad = 0; }
  if (oldDriver && oldDriver.id !== driver.id) oldDriver.status = 'ONLINE';
  task.vehicle = vehicle.id; task.driver = driver.name; task.driverId = driver.id; task.distance = route.distance; task.duration = route.duration; task.bins = route.sequence;
  vehicle.status = 'ASSIGNED'; vehicle.currentLoad = route.estimatedWasteCollected; driver.status = 'ON_ROUTE';
  persistOperationalMemory();
  return task;
}

function maybeCallOpenAI(prompt, context = {}, history = []) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const isOpenRouterKey = Boolean(apiKey?.startsWith('sk-or-'));
  const endpoint = process.env.LLM_BASE_URL || (isOpenRouterKey ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions');

  if (!apiKey || !['openai', 'openrouter'].includes(provider)) {
    throw new Error('OpenAI not configured; using local rule engine fallback.');
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(isOpenRouterKey ? { 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'EcoFlow AI Smart Waste Operations' } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content: `You are the EcoFlow AI Orchestrator for Hyderabad only. Use validated tools and previous results to follow OBSERVE, ANALYZE, DECIDE, FLEET CHECK, CAPACITY CHECK, DRIVER CHECK, ROUTE, DISPATCH, MONITOR, VERIFY, and RE-PLAN when needed. Available tools: get_bin_status, predict_overflow, get_collection_history, get_available_vehicles, check_vehicle_capacity, get_available_drivers, prioritize_bins, optimize_route, assign_vehicle, assign_driver, create_collection_task, notify_driver, notify_operator. Return one strict JSON object per turn: {"tool":"tool_name_or_final","args":{},"rationale":"concise operational rationale","state":"OBSERVING|ANALYZING|DECIDING|ACTING|MONITORING|VERIFYING|REPLANNING|COMPLETED"}. Never invent identifiers, location, capacity, route, driver, or database state. Tool results are authoritative. Use tool:"final" only after sufficient tool results; do not reveal reasoning.`
        },
        {
          role: 'user',
          content: JSON.stringify({
            prompt,
            workspace: 'Hyderabad Operations',
            bins: context.bins?.slice(0, 8).map(bin => ({ id: bin.id, fill: bin.fill, fillRate: bin.fillRate, priority: bin.priority, location: bin.location, wasteType: bin.wasteType })) || [],
            vehicles: context.vehicles?.slice(0, 8).map(vehicle => ({ id: vehicle.id, status: vehicle.status, capacity: vehicle.capacity, currentLoad: vehicle.currentLoad, driver: vehicle.driver })) || [],
            drivers: context.drivers?.slice(0, 8).map(driver => ({ id: driver.id, name: driver.name, status: driver.status, vehicleId: driver.vehicleId })) || []
          })
        },
        ...history
      ]
    })
  }).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || 'OpenAI request failed.');
    }
    const choice = payload.choices?.[0]?.message?.content;
    if (!choice) return null;
    try {
      const parsed = JSON.parse(choice);
      return parsed;
    } catch {
      const match = choice.match(/\{.*\}/s);
      if (!match) return null;
      return JSON.parse(match[0]);
    }
  });
}

function executeToolAction(action) {
  const tool = String(action?.tool || action?.name || '').trim();
  const args = action?.args || {};

  switch (tool) {
    case 'get_bin_status': {
      return getBinStatus();
    }
    case 'predict_overflow': {
      const bin = ensureBinIds([args.binId])[0];
      const forecast = predictedOverflow(bin);
      return { binId: bin.id, priority: priorityFor(bin, forecast), forecast, location: bin.location };
    }
    case 'prioritize_bins': {
      const bins = ensureBinIds(args.binIds || []);
      return bins.map(bin => {
        const forecast = predictedOverflow(bin);
        return { id: bin.id, location: bin.location, fill: bin.fill, priority: priorityFor(bin, forecast), forecast };
      }).sort((a, b) => (b.fill - a.fill) || (a.id.localeCompare(b.id)));
    }
    case 'get_available_vehicles': {
      const bins = ensureBinIds(args.binIds || []);
      return getAvailableVehiclesForBins(bins);
    }
    case 'check_vehicle_capacity': {
      const vehicle = ensureActiveVehicle(args.vehicleId);
      const bins = ensureBinIds(args.binIds || []);
      const route = optimizeRoute(bins, { ...vehicle, currentLoad: vehicle.currentLoad || 0 });
      return { vehicleId: vehicle.id, capacity: vehicle.capacity, currentLoad: vehicle.currentLoad || 0, capacityRequired: route.capacityRequired, sufficient: route.sequence.length === bins.length };
    }
    case 'get_available_drivers': {
      return store.drivers.filter(driver => driver.status === 'ONLINE' && !store.tasks.some(task => !TERMINAL_TASK_STATUSES.has(task.status) && task.driverId === driver.id)).map(driver => ({ ...driver }));
    }
    case 'get_collection_history': {
      return store.collectionHistory.slice(0, Math.max(1, Math.min(50, Number(args.limit) || 10)));
    }
    case 'optimize_route': {
      const bins = ensureBinIds(args.binIds || []);
      const vehicle = ensureActiveVehicle(args.vehicleId);
      return optimizeRoute(bins, vehicle);
    }
    case 'assign_vehicle': {
      const task = reassignTaskResources(args.taskId, { vehicleId: args.vehicleId });
      return { taskId: task.id, vehicleId: task.vehicle, driverId: task.driverId, driver: task.driver, route: task.bins };
    }
    case 'assign_driver': {
      const task = reassignTaskResources(args.taskId, { driverId: args.driverId });
      return { taskId: task.id, driverId: task.driverId, driverName: task.driver };
    }
    case 'create_collection_task': {
      const bins = ensureBinIds(args.binIds || []);
      const vehicle = ensureActiveVehicle(args.vehicleId);
      const task = createCollectionTask({
        bins: bins.map(bin => bin.id),
        vehicleId: vehicle.id,
        source: 'AI',
        priority: String(args.priority || 'HIGH').toUpperCase(),
        reason: String(args.reason || 'AI generated collection task'),
        assigneeId: args.assigneeId || null
      });
      return task;
    }
    case 'notify_driver':
    case 'notify_operator': {
      const notification = {
        id: `N-${Date.now()}`,
        type: tool === 'notify_driver' ? 'DRIVER_NOTIFICATION' : 'AI_NOTIFICATION',
        title: tool === 'notify_driver' ? 'Driver notification' : 'AI agent status',
        body: String(args.message || 'Operations status update.'),
        time: 'just now',
        read: false
      };
      store.notifications.unshift(notification);
      return notification;
    }
    case 'write_audit_log': {
      const entry = {
        id: `AL-${Date.now()}`,
        timestamp: new Date().toISOString(),
        user: 'EcoFlow Orchestrator',
        role: 'SYSTEM',
        action: 'AI operational note',
        resource: String(args.resource || 'agent'),
        resourceId: String(args.resourceId || 'SYSTEM'),
        metadata: { rationale: String(args.rationale || args.message || 'Validated backend action.').slice(0, 240) }
      };
      store.auditLogs.unshift(entry);
      return entry;
    }
    default:
      throw new Error(`Unsupported AI tool: ${tool || 'unknown'}`);
  }
}

function isMutationPrompt(prompt = '') {
  return /\b(create|assign|dispatch|schedule|notify|optimi[sz]e|collect|start|complete|update)\b/i.test(prompt);
}

function writeAgentAudit({ user, prompt, mode, rationale, tool, result }) {
  const entry = {
    id: `AL-${Date.now()}`,
    timestamp: new Date().toISOString(),
    user: user?.email || 'AI Agent',
    role: user?.role || 'SYSTEM',
    action: 'AI agent decision',
    resource: tool || 'agent',
    resourceId: result?.id || result?.binId || 'SYSTEM',
    metadata: {
      mode,
      prompt: String(prompt).slice(0, 160),
      rationale: String(rationale || '').slice(0, 240),
      result: JSON.stringify(result || {}).slice(0, 500)
    }
  };
  store.auditLogs.unshift(entry);
  store.agentTimeline.unshift({ timestamp: entry.timestamp, phase: 'VERIFY', action: entry.action, rationale: entry.metadata.rationale, result: entry.metadata.result });
}

function summarizeToolResult(tool, result) {
  if (tool === 'get_bin_status' && Array.isArray(result)) {
    const urgent = result.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).sort((a, b) => b.fill - a.fill);
    if (!urgent.length) return 'No bins currently require urgent attention.';
    return `${urgent.length} bins need attention. The most urgent is ${urgent[0].id} at ${urgent[0].fill}% fill with ${urgent[0].priority} priority. ${urgent.slice(0, 4).map(bin => `${bin.id} (${bin.priority}, ${bin.fill}%)`).join(', ')}.`;
  }
  if (tool === 'predict_overflow' && result?.binId) {
    return `${result.binId} is ${result.priority} priority at ${result.location}, with overflow forecast in ${result.forecast.hours} hours.`;
  }
  if (tool === 'get_available_vehicles' && Array.isArray(result)) {
    return result.length ? `${result.length} vehicles can handle the requested bins. Best fit: ${result[0].id} with ${result[0].availableCapacity} capacity remaining.` : 'No available vehicle can handle the requested bins.';
  }
  if (tool === 'optimize_route' && result?.sequence) {
    return `Route ${result.sequence.join(' -> ')} is planned for ${result.vehicle}, covering ${result.estimatedWasteCollected} kg over ${result.distance} km.`;
  }
  return `Validated ${tool.replaceAll('_', ' ')} successfully.`;
}

function conversationalFallback(prompt = '') {
  const normalized = prompt.trim().toLowerCase();
  if (/^(hi|hii|hello|hey|hlo|good morning|good afternoon|good evening)[!.\s]*$/i.test(normalized)) {
    return 'Hello. I am the EcoFlow operations assistant. Ask me about urgent bins, overflow forecasts, available vehicles, routes, or collection tasks.';
  }
  if (/(explain|what is|how does).*(app|ecoflow|system|platform)|about this app/.test(normalized)) {
    return 'EcoFlow is a Hyderabad smart waste operations platform. It monitors live bin levels, predicts overflow, prioritizes collection, checks vehicle capacity, plans routes, and records verified operational actions. I can answer questions about the current data or carry out an explicitly requested dispatch action when your role allows it.';
  }
  return null;
}

function localAnswer(prompt, bins, actions) {
  const normalized = prompt.trim().toLowerCase();
  const requestedBinId = prompt.match(/\b(?:hyg|b)-\d{3,}\b/i)?.[0]?.toUpperCase();
  const requestedBin = requestedBinId && bins.find(bin => bin.id === requestedBinId);
  if (requestedBinId && !requestedBin) return `I could not find bin ${requestedBinId} in Hyderabad operations.`;
  if (requestedBin && /(why|when|overflow|forecast|full|status|critical|priority)/.test(normalized)) {
    return `${requestedBin.id} is ${requestedBin.priority} priority at ${requestedBin.fill}% fill in ${requestedBin.location}. Its predicted overflow is in ${requestedBin.forecast.hours} hours.`;
  }
  if (/(vehicle|fleet|truck|available)/.test(normalized)) {
    const available = store.vehicles.filter(vehicle => vehicle.status === 'AVAILABLE');
    const assigned = store.vehicles.filter(vehicle => ['ASSIGNED', 'EN_ROUTE', 'COLLECTING'].includes(vehicle.status));
    if (/status|current|fleet/.test(normalized)) {
      return `Hyderabad fleet status: ${available.length} available, ${assigned.length} assigned or in motion, ${store.vehicles.filter(vehicle => vehicle.status === 'MAINTENANCE').length} in maintenance. ${available.slice(0, 3).map(vehicle => `${vehicle.id} has ${Math.max(0, vehicle.capacity - vehicle.currentLoad)} kg remaining`).join('; ') || 'No vehicle is ready for dispatch.'}.`;
    }
    return available.length ? `${available.length} vehicles are available: ${available.map(vehicle => `${vehicle.id} (${vehicle.capacity - vehicle.currentLoad} kg remaining)`).join(', ')}.` : 'No vehicles are currently available.';
  }
  if (/(active|current|open|assigned).*(task|collection)|task|collection queue/.test(normalized)) {
    const activeTasks = store.tasks.filter(task => !['COMPLETED', 'CANCELLED'].includes(task.status));
    return activeTasks.length ? `${activeTasks.length} active collection tasks: ${activeTasks.slice(0, 5).map(task => `${task.id} (${task.status}, ${task.vehicle})`).join(', ')}.` : 'There are no active collection tasks.';
  }
  if (/(which|what|list|show|critical|urgent|attention|collection)/.test(normalized)) {
    const urgent = bins.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).sort((a, b) => b.fill - a.fill);
    return urgent.length
      ? `${urgent.length} bins need attention: ${urgent.map(bin => `${bin.id} (${bin.priority}, ${bin.fill}% full, ${bin.location})`).join(', ')}.`
      : 'No bins currently require urgent attention.';
  }
  const taskAction = actions.find(action => action.type === 'CREATE_COLLECTION_TASK');
  if (taskAction) return `Collection task ${taskAction.result} was created from the validated priority data.`;
  return 'I can answer questions about bin status, overflow forecasts, available vehicles, routes, and collection tasks. Please include a bin ID for a precise forecast.';
}

function localAgentFallback(prompt = 'Run optimization', user = { role: 'ADMIN' }) {
  const decisions = [];
  const actions = [];
  const observed = getBinStatus().filter(bin => ['CRITICAL', 'HIGH', 'MEDIUM'].includes(bin.priority));
  const conversationalAnswer = conversationalFallback(prompt);

  if (conversationalAnswer) {
    const run = {
      id: `RUN-${Date.now()}`,
      trigger: 'fallback',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      mode: 'LOCAL_RULE_ENGINE',
      state: 'VERIFIED',
      observations: 0,
      urgent: 0,
      decisions: [{ type: 'RESPOND', subject: 'Assistant conversation', reason: 'Answered a general user message without changing operational state.' }],
      actions: [{ type: 'NO_ACTION', status: 'SUCCESS', result: 'No operational mutation performed.' }],
      answer: conversationalAnswer
    };
    writeAgentAudit({ user, prompt, mode: run.mode, rationale: run.decisions[0].reason, tool: 'conversation', result: run.actions[0] });
    store.aiRuns.unshift(run);
    return run;
  }

  if (!observed.length) {
    decisions.push({ type: 'MONITOR', subject: 'Hyderabad operations', reason: 'No bins crossed the configured urgency thresholds.' });
    actions.push({ type: 'NO_ACTION', status: 'SUCCESS', result: 'No intervention required.' });
  } else {
    const priorityBins = observed.slice(0, 3);
    const first = priorityBins[0];
    decisions.push({ type: 'PRIORITIZE', subject: first.id, reason: `${first.priority} priority; ${first.fill}% fill with ${first.forecast.hours}h until overflow.` });
    const vehicle = getAvailableVehiclesForBins(priorityBins)[0];
    if (vehicle && isMutationPrompt(prompt) && ['ADMIN', 'OPERATOR'].includes(user.role)) {
      const route = optimizeRoute(priorityBins, vehicle);
      const task = createCollectionTask({ bins: route.sequence, vehicleId: vehicle.id, source: 'AI', priority: first.priority, reason: `Local fallback created task for ${first.id}` });
      actions.push({ type: 'CREATE_COLLECTION_TASK', status: 'SUCCESS', result: `${task.id} assigned to ${vehicle.id}`, taskId: task.id, vehicleId: vehicle.id, driverId: task.driverId, driver: task.driver, bins: task.bins, route: route.sequence });
    } else if (vehicle) {
      actions.push({ type: 'READ_ONLY', status: 'SUCCESS', result: `Read-only analysis: ${first.id} identified; no task was created.` });
    } else {
      actions.push({ type: 'NO_ACTION', status: 'SUCCESS', result: 'No vehicles were available for the priority bins.' });
    }
  }

  const run = {
    id: `RUN-${Date.now()}`,
    trigger: 'fallback',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    mode: 'LOCAL_RULE_ENGINE',
    state: 'VERIFIED',
    observations: observed.length,
    urgent: observed.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).length,
    decisions,
    actions,
    answer: localAnswer(prompt, getBinStatus(), actions)
  };
  store.aiRuns.unshift(run);
  writeAgentAudit({ user, prompt, mode: run.mode, rationale: decisions[0]?.reason, tool: actions[0]?.type, result: actions[0] });
  return run;
}

function simulatedTelemetryEnabled() {
  return process.env.AI_SIMULATED_TELEMETRY === 'true' || (process.env.NODE_ENV !== 'production' && process.env.AI_SIMULATED_TELEMETRY !== 'false');
}

function advanceSimulatedTask(task) {
  task.simulatedTelemetry = true;
  if (task.status === 'CREATED') return transitionTask(task, 'DISPATCHED');
  if (task.status === 'DISPATCHED') return transitionTask(task, 'DRIVER_EN_ROUTE');
  if (task.status === 'DRIVER_EN_ROUTE') return transitionTask(task, 'ARRIVED');
  if (task.status === 'ARRIVED') return transitionTask(task, 'COLLECTING');
  if (task.status === 'COLLECTING') {
    const maximum = task.bins.reduce((sum, binId) => sum + (store.bins.find(bin => bin.id === binId)?.capacity || 0), 0);
    const estimated = task.bins.reduce((sum, binId) => sum + estimateWasteKg(store.bins.find(bin => bin.id === binId)), 0);
    return completeTask(task.id, { collectedQuantity: Math.max(1, Math.min(maximum, Number(estimated.toFixed(1)))), notes: 'Deterministic simulated telemetry event.', contaminationLevel: task.contaminationLevel, simulatedTelemetry: true });
  }
  return task;
}

function monitorActiveTasks(trigger = 'scheduled') {
  setAgentState('MONITORING');
  syncVehicleAvailability();
  const activeTasks = store.tasks.filter(task => !TERMINAL_TASK_STATUSES.has(task.status));
  const replanned = replanActiveTasks();
  const telemetry = [];
  if (simulatedTelemetryEnabled()) {
    for (const task of activeTasks.filter(item => !TERMINAL_TASK_STATUSES.has(item.status))) {
      const before = task.status;
      const updated = advanceSimulatedTask(task);
      telemetry.push({ taskId: task.id, from: before, to: updated.status, simulatedTelemetry: true });
    }
  }
  const result = { trigger, observed: activeTasks.length, changed: replanned, replanned, telemetry, simulatedTelemetry: simulatedTelemetryEnabled() };
  recordAgentPhase('MONITOR', 'CHECK_ACTIVE_TASKS', `Checked ${activeTasks.length} active tasks, detected ${replanned.length} re-plan events, and processed ${telemetry.length} telemetry events.`, result);
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, timestamp: new Date().toISOString(), agent: 'EcoFlow Orchestrator', action: 'Monitored active collection tasks', resource: 'agent', resourceId: trigger, status: 'SUCCESS', metadata: result });
  persistOperationalMemory();
  setAgentState('COMPLETED');
  return result;
}

async function runAgentLoop(options = {}) {
  const trigger = options.trigger || 'manual';
  const prompt = String(options.prompt || 'Assess Hyderabad waste operations.').trim();
  const user = options.user || { role: 'ADMIN', workspace: 'Hyderabad Operations' };
  const startedAt = new Date().toISOString();
  const context = {
    bins: getBinStatus(),
    vehicles: store.vehicles,
    drivers: store.drivers,
    tasks: store.tasks,
    incidents: store.incidents
  };

  const defaultLocal = () => {
    const run = localAgentFallback(prompt, user);
    run.trigger = trigger;
    run.startedAt = startedAt;
    run.prompt = prompt;
    return run;
  };

  try {
    setAgentState('OBSERVING');
    const allowedTools = new Set(['get_bin_status', 'predict_overflow', 'get_collection_history', 'get_available_vehicles', 'check_vehicle_capacity', 'get_available_drivers', 'prioritize_bins', 'optimize_route', 'assign_vehicle', 'assign_driver', 'create_collection_task', 'notify_driver', 'notify_operator', 'write_audit_log']);
    const mutations = new Set(['assign_vehicle', 'assign_driver', 'create_collection_task', 'notify_driver', 'notify_operator', 'write_audit_log']);
    const history = [];
    const actions = [];
    const decisions = [{ type: 'OBSERVE', subject: 'Hyderabad operations', reason: `Observed ${context.bins.length} Hyderabad bins and current fleet/driver state.` }];
    let state = 'OBSERVING';
    const maxToolCalls = Math.max(2, Math.min(10, Number(options.maxToolCalls) || 8));

    for (let iteration = 0; iteration < maxToolCalls; iteration += 1) {
      const parsed = await maybeCallOpenAI(prompt, context, history);
      if (!parsed || (parsed.tool !== 'final' && !allowedTools.has(parsed.tool))) throw new Error('Invalid LLM tool response.');
      state = parsed.state || state;
      if (['OBSERVING', 'ANALYZING', 'DECIDING', 'ACTING', 'MONITORING', 'VERIFYING', 'REPLANNING'].includes(state)) setAgentState(state);
      if (parsed.tool === 'final') break;
      if (mutations.has(parsed.tool) && (!isMutationPrompt(prompt) || user.role === 'VIEWER')) throw new Error('LLM requested a mutation that is not authorized for this prompt or role.');
      let result;
      try { result = executeToolAction(parsed); }
      catch (error) {
        actions.push({ type: parsed.tool, status: 'REJECTED', result: error.message });
        history.push({ role: 'user', content: JSON.stringify({ toolResult: { tool: parsed.tool, rejected: true, error: error.message }, instruction: 'Use real IDs and a different safe action, or final.' }) });
        continue;
      }
      actions.push({ type: parsed.tool, status: 'SUCCESS', result: JSON.stringify(result).slice(0, 500), resultData: result, taskId: result?.id, vehicleId: result?.vehicle || result?.vehicleId, driverId: result?.driverId, driver: result?.driver, bins: result?.bins, route: result?.sequence });
      decisions.push({ type: parsed.tool.toUpperCase(), subject: result?.id || result?.binId || 'Hyderabad operations', reason: String(parsed.rationale || 'Validated backend tool executed.').slice(0, 240) });
      history.push({ role: 'user', content: JSON.stringify({ toolResult: { tool: parsed.tool, result }, instruction: 'Continue the operational workflow with the next required tool, or final when verified.' }) });
    }
    if (!actions.length) throw new Error('LLM completed without a validated tool action.');
    const run = { id: `RUN-${Date.now()}`, trigger, startedAt, completedAt: new Date().toISOString(), mode: 'LLM', state: 'COMPLETED', agentStatus: state === 'COMPLETED' ? state : 'COMPLETED', observations: context.bins.length, urgent: context.bins.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).length, decisions, actions, answer: summarizeToolResult(actions.at(-1).type, actions.at(-1).resultData), prompt, toolCalls: actions.length };
    store.aiRuns.unshift(run); store.agentRuns.unshift(run); store.agentDecisions.unshift(...decisions.map(decision => ({ ...decision, runId: run.id, timestamp: run.completedAt })));
    writeAgentAudit({ user, prompt, mode: run.mode, rationale: decisions.at(-1)?.reason, tool: actions.at(-1)?.type, result: actions.at(-1) });
    persistOperationalMemory();
    setAgentState('COMPLETED');
    return run;
  } catch (error) {
    setAgentState('ERROR', error.message);
    const run = defaultLocal();
    if (error.message !== 'OpenAI not configured; using local rule engine fallback.') {
      run.fallbackReason = error.message;
    }
    run.prompt = prompt;
    setAgentState('COMPLETED');
    return run;
  }
}

function runDeterministicOptimization(trigger = 'manual') {
  setAgentState('OBSERVING');
  syncVehicleAvailability();
  const startedAt = new Date().toISOString();
  recordAgentPhase('OBSERVE', 'SCAN_OPERATIONS', 'Read current Hyderabad bins, collection history, fleet, drivers, and active tasks.');
  setAgentState('MONITORING');
  const replanned = replanActiveTasks();
  recordAgentPhase('MONITOR', 'CHECK_ACTIVE_TASKS', `Monitored active tasks and detected ${replanned.length} re-plan events.`, { replanned });
  const activeTaskBins = new Set(
    store.tasks
      .filter(task => !TERMINAL_TASK_STATUSES.has(task.status))
      .flatMap(task => task.bins || [])
  );
  const observations = getBinStatus().filter(bin => !activeTaskBins.has(bin.id));
  setAgentState('ANALYZING');
  const urgent = observations.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).sort((a, b) => (b.fill - a.fill) || (historicalCollectionScore(b) - historicalCollectionScore(a)));
  const availableVehicles = store.vehicles.filter(vehicle => vehicle.status === 'AVAILABLE' && vehicle.status !== 'MAINTENANCE' && getAvailableDriver(vehicle));
  const decisions = [];
  const actions = [];

  setAgentState('DECIDING');
  if (urgent.length && availableVehicles.length) {
    let remainingUrgent = [...urgent];
    for (const vehicle of availableVehicles) {
      const eligible = remainingUrgent.filter(bin => estimateWasteKg(bin) <= Math.max(0, vehicle.capacity - vehicle.currentLoad));
      if (!eligible.length) continue;
      const selected = eligible.slice(0, 3);
      const route = optimizeRoute(selected, vehicle);
      setAgentState('ACTING');
      const task = createCollectionTask({
        bins: route.sequence,
        vehicleId: vehicle.id,
        source: 'AI',
        priority: selected.some(bin => bin.priority === 'CRITICAL') ? 'CRITICAL' : 'HIGH',
        reason: `${selected[0].id} is predicted to overflow in ${selected[0].forecast.hours}h.`
      });
      task.reason = `${selected[0].id} is predicted to overflow in ${selected[0].forecast.hours}h.`;
      decisions.push({ type: 'PRIORITIZE', subject: selected[0].id, reason: `${selected[0].fill}% full; forecast overflow in ${selected[0].forecast.hours}h.` });
      actions.push({ type: 'CREATE_COLLECTION_TASK', status: 'SUCCESS', result: `${task.id} assigned to ${vehicle.id}` });
      recordAgentPhase('ACT', 'CREATE_COLLECTION_TASK', `Grouped urgent bins by route and assigned available capacity with an online driver.`, { taskId: task.id, bins: task.bins, vehicleId: vehicle.id, driverId: task.driverId });
      remainingUrgent = remainingUrgent.filter(bin => !selected.some(item => item.id === bin.id));
    }

    if (!actions.length) {
      decisions.push({ type: 'MONITOR', subject: 'Operations', reason: 'No available vehicle had enough capacity for the urgent bins.' });
      actions.push({ type: 'NO_ACTION', status: 'SUCCESS', result: 'Monitoring continues' });
    }
  } else {
    decisions.push({ type: 'MONITOR', subject: 'Operations', reason: urgent.length ? 'Urgent bins found, but no vehicle is available.' : 'No bins crossed configured urgency thresholds.' });
    actions.push({ type: 'NO_ACTION', status: 'SUCCESS', result: 'Monitoring continues' });
  }

  const notice = {
    id: `N-${Date.now()}`,
    type: 'AI_ROUTE_CREATED',
    title: 'AI route created',
    body: `Optimization run completed using the Local AI Decision Engine. ${actions.length} actions recorded.`,
    time: 'just now',
    read: false
  };
  store.notifications.unshift(notice);

  setAgentState('VERIFYING');
  const run = {
    id: `RUN-${Date.now()}`,
    trigger,
    startedAt,
    completedAt: new Date().toISOString(),
    mode: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY ? 'LLM_ORCHESTRATION_WITH_VALIDATED_TOOLS' : 'LOCAL_RULE_ENGINE',
    state: 'COMPLETED',
    agentStatus: 'COMPLETED',
    observations: observations.length,
    urgent: urgent.length,
    decisions,
    actions,
    replanned,
    phases: ['OBSERVE', 'ANALYZE', 'DECIDE', 'ACT', 'MONITOR', 'VERIFY', 'LEARN_REPLAN']
  };
  store.aiRuns.unshift(run);
  store.agentRuns.unshift(run);
  store.agentDecisions.unshift(...decisions.map(decision => ({ ...decision, runId: run.id, timestamp: run.completedAt })));
  recordAgentPhase('VERIFY', 'VERIFY_RUN', 'Recorded the resulting task, fleet, driver, and bin state for the next cycle.', { runId: run.id, actions: actions.length, replanned });
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, timestamp: run.completedAt, agent: 'EcoFlow Orchestrator', action: 'Autonomous operations cycle', resource: 'agent', resourceId: run.id, status: 'SUCCESS', metadata: { trigger, observations: observations.length, urgent: urgent.length, actions: actions.length, replanned } });
  persistOperationalMemory();
  setAgentState('COMPLETED');
  return run;
}

// Scheduler and UI both enter through this orchestrator. If OpenAI is absent or
// rejects a tool call, runAgentLoop safely uses the validated local rule engine.
async function runOptimization(trigger = 'manual', user = { role: 'ADMIN', workspace: 'Hyderabad Operations' }) {
  // The LLM may orchestrate validated tools; deterministic backend checks remain authoritative.
  let advisory = null;
  if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) {
    try { advisory = await runAgentLoop({ trigger, prompt: 'Execute the autonomous Hyderabad dispatch workflow: observe, analyze, check vehicle capacity and driver availability, optimize a validated route, dispatch if required, notify the driver, and finish with a concise result.', user, maxToolCalls: 10 }); }
    catch (_) { advisory = null; }
  }
  const run = runDeterministicOptimization(trigger);
  if (advisory) {
    run.mode = advisory.mode === 'LLM' ? 'LLM_WITH_VALIDATED_BACKEND_WORKFLOW' : 'LOCAL_RULE_ENGINE';
    run.advisoryToolCalls = advisory.toolCalls || advisory.actions?.length || 0;
  }
  return run;
}

module.exports = {
  predictedOverflow,
  priorityFor,
  getBinStatus,
  getWorkspaceBins,
  getAvailableVehiclesForBins,
  optimizeRoute,
  syncVehicleAvailability,
  releaseVehicleForTask,
  createCollectionTask,
  transitionTask,
  completeTask,
  authorizeRole,
  reportIncident,
  reviewIncident,
  updateIncident,
  runOptimization,
  runDeterministicOptimization,
  historicalCollectionScore,
  runAgentLoop,
  executeToolAction,
  maybeCallOpenAI,
  persistOperationalMemory,
  replanActiveTasks,
  reassignTaskResources,
  monitorActiveTasks,
  getAgentRuntime: () => ({ ...agentRuntime })
};
