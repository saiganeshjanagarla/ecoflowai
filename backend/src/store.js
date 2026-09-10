const wasteTypes = ['Organic', 'Plastic', 'Paper', 'Glass', 'Metal', 'Food', 'Mixed'];

const HYDERABAD = { city: 'Hyderabad', state: 'Telangana', workspace: 'Hyderabad Operations' };
const locationSeeds = [
  ['Gachibowli', 'Gachibowli', 17.4401, 78.3489], ['HITEC City', 'HITEC City', 17.4435, 78.3772],
  ['Madhapur', 'Madhapur', 17.4483, 78.3915], ['Kondapur', 'Kondapur', 17.4580, 78.3630],
  ['Kukatpally', 'Kukatpally', 17.4849, 78.4138], ['Miyapur', 'Miyapur', 17.4969, 78.3560],
  ['Jubilee Hills', 'Jubilee Hills', 17.4326, 78.4071], ['Banjara Hills', 'Banjara Hills', 17.4156, 78.4347],
  ['Begumpet', 'Begumpet', 17.4447, 78.4660], ['Ameerpet', 'Ameerpet', 17.4375, 78.4483],
  ['Secunderabad', 'Secunderabad', 17.4399, 78.4983], ['Tarnaka', 'Tarnaka', 17.4285, 78.5420],
  ['Uppal', 'Uppal', 17.4058, 78.5591], ['LB Nagar', 'LB Nagar', 17.3457, 78.5522],
  ['Dilsukhnagar', 'Dilsukhnagar', 17.3688, 78.5247], ['Mehdipatnam', 'Mehdipatnam', 17.3930, 78.4380],
  ['Tolichowki', 'Tolichowki', 17.3975, 78.4155], ['Masab Tank', 'Masab Tank', 17.4015, 78.4530],
  ['Khairatabad', 'Khairatabad', 17.4150, 78.4570], ['Somajiguda', 'Somajiguda', 17.4254, 78.4582],
  ['Punjagutta', 'Punjagutta', 17.4283, 78.4483], ['Nallagandla', 'Nallagandla', 17.4697, 78.3055],
  ['Manikonda', 'Manikonda', 17.4062, 78.3830], ['Narsingi', 'Narsingi', 17.3904, 78.3423],
  ['Kokapet', 'Kokapet', 17.3900, 78.3147], ['Financial District', 'Financial District', 17.4210, 78.3340],
  ['Nanakramguda', 'Nanakramguda', 17.4145, 78.3440], ['Raidurg', 'Raidurg', 17.4310, 78.3770],
  ['Shamshabad', 'Shamshabad', 17.2403, 78.4294]
];

const bins = Array.from({ length: 24 }, (_, index) => {
  const [location, area, latitude, longitude] = locationSeeds[index % locationSeeds.length];
  const fill = [96, 88, 76, 63, 42, 94, 71, 57, 82, 64, 90, 48, 79, 68, 54, 92, 73, 61, 87, 59, 66, 81, 95, 51][index % 24];
  const rate = Number((1.2 + (index % 5) * 0.55).toFixed(1));
  return {
    id: `HYG-${String(index + 1).padStart(3, '0')}`,
    name: `${location} Collection Point ${index + 1}`,
    location,
    area,
    city: HYDERABAD.city,
    state: HYDERABAD.state,
    latitude,
    longitude,
    wasteType: wasteTypes[index % wasteTypes.length],
    capacity: 240 + (index % 3) * 80,
    fill,
    fillRate: rate,
    temperature: 24 + (index % 7),
    battery: 78 + (index % 4) * 5,
    lastCollected: new Date(Date.now() - (index + 1) * 3600000 * 4).toISOString(),
    sensorStatus: index === 11 ? 'DEGRADED' : 'ONLINE',
    priority: fill >= 95 ? 'CRITICAL' : fill >= 85 ? 'HIGH' : fill >= 70 ? 'MEDIUM' : 'LOW',
    predictedOverflowTime: null,
    status: fill >= 95 ? 'CRITICAL' : fill >= 85 ? 'HIGH' : fill >= 70 ? 'MEDIUM' : 'NORMAL',
    workspace: HYDERABAD.workspace,
    nextScheduledCollection: new Date(Date.now() + (index + 1) * 3600000).toISOString()
  };
});

