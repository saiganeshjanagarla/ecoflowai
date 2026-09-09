const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('./agent');
const store = require('./store');

function resetState() {
  const original = {
    bins: store.bins.map(bin => ({ ...bin })),
    vehicles: store.vehicles.map(vehicle => ({ ...vehicle })),
    tasks: store.tasks.map(task => ({ ...task, bins: [...task.bins] }))
  };

  return () => {
    store.bins.splice(0, store.bins.length, ...original.bins.map(bin => ({ ...bin })));
    store.vehicles.splice(0, store.vehicles.length, ...original.vehicles.map(vehicle => ({ ...vehicle })));
    store.tasks.splice(0, store.tasks.length, ...original.tasks.map(task => ({ ...task, bins: [...task.bins] })));
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

test('route optimization does not exceed vehicle capacity', () => {
  const restore = resetState();
  try {
    const vehicle = store.vehicles.find(item => item.status === 'AVAILABLE');
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
    assert.equal(task.status, 'PENDING');
    assert.equal(task.vehicle, vehicle.id);

    const updated = agent.completeTask(task.id, { collectedQuantity: 320, notes: 'Completed collection', contaminationLevel: 'LOW' });
    assert.equal(updated.status, 'COMPLETED');
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
