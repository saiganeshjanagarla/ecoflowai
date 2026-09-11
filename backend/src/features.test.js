const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('./agent');
const store = require('./store');

function resetState() {
  store.resetDemoState();
  const original = {
    bins: store.bins.map(bin => ({ ...bin })),
    vehicles: store.vehicles.map(vehicle => ({ ...vehicle })),
    tasks: store.tasks.map(task => ({ ...task, bins: [...task.bins] })),
    drivers: store.drivers.map(driver => ({ ...driver })),
    telemetry: store.telemetry ? store.telemetry.map(reading => ({ ...reading })) : [],
    publicReports: store.publicReports ? store.publicReports.map(report => ({ ...report })) : []
  };

  return () => {
    store.bins.splice(0, store.bins.length, ...original.bins.map(bin => ({ ...bin })));
    store.vehicles.splice(0, store.vehicles.length, ...original.vehicles.map(vehicle => ({ ...vehicle })));
    store.tasks.splice(0, store.tasks.length, ...original.tasks.map(task => ({ ...task, bins: [...task.bins] })));
    store.drivers.splice(0, store.drivers.length, ...original.drivers.map(driver => ({ ...driver })));
    if (store.telemetry) {
      store.telemetry.splice(0, store.telemetry.length, ...original.telemetry.map(reading => ({ ...reading })));
    }
    if (store.publicReports) {
      store.publicReports.splice(0, store.publicReports.length, ...original.publicReports.map(report => ({ ...report })));
    }
  };
}

test('telemetry validation accepts valid readings and rejects impossible values', () => {
  const restore = resetState();
  try {
    const accepted = agent.handleTelemetry({
      binId: 'HYG-001',
      fillLevel: 91,
      weightKg: 61.4,
      temperature: 31.2,
      humidity: 58,
      timestamp: new Date().toISOString(),
      source: 'iot',
      sensorId: 'ESP32-HYG-001'
    }, { role: 'ADMIN' });

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.binId, 'HYG-001');
    assert.equal(store.bins.find(bin => bin.id === 'HYG-001').fill, 91);

    assert.throws(() => agent.handleTelemetry({
      binId: 'HYG-001',
      fillLevel: 150,
      weightKg: 10,
      timestamp: new Date().toISOString(),
      source: 'iot',
      sensorId: 'ESP32-HYG-001'
    }, { role: 'ADMIN' }), /fill level/i);

    assert.throws(() => agent.handleTelemetry({
      binId: 'HYG-001',
      fillLevel: 55,
      weightKg: -2,
      timestamp: new Date().toISOString(),
      source: 'iot',
      sensorId: 'ESP32-HYG-001'
    }, { role: 'ADMIN' }), /weight/i);

    assert.throws(() => agent.handleTelemetry({
      binId: 'HYG-001',
      fillLevel: 55,
      weightKg: 10,
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
      source: 'iot',
      sensorId: 'ESP32-HYG-001'
    }, { role: 'ADMIN' }), /stale|timestamp/i);
  } finally {
    restore();
  }
});

test('prediction combines sensor, weekday, and historical signals while generating confidence', () => {
  const restore = resetState();
  try {
    const bin = store.bins.find(item => item.id === 'HYG-001');
    bin.fill = 72;
    store.history = store.history || [];
    store.history.push({ date: '2026-09-04', dayOfWeek: 'FRIDAY', binId: 'HYG-001', time: '08:00', fillLevel: 82, collectedKg: 58 });
    store.history.push({ date: '2026-09-11', dayOfWeek: 'FRIDAY', binId: 'HYG-001', time: '08:00', fillLevel: 88, collectedKg: 60 });

    const prediction = agent.predictBinFill('HYG-001', new Date('2026-09-11T08:00:00Z'));
    assert.equal(prediction.binId, 'HYG-001');
    assert.ok(prediction.predictedFill3h >= 90);
    assert.ok(prediction.confidence > 0.5);
    assert.match(prediction.overflowRisk, /HIGH|CRITICAL/);
    assert.ok(Array.isArray(prediction.factors));
  } finally {
    restore();
  }
});