const vehicles = Array.from({ length: 6 }, (_, index) => ({
  id: `V-${String(index + 1).padStart(2, '0')}`,
  registration: `TS-09-EF-${String(2400 + index)}`,
  type: index % 2 ? 'Compactor' : 'Electric tipper',
  capacity: 900 + (index % 3) * 300,
  currentLoad: index === 1 ? 430 : index === 3 ? 240 : 0,
  location: locationSeeds[index * 3 % locationSeeds.length][0],
  driver: ['Raj Kumar', 'Ananya Rao', 'Vikram Reddy', 'Priya Nair', 'Arjun Das', 'Sana Ali'][index],
  status: index === 1 ? 'ASSIGNED' : index === 4 ? 'MAINTENANCE' : 'AVAILABLE',
  fuelLevel: 74 + index * 6,
  lastService: new Date(Date.now() - (index + 1) * 86400000 * 8).toISOString()
}));

const drivers = [
  { id: 'D-001', name: 'Raj Kumar', phone: '+91 90000 10001', licenseNumber: 'TS09-DRV-1001', vehicleId: 'V-01', status: 'ONLINE', location: 'Kukatpally', completedTasks: 48, rating: 4.8, lastActive: new Date().toISOString() },
  { id: 'D-002', name: 'Ananya Rao', phone: '+91 90000 10002', licenseNumber: 'TS09-DRV-1002', vehicleId: 'V-02', status: 'ON_ROUTE', location: 'HITEC City', completedTasks: 54, rating: 4.9, lastActive: new Date().toISOString() },
  { id: 'D-003', name: 'Vikram Reddy', phone: '+91 90000 10003', licenseNumber: 'TS09-DRV-1003', vehicleId: 'V-03', status: 'ONLINE', location: 'Gachibowli', completedTasks: 41, rating: 4.7, lastActive: new Date().toISOString() },
  { id: 'D-004', name: 'Priya Nair', phone: '+91 90000 10004', licenseNumber: 'TS09-DRV-1004', vehicleId: 'V-04', status: 'BUSY', location: 'Banjara Hills', completedTasks: 63, rating: 4.9, lastActive: new Date().toISOString() },
  { id: 'D-005', name: 'Arjun Das', phone: '+91 90000 10005', licenseNumber: 'TS09-DRV-1005', vehicleId: 'V-05', status: 'OFFLINE', location: 'Uppal', completedTasks: 36, rating: 4.5, lastActive: new Date(Date.now() - 3600000).toISOString() },
  { id: 'D-006', name: 'Sana Ali', phone: '+91 90000 10006', licenseNumber: 'TS09-DRV-1006', vehicleId: 'V-06', status: 'ON_BREAK', location: 'Somajiguda', completedTasks: 39, rating: 4.6, lastActive: new Date().toISOString() }
];

const tasks = [
  { id: 'CT-1048', priority: 'HIGH', source: 'AI', bins: ['HYG-002', 'HYG-003'], vehicle: 'V-02', driver: 'Ananya Rao', assigneeId: 'U-002', routeId: 'HYD-RT-002', distance: 5.8, duration: 32, status: 'IN_PROGRESS', reason: 'HYG-002 in HITEC City is predicted to overflow in 2h 10m.', createdAt: new Date().toISOString(), collectedQuantity: 0, notes: '', contaminationLevel: 'MEDIUM' },
  { id: 'CT-1047', priority: 'MEDIUM', source: 'MANUAL', bins: ['HYG-005'], vehicle: 'V-01', driver: 'Raj Kumar', assigneeId: 'U-002', routeId: 'HYD-RT-003', distance: 3.2, duration: 18, status: 'COMPLETED', reason: 'Scheduled Kukatpally collection.', createdAt: new Date().toISOString(), collectedQuantity: 260, notes: 'Routine collection', contaminationLevel: 'LOW' },
  { id: 'CT-1046', priority: 'CRITICAL', source: 'AI', bins: ['HYG-008'], vehicle: 'V-04', driver: 'Priya Nair', assigneeId: 'U-002', routeId: 'HYD-RT-004', distance: 7.1, duration: 41, status: 'PENDING', reason: 'HYG-008 in Banjara Hills is at 96% capacity.', createdAt: new Date().toISOString(), collectedQuantity: 0, notes: '', contaminationLevel: 'MEDIUM' }
];

