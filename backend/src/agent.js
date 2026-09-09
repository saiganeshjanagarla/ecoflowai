const store = require('./store');

const TASK_TRANSITIONS = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['EN_ROUTE', 'IN_PROGRESS', 'CANCELLED'],
  EN_ROUTE: ['COLLECTING', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COLLECTING', 'COMPLETED', 'CANCELLED'],
  COLLECTING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
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
      .filter(task => task.vehicle && ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(task.status))
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
    ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(other.status)
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
      canHandle: Math.max(0, vehicle.capacity - vehicle.currentLoad) >= estimatedDemand
    }))
    .filter(vehicle => vehicle.canHandle)
    .sort((a, b) => a.availableCapacity - b.availableCapacity);
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

function createCollectionTask({ bins: selectedBinIds, vehicleId, source = 'AI', priority = 'HIGH', reason = '', assigneeId = null }) {
  const vehicle = store.vehicles.find(item => item.id === vehicleId);
  if (!vehicle) throw new Error('Vehicle not found');

  const selectedBins = store.bins.filter(bin => selectedBinIds.includes(bin.id));
  const route = optimizeRoute(selectedBins, vehicle);
  const task = {
    id: `CT-${String(Date.now()).slice(-6)}`,
    priority,
    source,
    bins: route.sequence,
    vehicle: vehicleId,
    driver: vehicle.driver,
    assigneeId,
    distance: route.distance,
    duration: route.duration,
    status: 'PENDING',
    reason: reason || `${selectedBins[0]?.id || 'Collection'} requires immediate attention.`,
    createdAt: new Date().toISOString(),
    collectedQuantity: 0,
    notes: '',
    contaminationLevel: 'MEDIUM'
  };

  store.tasks.unshift(task);
  vehicle.status = 'ASSIGNED';
  vehicle.currentLoad = route.estimatedWasteCollected;
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
  }

  if (nextStatus === 'CANCELLED') {
    releaseVehicleForTask(task);
  }

  return task;
}

function completeTask(taskId, payload = {}) {
  const task = store.tasks.find(item => item.id === taskId);
  if (!task) throw new Error('Collection task not found');
  if (task.status === 'COMPLETED') return task;

  const collectedQuantity = Number(payload.collectedQuantity ?? 0);
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

  for (const binId of task.bins) {
    const bin = store.bins.find(item => item.id === binId);
    if (!bin) continue;
    const reduction = Math.min(bin.fill, Math.max(8, (collectedQuantity / Math.max(task.bins.length, 1)) / 2));
    bin.fill = Math.max(0, Number((bin.fill - reduction).toFixed(1)));
    bin.lastCollected = new Date().toISOString();
    bin.priority = priorityFor(bin, predictedOverflow(bin));
    bin.status = bin.fill >= 95 ? 'CRITICAL' : bin.fill >= 85 ? 'HIGH' : bin.fill >= 70 ? 'MEDIUM' : 'NORMAL';
  }

  const notification = {
    id: `N-${Date.now()}`,
    type: 'TASK_COMPLETED',
    title: `Task ${task.id} completed`,
    body: `${task.vehicle} completed collection for ${task.bins.join(', ')}.`,
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

function runOptimization(trigger = 'manual') {
  syncVehicleAvailability();
  const startedAt = new Date().toISOString();
  const observations = getBinStatus();
  const urgent = observations.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).sort((a, b) => b.fill - a.fill);
  const availableVehicles = store.vehicles.filter(vehicle => vehicle.status === 'AVAILABLE' && vehicle.status !== 'MAINTENANCE');
  const decisions = [];
  const actions = [];

  if (urgent.length && availableVehicles.length) {
    let remainingUrgent = [...urgent];
    for (const vehicle of availableVehicles) {
      const eligible = remainingUrgent.filter(bin => estimateWasteKg(bin) <= Math.max(0, vehicle.capacity - vehicle.currentLoad));
      if (!eligible.length) continue;
      const selected = eligible.slice(0, 3);
      const route = optimizeRoute(selected, vehicle);
      const task = createCollectionTask({
        bins: route.sequence,
        vehicleId: vehicle.id,
        source: 'AI',
        priority: selected.some(bin => bin.priority === 'CRITICAL') ? 'CRITICAL' : 'HIGH',
        reason: `${selected[0].id} is predicted to overflow in ${selected[0].forecast.hours}h.`
      });
      task.status = 'PENDING';
      task.reason = `${selected[0].id} is predicted to overflow in ${selected[0].forecast.hours}h.`;
      decisions.push({ type: 'PRIORITIZE', subject: selected[0].id, reason: `${selected[0].fill}% full; forecast overflow in ${selected[0].forecast.hours}h.` });
      actions.push({ type: 'CREATE_COLLECTION_TASK', status: 'SUCCESS', result: `${task.id} assigned to ${vehicle.id}` });
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

  const run = {
    id: `RUN-${Date.now()}`,
    trigger,
    startedAt,
    completedAt: new Date().toISOString(),
    mode: process.env.LLM_API_KEY ? 'LLM' : 'LOCAL_RULE_ENGINE',
    state: 'VERIFIED',
    observations: observations.length,
    urgent: urgent.length,
    decisions,
    actions
  };
  store.aiRuns.unshift(run);
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
  runOptimization
};