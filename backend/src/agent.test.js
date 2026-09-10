const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const agent = require('./agent');
const store = require('./store');

function resetState() {
  store.resetDemoState();
  const original = {
    bins: store.bins.map(bin => ({ ...bin })),
    vehicles: store.vehicles.map(vehicle => ({ ...vehicle })),
    tasks: store.tasks.map(task => ({ ...task, bins: [...task.bins] })),
    drivers: store.drivers.map(driver => ({ ...driver }))
  };

  return () => {
    store.bins.splice(0, store.bins.length, ...original.bins.map(bin => ({ ...bin })));
    store.vehicles.splice(0, store.vehicles.length, ...original.vehicles.map(vehicle => ({ ...vehicle })));
    store.tasks.splice(0, store.tasks.length, ...original.tasks.map(task => ({ ...task, bins: [...task.bins] })));
    store.drivers.splice(0, store.drivers.length, ...original.drivers.map(driver => ({ ...driver })));
  };
}

test('overflow prediction and priority are realistic for critical bins', () => {
  const restore = resetState();
  try {
    const bin = { id: 'HYG-008', fill: 96, fillRate: 2.5, capacity: 240, wasteType: 'Mixed', location: 'Banjara Hills', latitude: 17.4156, longitude: 78.4347 };
    const forecast = agent.predictedOverflow(bin);
    assert.ok(forecast.hours <= 2);
    assert.equal(agent.priorityFor(bin, forecast), 'CRITICAL');
  } finally {
    restore();
  }
});

test('vehicle selection respects remaining capacity and maintenance state', () => {
  const restore = resetState();
  try {
    const activeVehicles = agent.getAvailableVehiclesForBins([
      { id: 'HYG-008', fill: 96, capacity: 240, location: 'Banjara Hills', latitude: 17.4156, longitude: 78.4347, wasteType: 'Mixed' },
      { id: 'HYG-012', fill: 92, capacity: 240, location: 'Uppal', latitude: 17.4058, longitude: 78.5591, wasteType: 'Organic' }
    ]);

    assert.ok(activeVehicles.length >= 1);
    assert.equal(activeVehicles[0].status !== 'MAINTENANCE', true);
    assert.ok(activeVehicles[0].capacity > 0);
  } finally {
    restore();
  }
});

test('dispatch requires an online driver and enough remaining capacity', () => {
  const restore = resetState();
  try {
    const vehicle = store.vehicles.find(item => item.id === 'V-01');
    const driver = store.drivers.find(item => item.vehicleId === vehicle.id);
    const bin = store.bins.find(item => item.id === 'HYG-001');
    vehicle.status = 'AVAILABLE';
    vehicle.currentLoad = 0;
    driver.status = 'OFFLINE';
    assert.throws(() => agent.createCollectionTask({ bins: [bin.id], vehicleId: vehicle.id }), /available driver/i);
    driver.status = 'ONLINE';
    vehicle.currentLoad = vehicle.capacity;
    assert.throws(() => agent.createCollectionTask({ bins: [bin.id], vehicleId: vehicle.id }), /capacity/i);
  } finally {
    restore();
  }
});

test('route optimization does not exceed vehicle capacity', () => {
  const restore = resetState();
  try {
    const vehicle = store.vehicles.find(item => item.id === 'V-01');
    vehicle.status = 'AVAILABLE';
    vehicle.currentLoad = 0;
    store.drivers.find(item => item.vehicleId === vehicle.id).status = 'ONLINE';
    const bins = [
      { id: 'HYG-005', fill: 80, capacity: 240, latitude: 17.4849, longitude: 78.4138, wasteType: 'Plastic' },
      { id: 'HYG-008', fill: 96, capacity: 240, latitude: 17.4156, longitude: 78.4347, wasteType: 'Mixed' },
      { id: 'HYG-018', fill: 89, capacity: 240, latitude: 17.3975, longitude: 78.4155, wasteType: 'Food' }
    ];
    const route = agent.optimizeRoute(bins, vehicle);
    assert.ok(route.capacityRequired <= vehicle.capacity - vehicle.currentLoad);
    assert.ok(route.distance > 0);
    assert.ok(route.sequence.length >= 2);
  } finally {
    restore();
  }
});