const notifications = [
  { id: 'N-1', type: 'OVERFLOW_WARNING', title: 'Overflow risk detected', body: 'HYG-001 in Gachibowli may overflow in 1h 42m.', time: '8 min ago', read: false },
  { id: 'N-2', type: 'AI_RECOMMENDATION', title: 'Hyderabad route optimized', body: 'Combining Madhapur and HITEC City stops saves 2.4 km.', time: '22 min ago', read: false },
  { id: 'N-3', type: 'VEHICLE_ISSUE', title: 'Vehicle V-05 maintenance', body: 'Vehicle unavailable until inspection is complete.', time: '1 hr ago', read: true }
];

const incidents = [
  { id: 'INC-1001', type: 'PREDICTED_OVERFLOW', location: 'Gachibowli', severity: 'HIGH', description: 'HYG-001 is forecast to reach overflow capacity within two hours.', relatedBinId: 'HYG-001', status: 'OPEN', reportedAt: new Date(Date.now() - 8 * 60000).toISOString(), aiReview: 'LOCAL_RULE_ENGINE' },
  { id: 'INC-1002', type: 'VEHICLE_ISSUE', location: 'Uppal', severity: 'MEDIUM', description: 'V-05 is unavailable pending scheduled maintenance inspection.', relatedVehicleId: 'V-05', status: 'ACKNOWLEDGED', reportedAt: new Date(Date.now() - 3600000).toISOString(), aiReview: null }
];
const auditLogs = [];
const aiRuns = [];
const agents = [
  { id: 'AG-ROUTE', name: 'Route Optimization Agent', status: 'ONLINE', lastHeartbeat: new Date().toISOString(), currentTask: 'Reviewing critical bin clusters', tasksProcessed: 128, successRate: 96, lastAction: 'Recalculated HYD-RT-002', processingTimeMs: 420 },
  { id: 'AG-PREDICT', name: 'Prediction Agent', status: 'BUSY', lastHeartbeat: new Date().toISOString(), currentTask: 'Forecasting overflow risk', tasksProcessed: 342, successRate: 94, lastAction: 'Flagged HYG-001', processingTimeMs: 180 },
  { id: 'AG-DISPATCH', name: 'Dispatch Agent', status: 'IDLE', lastHeartbeat: new Date().toISOString(), currentTask: 'Awaiting new dispatch request', tasksProcessed: 87, successRate: 98, lastAction: 'Assigned CT-1048 to V-02', processingTimeMs: 260 },
  { id: 'AG-ALERT', name: 'Alert Agent', status: 'ONLINE', lastHeartbeat: new Date().toISOString(), currentTask: 'Monitoring operational signals', tasksProcessed: 216, successRate: 97, lastAction: 'Acknowledged V-05 issue', processingTimeMs: 110 },
  { id: 'AG-ANALYTICS', name: 'Analytics Agent', status: 'ONLINE', lastHeartbeat: new Date().toISOString(), currentTask: 'Refreshing area statistics', tasksProcessed: 64, successRate: 99, lastAction: 'Updated Hyderabad waste trend', processingTimeMs: 350 }
];
const defaultSettings = {
  organizationName: 'EcoFlow AI', operatingCity: 'Hyderabad, Telangana', timeZone: 'Asia/Kolkata', dateFormat: 'DD MMM YYYY', overflowThreshold: 85, vehicleLoadWarning: 80, criticalAlerts: true, vehicleAlerts: true, taskAlerts: true, agentAlerts: true, mapCenter: [17.3850, 78.4867], mapZoom: 11, version: '1.0.0-demo'
};
const settings = { ...defaultSettings, mapCenter: [...defaultSettings.mapCenter] };
const routeSeeds = [['HYD-RT-001', 'Gachibowli → Nanakramguda → Financial District → Kokapet'], ['HYD-RT-002', 'Madhapur → HITEC City → Kondapur → Kothaguda'], ['HYD-RT-003', 'Kukatpally → KPHB → Miyapur'], ['HYD-RT-004', 'Jubilee Hills → Banjara Hills → Punjagutta → Somajiguda'], ['HYD-RT-005', 'Uppal → Tarnaka → Secunderabad'], ['HYD-RT-006', 'LB Nagar → Dilsukhnagar → Kothapet'], ['HYD-RT-007', 'Mehdipatnam → Tolichowki → Masab Tank']];
const routes = routeSeeds.map(([id, name], index) => ({ id, name, bins: tasks[index % tasks.length].bins, operatorId: 'U-002', vehicleId: `V-${String((index % 6) + 1).padStart(2, '0')}`, status: index === 1 ? 'IN_PROGRESS' : 'PLANNED', distance: 8 + index * 1.7, createdAt: new Date().toISOString(), stops: name.split(' → ') }));
const locationRecords = locationSeeds.map(([name, area, latitude, longitude]) => ({ id: `LOC-${name.toUpperCase().replace(/[^A-Z]+/g, '-').replace(/^-|-$/g, '')}`, name, area, city: HYDERABAD.city, state: HYDERABAD.state, latitude, longitude, workspace: HYDERABAD.workspace }));
const readings = Array.from({ length: 14 }, (_, day) => ({
  day: `Day ${day + 1}`, total: 330 + ((day * 47) % 120), organic: 130 + ((day * 13) % 42), plastic: 72 + ((day * 7) % 25), recycled: 170 + ((day * 17) % 50)
}));

