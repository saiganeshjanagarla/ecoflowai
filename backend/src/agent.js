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

function maybeCallOpenAI(prompt, context = {}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const isOpenRouterKey = apiKey.startsWith('sk-or-');
  const endpoint = process.env.LLM_BASE_URL || (isOpenRouterKey ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions');

  if (provider !== 'openai' || !apiKey) {
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
          content: `You are the EcoFlow operations agent for Hyderabad only. Use only real store data. Never invent bin IDs, vehicle IDs, route IDs, capacity values, or locations. Return strict JSON with keys: "step", "tool", "args", "rationale". Allowed tools: get_bin_status, predict_overflow, prioritize_bins, get_available_vehicles, optimize_route, assign_vehicle, assign_driver, create_collection_task, notify_operator, write_audit_log. Tool rules: use predict_overflow with the exact binId for questions asking why a specific bin is critical or when it will overflow; use get_bin_status for broad bin questions; use get_available_vehicles only when a vehicle question names bins; use mutating tools only when the user explicitly asks to create, assign, dispatch, notify, optimize, or collect. Follow the loop: OBSERVE -> ANALYZE -> DECIDE -> TOOL_ACTION -> VERIFY.`
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
        }
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
    case 'optimize_route': {
      const bins = ensureBinIds(args.binIds || []);
      const vehicle = ensureActiveVehicle(args.vehicleId);
      return optimizeRoute(bins, vehicle);
    }
    case 'assign_vehicle': {
      const task = store.tasks.find(item => item.id === args.taskId);
      if (!task) throw new Error(`Task ${args.taskId} not found.`);
      const vehicle = ensureActiveVehicle(args.vehicleId);
      task.vehicle = vehicle.id;
      task.driver = vehicle.driver;
      vehicle.status = 'ASSIGNED';
      return { taskId: task.id, vehicleId: vehicle.id, driver: vehicle.driver };
    }
    case 'assign_driver': {
      const task = store.tasks.find(item => item.id === args.taskId);
      if (!task) throw new Error(`Task ${args.taskId} not found.`);
      const driver = ensureDriver(args.driverId);
      task.driver = driver.name;
      if (task.vehicle) {
        const vehicle = store.vehicles.find(item => item.id === task.vehicle);
        if (vehicle) vehicle.driver = driver.name;
      }
      return { taskId: task.id, driverId: driver.id, driverName: driver.name };
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
    case 'notify_operator': {
      const notification = {
        id: `N-${Date.now()}`,
        type: 'AI_NOTIFICATION',
        title: 'AI agent status',
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
        user: args.user || 'AI Agent',
        role: args.role || 'ADMIN',
        action: String(args.action || 'AI action'),
        resource: String(args.resource || 'agent'),
        resourceId: String(args.resourceId || 'SYSTEM'),
        metadata: args.metadata || {}
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
  store.auditLogs.unshift({
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
  });
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
      actions.push({ type: 'CREATE_COLLECTION_TASK', status: 'SUCCESS', result: `${task.id} assigned to ${vehicle.id}` });
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
    answer: observed.length
      ? `${observed.length} bins need attention. The most urgent is ${observed[0].id} at ${observed[0].fill}% fill with ${observed[0].priority} priority. No operational task was created unless explicitly requested.`
      : `No bins currently need urgent attention. Local rule engine fallback is active.`
  };
  store.aiRuns.unshift(run);
  writeAgentAudit({ user, prompt, mode: run.mode, rationale: decisions[0]?.reason, tool: actions[0]?.type, result: actions[0] });
  return run;
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
    const parsed = await maybeCallOpenAI(prompt, context);
    const allowedTools = new Set(['get_bin_status', 'predict_overflow', 'prioritize_bins', 'get_available_vehicles', 'optimize_route', 'assign_vehicle', 'assign_driver', 'create_collection_task', 'notify_operator', 'write_audit_log']);
    if (!parsed || !allowedTools.has(parsed.tool)) {
      return defaultLocal();
    }

    if (!isMutationPrompt(prompt) && ['assign_vehicle', 'assign_driver', 'create_collection_task', 'notify_operator', 'write_audit_log'].includes(parsed.tool)) {
      return defaultLocal();
    }

    if (user.role === 'VIEWER' && ['assign_vehicle', 'assign_driver', 'create_collection_task', 'notify_operator', 'write_audit_log'].includes(parsed.tool)) {
      throw new Error('Viewer access is read-only; this AI action was not executed.');
    }
    const toolResult = executeToolAction(parsed);
    const run = {
      id: `RUN-${Date.now()}`,
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      mode: 'LLM',
      state: 'VERIFIED',
      observations: context.bins.length,
      urgent: context.bins.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).length,
      decisions: [{ type: 'OBSERVE', subject: 'Hyderabad operations', reason: parsed.rationale || 'LLM observed the current Hyderabad operational state.' }, { type: 'DECIDE', subject: parsed.tool, reason: `Executed ${parsed.tool} with validated data.` }],
      actions: [{ type: parsed.tool, status: 'SUCCESS', result: JSON.stringify(toolResult).slice(0, 250) }],
      answer: summarizeToolResult(parsed.tool, toolResult),
      prompt
    };

    store.aiRuns.unshift(run);
    writeAgentAudit({ user, prompt, mode: run.mode, rationale: parsed.rationale, tool: parsed.tool, result: toolResult });
    return run;
  } catch (error) {
    const run = defaultLocal();
    if (error.message !== 'OpenAI not configured; using local rule engine fallback.') {
      run.fallbackReason = error.message;
    }
    run.prompt = prompt;
    return run;
  }
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
  runOptimization,
  runAgentLoop,
  executeToolAction,
  maybeCallOpenAI
};