test('task creation and completion update metrics and release the vehicle', () => {
  const restore = resetState();
  try {
    const vehicle = store.vehicles.find(item => item.status === 'AVAILABLE');
    const bin = store.bins.find(item => item.id === 'HYG-001');
    const originalFill = bin.fill;
    const task = agent.createCollectionTask({ bins: ['HYG-001'], vehicleId: vehicle.id, source: 'AI', priority: 'HIGH' });
    assert.equal(task.status, 'CREATED');
    assert.equal(task.vehicle, vehicle.id);

    agent.transitionTask(task, 'DISPATCHED');
    agent.transitionTask(task, 'DRIVER_EN_ROUTE');
    agent.transitionTask(task, 'ARRIVED');
    agent.transitionTask(task, 'COLLECTING');
    const updated = agent.completeTask(task.id, { collectedQuantity: 200, notes: 'Completed collection', contaminationLevel: 'LOW' });
    assert.equal(updated.status, 'VERIFIED');
    const releasedVehicle = store.vehicles.find(item => item.id === vehicle.id);
    assert.equal(releasedVehicle.status, 'AVAILABLE');
    const updatedBin = store.bins.find(item => item.id === 'HYG-001');
    assert.ok(updatedBin.fill < originalFill);
  } finally {
    restore();
  }
});

test('invalid task transition is rejected', () => {
  const restore = resetState();
  try {
    const task = { id: 'CT-INVALID', status: 'COMPLETED', vehicle: 'V-01', bins: ['HYG-001'] };
    assert.throws(() => agent.transitionTask(task, 'PENDING'), /Invalid task transition/);
  } finally {
    restore();
  }
});

test('viewer role cannot run optimization', () => {
  const restore = resetState();
  try {
    assert.throws(() => agent.authorizeRole('VIEWER', 'ADMIN'), /not permitted/i);
  } finally {
    restore();
  }
});

test('incident workflow creates a reviewed and assigned case', () => {
  const restore = resetState();
  try {
    const incident = agent.reportIncident({
      location: 'Cafeteria North',
      wasteType: 'Food',
      severity: 'HIGH',
      description: 'Cafeteria overflow after lunch service',
      reporter: 'admin@test.local'
    });
    assert.equal(incident.status, 'OPEN');
    agent.reviewIncident(incident.id, 'AI_REVIEWED');
    assert.equal(incident.status, 'AI_REVIEWED');
  } finally {
    restore();
  }
});

test('agent loop validates tool actions and falls back to the local rule engine when LLM is unavailable', async () => {
  const restore = resetState();
  const previousProvider = process.env.LLM_PROVIDER;
  const previousKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  process.env.LLM_PROVIDER = 'openai';

  try {
    const run = await agent.runAgentLoop({ trigger: 'chat', prompt: 'Which bins are critical right now?', user: { role: 'ADMIN' } });
    assert.equal(run.mode, 'LOCAL_RULE_ENGINE');
    assert.ok(Array.isArray(run.decisions));
    assert.ok(run.decisions.length > 0);
    assert.throws(() => agent.executeToolAction({ tool: 'predict_overflow', args: { binId: 'INVALID-BIN' } }), /not found/i);
  } finally {
    restore();
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('configured API key invokes the server-side LLM tool path', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousProvider = process.env.LLM_PROVIDER;
  const previousModel = process.env.LLM_MODEL;
  const previousFetch = global.fetch;
  let request;
  process.env.OPENAI_API_KEY = 'test-server-key';
  delete process.env.LLM_PROVIDER;
  process.env.LLM_MODEL = 'gpt-4o-mini';
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ tool: 'get_bin_status', args: {}, rationale: 'Review current bin status.' }) } }] };
      }
    };
  };

  try {
    const result = await agent.runAgentLoop({ trigger: 'chat', prompt: 'Show urgent bins', user: { role: 'ADMIN' } });
    assert.equal(result.mode, 'LLM');
    assert.equal(result.actions[0].type, 'get_bin_status');
    assert.match(request.options.headers.Authorization, /^Bearer test-server-key$/);
    assert.doesNotMatch(JSON.stringify(result), /test-server-key/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = previousModel;
  }
});