const agentRuns = [];
const agentDecisions = [];
const agentTimeline = [];

function resetDemoState() {
  const sourceBins = Array.from({ length: 24 }, (_, index) => {
    const [location, area, latitude, longitude] = locationSeeds[index % locationSeeds.length];
    const fill = [96, 88, 76, 63, 42, 94, 71, 57, 82, 64, 90, 48, 79, 68, 54, 92, 73, 61, 87, 59, 66, 81, 95, 51][index % 24];
    const rate = Number((1.2 + (index % 5) * 0.55).toFixed(1));
    return {
      id: `HYG-${String(index + 1).padStart(3, '0')}`,
      name: `${location} Collection Point ${index + 1}`,
      location,
      area,
      city: HYDERABAD.city,
      state: HYDERABAD.state,
      latitude,
      longitude,
      wasteType: wasteTypes[index % wasteTypes.length],
      capacity: 240 + (index % 3) * 80,
      fill,
      fillRate: rate,
      temperature: 24 + (index % 7),
      battery: 78 + (index % 4) * 5,
      lastCollected: new Date(Date.now() - (index + 1) * 3600000 * 4).toISOString(),
      sensorStatus: index === 11 ? 'DEGRADED' : 'ONLINE',
      priority: fill >= 95 ? 'CRITICAL' : fill >= 85 ? 'HIGH' : fill >= 70 ? 'MEDIUM' : 'LOW',
      predictedOverflowTime: null,
      status: fill >= 95 ? 'CRITICAL' : fill >= 85 ? 'HIGH' : fill >= 70 ? 'MEDIUM' : 'NORMAL',
      workspace: HYDERABAD.workspace,
      nextScheduledCollection: new Date(Date.now() + (index + 1) * 3600000).toISOString()
    };
  });

  const sourceVehicles = Array.from({ length: 6 }, (_, index) => ({
    id: `V-${String(index + 1).padStart(2, '0')}`,
    registration: `TS-09-EF-${String(2400 + index)}`,
    type: index % 2 ? 'Compactor' : 'Electric tipper',
    capacity: 900 + (index % 3) * 300,
    currentLoad: index === 1 ? 430 : index === 3 ? 240 : 0,
    location: locationSeeds[index * 3 % locationSeeds.length][0],
    driver: ['Raj Kumar', 'Ananya Rao', 'Vikram Reddy', 'Priya Nair', 'Arjun Das', 'Sana Ali'][index],
    status: index === 1 ? 'ASSIGNED' : index === 4 ? 'MAINTENANCE' : 'AVAILABLE',
    fuelLevel: 74 + index * 6,
    lastService: new Date(Date.now() - (index + 1) * 86400000 * 8).toISOString()
  }));

  const sourceTasks = [
    { id: 'CT-1048', priority: 'HIGH', source: 'AI', bins: ['HYG-002', 'HYG-003'], vehicle: 'V-02', driver: 'Ananya Rao', assigneeId: 'U-002', routeId: 'HYD-RT-002', distance: 5.8, duration: 32, status: 'IN_PROGRESS', reason: 'HYG-002 in HITEC City is predicted to overflow in 2h 10m.', createdAt: new Date().toISOString(), collectedQuantity: 0, notes: '', contaminationLevel: 'MEDIUM' },
    { id: 'CT-1047', priority: 'MEDIUM', source: 'MANUAL', bins: ['HYG-005'], vehicle: 'V-01', driver: 'Raj Kumar', assigneeId: 'U-002', routeId: 'HYD-RT-003', distance: 3.2, duration: 18, status: 'COMPLETED', reason: 'Scheduled Kukatpally collection.', createdAt: new Date().toISOString(), collectedQuantity: 260, notes: 'Routine collection', contaminationLevel: 'LOW' },
    { id: 'CT-1046', priority: 'CRITICAL', source: 'AI', bins: ['HYG-008'], vehicle: 'V-04', driver: 'Priya Nair', assigneeId: 'U-002', routeId: 'HYD-RT-004', distance: 7.1, duration: 41, status: 'PENDING', reason: 'HYG-008 in Banjara Hills is at 96% capacity.', createdAt: new Date().toISOString(), collectedQuantity: 0, notes: '', contaminationLevel: 'MEDIUM' }
  ];

  const sourceIncidents = [
    { id: 'INC-1001', type: 'PREDICTED_OVERFLOW', location: 'Gachibowli', severity: 'HIGH', description: 'HYG-001 is forecast to reach overflow capacity within two hours.', relatedBinId: 'HYG-001', status: 'OPEN', reportedAt: new Date(Date.now() - 8 * 60000).toISOString(), aiReview: 'LOCAL_RULE_ENGINE' },
    { id: 'INC-1002', type: 'VEHICLE_ISSUE', location: 'Uppal', severity: 'MEDIUM', description: 'V-05 is unavailable pending scheduled maintenance inspection.', relatedVehicleId: 'V-05', status: 'ACKNOWLEDGED', reportedAt: new Date(Date.now() - 3600000).toISOString(), aiReview: null }
  ];

  const sourceNotifications = [
    { id: 'N-1', type: 'OVERFLOW_WARNING', title: 'Overflow risk detected', body: 'HYG-001 in Gachibowli may overflow in 1h 42m.', time: '8 min ago', read: false },
    { id: 'N-2', type: 'AI_RECOMMENDATION', title: 'Hyderabad route optimized', body: 'Combining Madhapur and HITEC City stops saves 2.4 km.', time: '22 min ago', read: false },
    { id: 'N-3', type: 'VEHICLE_ISSUE', title: 'Vehicle V-05 maintenance', body: 'Vehicle unavailable until inspection is complete.', time: '1 hr ago', read: true }
  ];

  bins.splice(0, bins.length, ...sourceBins);
  vehicles.splice(0, vehicles.length, ...sourceVehicles);
  tasks.splice(0, tasks.length, ...sourceTasks);
  incidents.splice(0, incidents.length, ...sourceIncidents);
  notifications.splice(0, notifications.length, ...sourceNotifications);
  auditLogs.splice(0, auditLogs.length, ...[]);
  aiRuns.splice(0, aiRuns.length, ...[]);
  agentRuns.splice(0, agentRuns.length, ...[]);
  agentDecisions.splice(0, agentDecisions.length, ...[]);
  agentTimeline.splice(0, agentTimeline.length, ...[]);
  routes.splice(0, routes.length, ...routeSeeds.map(([id, name], index) => ({ id, name, bins: tasks[index % tasks.length].bins, operatorId: 'U-002', vehicleId: `V-${String((index % 6) + 1).padStart(2, '0')}`, status: index === 1 ? 'IN_PROGRESS' : 'PLANNED', distance: 8 + index * 1.7, createdAt: new Date().toISOString(), stops: name.split(' → ') })));
}

module.exports = { bins, vehicles, drivers, tasks, routes, locations: locationRecords, notifications, incidents, auditLogs, aiRuns, agentRuns, agentDecisions, agentTimeline, agents, settings, defaultSettings, readings, wasteTypes, resetDemoState };