test('public reports accept photo upload and link to a bin', () => {
  const restore = resetState();
  try {
    const report = agent.submitPublicReport({
      issueType: 'OVERFLOWING_BIN',
      photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAF',
      latitude: 17.4,
      longitude: 78.4,
      description: 'Garbage overflowing from bin',
      timestamp: new Date().toISOString(),
      binId: 'HYG-001',
      status: 'SUBMITTED',
      source: 'public'
    }, { role: 'PUBLIC' });

    assert.match(report.status, /OPEN|IN_PROGRESS/);
    assert.equal(report.linkedBinId, 'HYG-001');
    assert.match(report.photoPath || report.photo, /\.png|uploads|data:image/);
    assert.equal(store.publicReports.length > 0, true);
  } finally {
    restore();
  }
});

test('public report response task resolves the report and notifies only after verification', () => {
  const restore = resetState();
  const originalReports = store.publicReports.map(report => ({ ...report }));
  const originalNotifications = store.notifications.map(notification => ({ ...notification }));
  const originalTimeline = store.agentTimeline.map(item => ({ ...item }));
  try {
    const report = agent.submitPublicReport({ issueType: 'OVERFLOWING_BIN', photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAF', latitude: 17.4401, longitude: 78.3489, description: 'Overflowing bin' }, { role: 'PUBLIC' });
    assert.equal(report.status, 'IN_PROGRESS');
    assert.ok(report.taskId);
    assert.equal(store.notifications.some(item => item.type === 'PUBLIC_REPORT_RESOLVED' && item.reportId === report.id), false);
    const task = store.tasks.find(item => item.id === report.taskId);
    agent.transitionTask(task, 'DISPATCHED');
    agent.transitionTask(task, 'DRIVER_EN_ROUTE');
    agent.transitionTask(task, 'ARRIVED');
    agent.transitionTask(task, 'COLLECTING');
    agent.completeTask(task.id, { collectedQuantity: 100, notes: 'Issue cleared', contaminationLevel: 'LOW' });
    assert.equal(store.publicReports.find(item => item.id === report.id).status, 'RESOLVED');
    assert.ok(store.publicReports.find(item => item.id === report.id).resolvedAt);
    assert.equal(store.notifications.some(item => item.type === 'PUBLIC_REPORT_RESOLVED' && item.reportId === report.id && !item.recipientId && !item.recipientEmail), true);
    assert.ok(store.agentTimeline.some(item => item.action === 'TASK_CREATED' && item.result?.reportId === report.id));
    assert.ok(store.agentTimeline.some(item => item.action === 'USER_NOTIFIED' && item.result?.reportId === report.id));
  } finally {
    store.publicReports.splice(0, store.publicReports.length, ...originalReports);
    store.notifications.splice(0, store.notifications.length, ...originalNotifications);
    store.agentTimeline.splice(0, store.agentTimeline.length, ...originalTimeline);
    restore();
  }
});

test('public report remains open and creates an alert when no suitable fleet exists', () => {
  const restore = resetState();
  const originalReports = store.publicReports.map(report => ({ ...report }));
  const originalIncidents = store.incidents.map(incident => ({ ...incident }));
  try {
    store.vehicles.forEach(vehicle => { vehicle.status = 'MAINTENANCE'; });
    const report = agent.submitPublicReport({ issueType: 'ILLEGAL_DUMPING', photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAF', latitude: 17.4401, longitude: 78.3489, description: 'Dumped waste' }, { role: 'PUBLIC' });
    assert.equal(report.status, 'OPEN');
    assert.equal(report.currentAction, 'NO_FLEET_AVAILABLE');
    assert.ok(store.incidents.some(item => item.relatedReportId === report.id));
  } finally {
    store.publicReports.splice(0, store.publicReports.length, ...originalReports);
    store.incidents.splice(0, store.incidents.length, ...originalIncidents);
    restore();
  }
});