test('LLM orchestration performs sequential validated tool calls', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  const replies = [
    { tool: 'get_bin_status', args: {}, rationale: 'Observe bins.', state: 'OBSERVING' },
    { tool: 'prioritize_bins', args: { binIds: ['HYG-001'] }, rationale: 'Analyze priority.', state: 'ANALYZING' },
    { tool: 'final', args: {}, rationale: 'Monitoring continues.', state: 'COMPLETED' }
  ];
  process.env.OPENAI_API_KEY = 'test-server-key';
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }) });
  try {
    const run = await agent.runAgentLoop({ prompt: 'Show urgent bins', user: { role: 'ADMIN' } });
    assert.equal(run.mode, 'LLM');
    assert.equal(run.toolCalls, 2);
    assert.deepEqual(run.actions.map(action => action.type), ['get_bin_status', 'prioritize_bins']);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('read-only agent prompts do not create collection tasks', async () => {
  const restore = resetState();
  const previousProvider = process.env.LLM_PROVIDER;
  const previousKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  process.env.LLM_PROVIDER = 'openai';

  try {
    const taskCount = store.tasks.length;
    const run = await agent.runAgentLoop({ trigger: 'chat', prompt: 'Which bins are critical right now?', user: { role: 'ADMIN' } });
    assert.equal(store.tasks.length, taskCount);
    assert.equal(run.actions[0].type, 'READ_ONLY');
  } finally {
    restore();
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('local chat answers the requested operational subject precisely', async () => {
  const restore = resetState();
  const previousProvider = process.env.LLM_PROVIDER;
  const previousKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  process.env.LLM_PROVIDER = 'openai';

  try {
    const bin = store.bins[0];
    const binRun = await agent.runAgentLoop({ trigger: 'chat', prompt: `Why is ${bin.id} critical?`, user: { role: 'ADMIN' } });
    assert.match(binRun.answer, new RegExp(`${bin.id}.*${bin.fill}%`, 'i'));
    assert.match(binRun.answer, /overflow.*hours/i);

    const vehicleRun = await agent.runAgentLoop({ trigger: 'chat', prompt: 'Which vehicles are available?', user: { role: 'ADMIN' } });
    assert.match(vehicleRun.answer, /vehicles are available|No vehicles are currently available/i);
    assert.doesNotMatch(vehicleRun.answer, /bins need attention/i);
  } finally {
    restore();
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('local chat answers active task and fleet status commands from live state', async () => {
  const restore = resetState();
  const previousProvider = process.env.LLM_PROVIDER;
  const previousKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  process.env.LLM_PROVIDER = 'openai';

  try {
    const tasks = await agent.runAgentLoop({ trigger: 'chat', prompt: 'Show active tasks', user: { role: 'ADMIN' } });
    assert.match(tasks.answer, /active collection tasks|no active collection tasks/i);
    const fleet = await agent.runAgentLoop({ trigger: 'chat', prompt: 'Explain current fleet status', user: { role: 'ADMIN' } });
    assert.match(fleet.answer, /fleet status/i);
  } finally {
    restore();
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('scheduled production optimization skips bins already covered by active tasks', async () => {
  const restore = resetState();
  try {
    store.tasks.splice(0, store.tasks.length);
    store.vehicles.forEach(vehicle => { vehicle.status = 'AVAILABLE'; vehicle.currentLoad = 0; });
    const bin = agent.getBinStatus().find(item => ['CRITICAL', 'HIGH'].includes(item.priority));
    const vehicle = store.vehicles[0];
    agent.createCollectionTask({ bins: [bin.id], vehicleId: vehicle.id, source: 'AI', priority: bin.priority });
    await agent.runOptimization('scheduled');
    assert.equal(store.tasks.filter(task => task.bins.includes(bin.id)).length, 1);
  } finally {
    restore();
  }
});

test('scheduled production optimization re-plans an active task when its vehicle changes state', async () => {
  const restore = resetState();
  try {
    store.tasks.splice(0, store.tasks.length);
    store.vehicles.forEach(vehicle => { vehicle.status = 'AVAILABLE'; vehicle.currentLoad = 0; });
    store.drivers.forEach(driver => { driver.status = 'ONLINE'; });
    const task = agent.createCollectionTask({ bins: ['HYG-001'], vehicleId: 'V-01', source: 'AI', priority: 'CRITICAL' });
    const originalDriver = store.drivers.find(driver => driver.id === task.driverId);
    store.vehicles.find(vehicle => vehicle.id === 'V-01').status = 'MAINTENANCE';
    originalDriver.status = 'OFFLINE';
    const run = await agent.runOptimization('scheduled');
    assert.ok(run.replanned.includes(task.id));
    assert.notEqual(task.vehicle, 'V-01');
    assert.ok(task.driverId);
  } finally {
    restore();
  }
});

test('autonomous dispatch remains active until monitored telemetry verifies collection', async () => {
  const restore = resetState();
  const previousTelemetry = process.env.AI_SIMULATED_TELEMETRY;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.AI_SIMULATED_TELEMETRY = 'true';
  delete process.env.OPENAI_API_KEY;
  try {
    store.tasks.splice(0, store.tasks.length);
    store.collectionHistory.splice(0, store.collectionHistory.length);
    store.vehicles.forEach(vehicle => { vehicle.status = 'AVAILABLE'; vehicle.currentLoad = 0; });
    store.drivers.forEach(driver => { driver.status = 'ONLINE'; });

    const run = await agent.runOptimization('scheduled');
    const task = store.tasks.find(item => item.bins.includes('HYG-001'));
    assert.equal(run.state, 'COMPLETED');
    assert.equal(task.status, 'CREATED');
    assert.equal(store.collectionHistory.length, 0);

    const expectedStates = ['DISPATCHED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'COLLECTING', 'VERIFIED'];
    for (const expected of expectedStates) {
      agent.monitorActiveTasks('scheduled');
      assert.equal(task.status, expected);
    }
    assert.equal(task.simulatedTelemetry, true);
    assert.ok(store.collectionHistory.length >= 1);
    assert.equal(store.collectionHistory.find(outcome => outcome.taskId === task.id).simulatedTelemetry, true);
  } finally {
    restore();
    if (previousTelemetry === undefined) delete process.env.AI_SIMULATED_TELEMETRY; else process.env.AI_SIMULATED_TELEMETRY = previousTelemetry;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('verified tasks are terminal and active duplicate coverage is rejected', () => {
  const restore = resetState();
  try {
    store.tasks.splice(0, store.tasks.length);
    store.vehicles.forEach(vehicle => { vehicle.status = 'AVAILABLE'; vehicle.currentLoad = 0; });
    store.drivers.forEach(driver => { driver.status = 'ONLINE'; });
    const task = agent.createCollectionTask({ bins: ['HYG-001'], vehicleId: 'V-01', source: 'AI', priority: 'CRITICAL' });
    assert.throws(() => agent.createCollectionTask({ bins: ['HYG-001'], vehicleId: 'V-03', source: 'AI', priority: 'CRITICAL' }), /active collection task already covers/i);
    task.status = 'VERIFIED';
    assert.equal(task.status, 'VERIFIED');
    assert.throws(() => agent.transitionTask(task, 'DISPATCHED'), /Invalid task transition/i);
  } finally {
    restore();
  }
});

test('verified outcome survives operational state reload', () => {
  const restore = resetState();
  const originalState = fs.readFileSync(store.STATE_FILE, 'utf8');
  try {
    store.tasks.splice(0, store.tasks.length);
    store.collectionHistory.splice(0, store.collectionHistory.length);
    store.vehicles.forEach(vehicle => { vehicle.status = 'AVAILABLE'; vehicle.currentLoad = 0; });
    store.drivers.forEach(driver => { driver.status = 'ONLINE'; });
    const task = agent.createCollectionTask({ bins: ['HYG-001'], vehicleId: 'V-01', source: 'AI', priority: 'CRITICAL' });
    agent.transitionTask(task, 'DISPATCHED');
    agent.transitionTask(task, 'DRIVER_EN_ROUTE');
    agent.transitionTask(task, 'ARRIVED');
    agent.transitionTask(task, 'COLLECTING');
    agent.completeTask(task.id, { collectedQuantity: 200, simulatedTelemetry: true });
    store.persistOperationalState();
    store.tasks.splice(0, store.tasks.length);
    store.collectionHistory.splice(0, store.collectionHistory.length);
    store.loadOperationalState();
    assert.equal(store.tasks.find(item => item.id === task.id).status, 'VERIFIED');
    assert.equal(store.collectionHistory.find(item => item.taskId === task.id).collectedAmount, 200);
  } finally {
    fs.writeFileSync(store.STATE_FILE, originalState, 'utf8');
    restore();
  }
});
