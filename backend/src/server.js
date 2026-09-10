require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const store = require('./store');
const agent = require('./agent');
const { authenticateUser, getProfile, updateProfile, issueToken, requireAuth, requireRole, requirePermission, listUsers, createUser, updateUser, deleteUser, findUser, ROLES } = require('./auth');

const app = express();
const port = process.env.PORT || 4000;
const automationIntervalMs = Math.max(60000, Number(process.env.AI_AUTOMATION_INTERVAL_MS) || 300000);
const automation = {
  enabled: process.env.AI_AUTOMATION_ENABLED !== 'false',
  intervalMs: automationIntervalMs,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null
};
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(origin => origin.trim());
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed by CORS'));
} }));
app.use(express.json());

const getDashboardState = (workspaceName = 'Hyderabad Operations', user = null) => {
  const visibleTasks = user?.role === 'OPERATOR' ? store.tasks.filter(task => task.assigneeId === user.sub) : store.tasks;
  const bins = agent.getWorkspaceBins(workspaceName).map(bin => {
    const forecast = agent.predictedOverflow(bin);
    const priority = agent.priorityFor(bin, forecast);
    return {
      ...bin,
      forecast,
      priority,
      predictedOverflowTime: forecast.at,
      status: priority === 'CRITICAL' ? 'CRITICAL' : priority === 'HIGH' ? 'HIGH' : priority === 'MEDIUM' ? 'MEDIUM' : 'NORMAL'
    };
  });
  const critical = bins.filter(bin => bin.priority === 'CRITICAL').length;
  const high = bins.filter(bin => bin.priority === 'HIGH').length;
  const activeTasks = visibleTasks.filter(task => !['VERIFIED', 'COMPLETED', 'CANCELLED'].includes(task.status)).length;
  const totalWasteGenerated = bins.reduce((sum, bin) => sum + Math.max(0, bin.fill * (bin.capacity / 100)), 0);
  const completedTasks = visibleTasks.filter(task => ['COMPLETED', 'VERIFIED'].includes(task.status));
  const totalWasteCollected = completedTasks.reduce((sum, task) => sum + (task.collectedQuantity || 0), 0);
  const diversion = totalWasteCollected > 0 ? Math.min(95, Math.round((totalWasteCollected / Math.max(totalWasteGenerated, 1)) * 100)) : 0;
  const routeDistance = Number(visibleTasks.reduce((sum, task) => sum + (task.distance || 0), 0).toFixed(1));
  const routeEfficiency = Math.max(70, Math.min(97, Math.round(100 - (routeDistance / Math.max(totalWasteGenerated / 16, 1)))));
  const recyclingRate = Math.max(35, Math.min(95, Math.round((bins.filter(bin => ['Organic', 'Paper', 'Glass'].includes(bin.wasteType)).reduce((sum, bin) => sum + bin.fill, 0) / Math.max(bins.length, 1)))));
  return {
    metrics: {
      totalBins: bins.length,
      criticalBins: critical,
      overflowRisk: critical + high,
      todaysWaste: Math.round(totalWasteGenerated),
      activeTasks,
      availableVehicles: store.vehicles.filter(vehicle => vehicle.status === 'AVAILABLE').length,
      assignedRoutes: store.routes.filter(route => !['COMPLETED', 'CANCELLED'].includes(route.status)).length,
      criticalAlerts: store.incidents.filter(item => item.severity === 'CRITICAL' && item.status !== 'RESOLVED').length,
      onlineAgents: store.agents.filter(item => ['ONLINE', 'BUSY'].includes(item.status)).length,
      overflowPredictions: bins.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).length,
      estimatedSavings: Math.round(totalWasteCollected * 0.56 * 18 + routeDistance * 24),
      ecoScore: Math.max(60, Math.min(98, 72 + Math.round(diversion / 2))),
      totalWasteGenerated: Math.round(totalWasteGenerated),
      totalWasteCollected,
      diversionPercentage: diversion,
      recyclingRate,
      routeEfficiency,
      overflowIncidents: store.incidents.filter(item => item.status !== 'RESOLVED').length,
      completedCollections: completedTasks.length,
      taskCompletionRate: visibleTasks.length ? Math.round((completedTasks.length / visibleTasks.length) * 100) : 0,
      vehicleUtilization: store.vehicles.length ? Math.round((store.vehicles.filter(v => ['ASSIGNED', 'EN_ROUTE', 'COLLECTING'].includes(v.status)).length / store.vehicles.length) * 100) : 0,
      driverUtilization: store.drivers.length ? Math.round((store.drivers.filter(d => d.status === 'ON_ROUTE').length / store.drivers.length) * 100) : 0,
      routeDistance,
      estimatedFuel: Number((routeDistance * 0.16).toFixed(1))
    },
    wasteTrend: store.readings,
    categoryMix: bins.reduce((result, bin) => {
      const found = result.find(item => item.name === bin.wasteType);
      if (found) found.value += Math.max(5, Math.round((bin.fill / 100) * 100));
      else result.push({ name: bin.wasteType, value: Math.max(5, Math.round((bin.fill / 100) * 100)) });
      return result;
    }, []).slice(0, 5),
    incidents: store.incidents.slice(0, 4),
    bins
  };
};

app.get('/api/health', (_, res) => res.json({ status: 'ok', service: 'ecoflow-api' }));
app.post('/api/auth/login', (req, res) => {
  const user = authenticateUser(req.body?.email, req.body?.password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: user.email, role: user.role, action: 'User login', resource: 'user', resourceId: user.id, timestamp: new Date().toISOString(), metadata: {} });
  res.json({ token: issueToken(user), user: { id: user.id, email: user.email, name: user.name, role: user.role, workspace: user.workspace, notifications: user.notifications, autoRefresh: user.autoRefresh } });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: getProfile(req.user) }));
app.patch('/api/auth/profile', requireAuth, (req, res) => {
  const schema = z.object({
    workspace: z.string().min(1).optional(),
    notifications: z.boolean().optional(),
    autoRefresh: z.boolean().optional()
  });

  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid profile update', details: parsed.error.flatten() });

  const profile = updateProfile(req.user, parsed.data);
  res.json({ user: profile });
});
app.get('/api/users', requireAuth, requirePermission('users.read'), (_, res) => res.json(listUsers()));
app.post('/api/users', requireAuth, requirePermission('users.create'), (req, res) => {
  const schema = z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().max(30).optional(), role: z.enum(Object.values(ROLES)), password: z.string().min(6) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid user payload', details: parsed.error.flatten() });
  try {
    const user = createUser(parsed.data);
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Created user', resource: 'user', resourceId: user.id, timestamp: new Date().toISOString(), metadata: { role: user.role } });
    res.status(201).json(user);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/users/:id', requireAuth, requirePermission('users.update'), (req, res) => {
  const schema = z.object({ name: z.string().min(1).optional(), email: z.string().email().optional(), phone: z.string().max(30).optional(), role: z.enum(Object.values(ROLES)).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), password: z.string().min(6).optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid user update', details: parsed.error.flatten() });
  if (req.params.id === req.user.sub && parsed.data.status === 'DISABLED') return res.status(400).json({ error: 'You cannot disable your own account' });
  try {
    const found = findUser(req.params.id);
    const before = found && { role: found.role, status: found.status, name: found.name, email: found.email };
    if (!before) return res.status(404).json({ error: 'User not found' });
    const user = updateUser(req.params.id, parsed.data);
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Updated user', resource: 'user', resourceId: user.id, timestamp: new Date().toISOString(), metadata: { before: { role: before.role, status: before.status }, after: { role: user.role, status: user.status } } });
    res.json(user);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/users/:id', requireAuth, requirePermission('users.delete'), (req, res) => {
  if (req.params.id === req.user.sub) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (!deleteUser(req.params.id)) return res.status(404).json({ error: 'User not found' });
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Deleted user', resource: 'user', resourceId: req.params.id, timestamp: new Date().toISOString(), metadata: {} });
  res.json({ success: true, id: req.params.id });
});
app.get('/api/dashboard', requireAuth, (req, res) => res.json(getDashboardState(req.user.workspace || req.query.workspace || 'Hyderabad Operations', req.user)));
app.get('/api/map', requireAuth, (req, res) => {
  const workspaceName = req.user.workspace || req.query.workspace || 'Hyderabad Operations';
  const payload = {
    bins: agent.getWorkspaceBins(workspaceName),
    vehicles: store.vehicles,
    tasks: store.tasks,
    routes: store.routes,
    alerts: store.incidents,
    center: { latitude: 17.3850, longitude: 78.4867 }
  };
  res.json({ success: true, message: 'Hyderabad map data loaded', data: payload, ...payload });
});
app.get('/api/bins', requireAuth, requirePermission('bins.read'), (req, res) => res.json(agent.getWorkspaceBins(req.user.workspace || req.query.workspace || 'Hyderabad Operations')));
app.post('/api/bins', requireAuth, requirePermission('bins.create'), (req, res) => {
  const schema = z.object({ id: z.string().regex(/^(HYG|B)-\d{3,}$/), location: z.string().min(1), wasteType: z.string().min(1), capacity: z.number().positive(), latitude: z.number(), longitude: z.number() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid bin payload', details: parsed.error.flatten() });
  if (store.bins.some(bin => bin.id === parsed.data.id)) return res.status(400).json({ error: 'Bin ID already exists' });
  const bin = { ...parsed.data, name: parsed.data.location, area: parsed.data.location, city: 'Hyderabad', state: 'Telangana', fill: 0, fillRate: 0, temperature: 22, battery: 100, sensorStatus: 'ONLINE', priority: 'LOW', status: 'NORMAL', workspace: req.user.workspace || 'Hyderabad Operations', lastCollected: new Date().toISOString(), nextScheduledCollection: new Date(Date.now() + 86400000).toISOString() };
  store.bins.push(bin);
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Created bin', resource: 'bin', resourceId: bin.id, timestamp: new Date().toISOString(), metadata: bin });
  res.status(201).json(bin);
});
app.patch('/api/bins/:id', requireAuth, requirePermission('bins.update'), (req, res) => {
  const schema = z.object({ fill: z.number().min(0).max(100).optional(), status: z.string().optional(), location: z.string().min(1).optional(), wasteType: z.string().min(1).optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid bin update', details: parsed.error.flatten() });
  const bin = store.bins.find(item => item.id === req.params.id);
  if (!bin) return res.status(404).json({ error: 'Bin not found' });
  Object.assign(bin, parsed.data);
  bin.priority = agent.priorityFor(bin, agent.predictedOverflow(bin));
  bin.predictedOverflowTime = agent.predictedOverflow(bin).at;
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Updated bin', resource: 'bin', resourceId: bin.id, timestamp: new Date().toISOString(), metadata: parsed.data });
  res.json(bin);
});
app.delete('/api/bins/:id', requireAuth, requirePermission('bins.delete'), (req, res) => {
  const index = store.bins.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Bin not found' });
  const [bin] = store.bins.splice(index, 1);
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Deleted bin', resource: 'bin', resourceId: bin.id, timestamp: new Date().toISOString(), metadata: {} });
  res.json({ success: true, id: bin.id });
});
app.get('/api/vehicles', requireAuth, requirePermission('vehicles.read'), (_, res) => res.json(store.vehicles));
app.post('/api/vehicles', requireAuth, requirePermission('vehicles.create'), (req, res) => {
  const schema = z.object({ id: z.string().regex(/^V-\d{2,}$/), registration: z.string().min(1), capacity: z.number().positive(), driver: z.string().min(1) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid vehicle payload', details: parsed.error.flatten() });
  if (store.vehicles.some(vehicle => vehicle.id === parsed.data.id)) return res.status(400).json({ error: 'Vehicle ID already exists' });
  const vehicle = { ...parsed.data, currentLoad: 0, location: 'Depot A', status: 'AVAILABLE', fuelLevel: 100, lastService: new Date().toISOString() };
  store.vehicles.push(vehicle);
  res.status(201).json(vehicle);
});
app.patch('/api/vehicles/:id', requireAuth, requirePermission('vehicles.update'), (req, res) => {
  const schema = z.object({ registration: z.string().min(1).optional(), capacity: z.number().positive().optional(), driver: z.string().min(1).optional(), driverId: z.string().nullable().optional(), status: z.enum(['AVAILABLE', 'ASSIGNED', 'EN_ROUTE', 'COLLECTING', 'MAINTENANCE', 'OFFLINE']).optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid vehicle update', details: parsed.error.flatten() });
  const vehicle = store.vehicles.find(item => item.id === req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  const before = { status: vehicle.status, driver: vehicle.driver };
  Object.assign(vehicle, parsed.data);
  if (parsed.data.driverId !== undefined) {
    const driver = parsed.data.driverId && store.drivers.find(item => item.id === parsed.data.driverId);
    if (parsed.data.driverId && !driver) return res.status(404).json({ error: 'Driver not found' });
    vehicle.driver = driver?.name || '';
    store.drivers.forEach(item => { if (item.vehicleId === vehicle.id) item.vehicleId = null; });
    if (driver) driver.vehicleId = vehicle.id;
  }
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Vehicle status changed', resource: 'vehicle', resourceId: vehicle.id, timestamp: new Date().toISOString(), metadata: { before, after: { status: vehicle.status, driver: vehicle.driver } } });
  res.json(vehicle);
});
app.delete('/api/vehicles/:id', requireAuth, requirePermission('vehicles.delete'), (req, res) => {
  const index = store.vehicles.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Vehicle not found' });
  const [vehicle] = store.vehicles.splice(index, 1);
  res.json({ success: true, id: vehicle.id });
});
app.get('/api/routes', requireAuth, requirePermission('routes.read'), (req, res) => {
  const routes = req.user.role === ROLES.OPERATOR ? store.routes.filter(route => route.operatorId === req.user.sub) : store.routes;
  res.json(routes);
});
app.post('/api/routes', requireAuth, requirePermission('routes.create'), (req, res) => {
  const schema = z.object({ name: z.string().min(1), bins: z.array(z.string().min(1)).min(1), operatorId: z.string().nullable().optional(), vehicleId: z.string().nullable().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid route payload', details: parsed.error.flatten() });
  if (parsed.data.operatorId) {
    const operator = findUser(parsed.data.operatorId);
    if (!operator || operator.role !== ROLES.OPERATOR || operator.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
  }
  if (parsed.data.vehicleId && !store.vehicles.some(vehicle => vehicle.id === parsed.data.vehicleId)) return res.status(404).json({ error: 'Vehicle not found' });
  const route = { id: `R-${String(Date.now()).slice(-6)}`, ...parsed.data, status: 'PLANNED', distance: 0, createdAt: new Date().toISOString() };
  store.routes.unshift(route);
  res.status(201).json(route);
});
app.patch('/api/routes/:id', requireAuth, requirePermission('routes.update'), (req, res) => {
  const schema = z.object({ name: z.string().min(1).optional(), bins: z.array(z.string().min(1)).min(1).optional(), operatorId: z.string().nullable().optional(), vehicleId: z.string().nullable().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid route update', details: parsed.error.flatten() });
  const route = store.routes.find(item => item.id === req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (parsed.data.operatorId) {
    const operator = findUser(parsed.data.operatorId);
    if (!operator || operator.role !== ROLES.OPERATOR || operator.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
  }
  if (parsed.data.vehicleId && !store.vehicles.some(vehicle => vehicle.id === parsed.data.vehicleId)) return res.status(404).json({ error: 'Vehicle not found' });
  Object.assign(route, parsed.data);
  res.json(route);
});
app.delete('/api/routes/:id', requireAuth, requirePermission('routes.delete'), (req, res) => {
  const index = store.routes.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Route not found' });
  const [route] = store.routes.splice(index, 1);
  res.json({ success: true, id: route.id });
});
app.patch('/api/routes/:id/status', requireAuth, (req, res) => {
  const route = store.routes.find(item => item.id === req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  const status = String(req.body?.status || '').toUpperCase();
  if (!['PLANNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED'].includes(status)) return res.status(400).json({ error: 'Invalid route status' });
  if (req.user.role !== ROLES.ADMIN && (req.user.role !== ROLES.OPERATOR || route.operatorId !== req.user.sub)) return res.status(403).json({ error: 'Route is not assigned to you' });
  if (route.status === 'COMPLETED' || route.status === 'CANCELLED') return res.status(400).json({ error: 'Route is already closed' });
  route.status = status;
  res.json(route);
});
app.get('/api/locations', requireAuth, requirePermission('locations.read'), (_, res) => res.json(store.locations));
app.post('/api/locations', requireAuth, requirePermission('locations.create'), (req, res) => {
  const schema = z.object({ name: z.string().min(1), area: z.string().min(1), latitude: z.number(), longitude: z.number() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid location payload', details: parsed.error.flatten() });
  const location = { id: `LOC-${Date.now()}`, ...parsed.data, city: 'Hyderabad', state: 'Telangana', workspace: 'Hyderabad Operations' };
  store.locations.unshift(location);
  res.status(201).json(location);
});
app.patch('/api/locations/:id', requireAuth, requirePermission('locations.update'), (req, res) => {
  const schema = z.object({ name: z.string().min(1).optional(), area: z.string().min(1).optional(), latitude: z.number().optional(), longitude: z.number().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid location update', details: parsed.error.flatten() });
  const location = store.locations.find(item => item.id === req.params.id);
  if (!location) return res.status(404).json({ error: 'Location not found' });
  Object.assign(location, parsed.data);
  res.json(location);
});
app.delete('/api/locations/:id', requireAuth, requirePermission('locations.delete'), (req, res) => {
  const index = store.locations.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Location not found' });
  const [location] = store.locations.splice(index, 1);
  res.json({ success: true, id: location.id });
});
app.get('/api/tasks', requireAuth, requirePermission('tasks.read'), (req, res) => {
  const tasks = req.user.role === ROLES.OPERATOR ? store.tasks.filter(task => task.assigneeId === req.user.sub) : store.tasks;
  res.json(tasks);
});
app.get('/api/collections', requireAuth, requirePermission('tasks.read'), (req, res) => {
  const tasks = req.user.role === ROLES.OPERATOR ? store.tasks.filter(task => task.assigneeId === req.user.sub) : store.tasks;
  res.json(tasks);
});
app.post('/api/tasks', requireAuth, requirePermission('tasks.create'), (req, res) => {
  const schema = z.object({
    bins: z.array(z.string().min(1)).min(1),
    vehicleId: z.string().min(1),
    source: z.enum(['AI', 'MANUAL']).default('MANUAL'),
    priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
    reason: z.string().min(1).max(500).default('Manual collection task created')
  });

  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid collection task payload', details: parsed.error.flatten() });

  const { bins, vehicleId, source, priority, reason } = parsed.data;
  const vehicle = store.vehicles.find(item => item.id === vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  try {
    const assigneeId = req.body.assigneeId || null;
    if (req.user.role === ROLES.OPERATOR && assigneeId && assigneeId !== req.user.sub) return res.status(403).json({ error: 'Operators can only assign tasks to themselves' });
    if (assigneeId) {
      const assignee = findUser(assigneeId);
      if (!assignee || assignee.role !== ROLES.OPERATOR || assignee.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
    }
    const task = agent.createCollectionTask({ bins, vehicleId, source, priority, reason, assigneeId });
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Created collection task', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: { assigneeId, bins } });
    res.status(201).json({ success: true, data: task, message: 'Collection task created', ...task });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});
app.post('/api/collections', requireAuth, requirePermission('tasks.create'), (req, res) => {
  const schema = z.object({
    bins: z.array(z.string().min(1)).min(1),
    vehicleId: z.string().min(1),
    source: z.enum(['AI', 'MANUAL']).default('MANUAL'),
    priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
    reason: z.string().min(1).max(500).default('Manual collection task created')
  });

  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid collection task payload', details: parsed.error.flatten() });

  const { bins, vehicleId, source, priority, reason } = parsed.data;
  const vehicle = store.vehicles.find(item => item.id === vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  try {
    const assigneeId = req.body.assigneeId || null;
    if (req.user.role === ROLES.OPERATOR && assigneeId && assigneeId !== req.user.sub) return res.status(403).json({ error: 'Operators can only assign tasks to themselves' });
    if (assigneeId) {
      const assignee = findUser(assigneeId);
      if (!assignee || assignee.role !== ROLES.OPERATOR || assignee.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
    }
    const task = agent.createCollectionTask({ bins, vehicleId, source, priority, reason, assigneeId });
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Created collection task', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: { assigneeId, bins } });
    res.status(201).json(task);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});
app.get('/api/tasks/:id', requireAuth, requirePermission('tasks.read'), (req, res) => {
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  if (req.user.role === ROLES.OPERATOR && task.assigneeId !== req.user.sub) return res.status(403).json({ error: 'Task is not assigned to you' });
  res.json({ success: true, data: task, message: 'Task loaded', ...task });
});
app.get('/api/collections/:id', requireAuth, requirePermission('tasks.read'), (req, res) => {
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  if (req.user.role === ROLES.OPERATOR && task.assigneeId !== req.user.sub) return res.status(403).json({ error: 'Task is not assigned to you' });
  res.json(task);
});
app.patch('/api/collections/:id/details', requireAuth, requirePermission('tasks.update'), (req, res) => {
  const schema = z.object({ priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(), reason: z.string().min(1).max(500).optional(), dueAt: z.string().datetime().optional(), vehicleId: z.string().optional(), assigneeId: z.string().nullable().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid task update', details: parsed.error.flatten() });
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  if (parsed.data.assigneeId) {
    const assignee = findUser(parsed.data.assigneeId);
    if (!assignee || assignee.role !== ROLES.OPERATOR || assignee.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
  }
  const { vehicleId, ...safeFields } = parsed.data;
  try {
    if (vehicleId) agent.reassignTaskResources(task.id, { vehicleId });
    Object.assign(task, safeFields);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Updated collection task', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: parsed.data });
  store.persistOperationalState();
  res.json(task);
});
app.patch('/api/collections/:id/assign', requireAuth, requirePermission('tasks.assign'), (req, res) => {
  const assignment = z.object({ vehicleId: z.string().min(1).optional(), driverId: z.string().min(1).optional(), assigneeId: z.string().min(1).optional() }).safeParse(req.body || {});
  if (!assignment.success) return res.status(400).json({ error: 'Invalid assignment payload' });
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  if (assignment.data.driverId || assignment.data.vehicleId) {
    try { agent.reassignTaskResources(task.id, { driverId: assignment.data.driverId, vehicleId: assignment.data.vehicleId }); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  }
  if (assignment.data.assigneeId) {
    const assignee = findUser(assignment.data.assigneeId);
    if (!assignee || assignee.role !== ROLES.OPERATOR || assignee.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
    task.assigneeId = assignee.id;
  }
  if (!assignment.data.vehicleId && !assignment.data.driverId && !assignment.data.assigneeId) return res.status(400).json({ error: 'Provide a fleet vehicleId, driverId, or application assigneeId.' });
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Assigned collection task resources', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: { assigneeId: task.assigneeId || null, vehicleId: task.vehicle || null, driverId: task.driverId || null } });
  store.persistOperationalState();
  res.json(task);
});
app.get('/api/incidents', requireAuth, (_, res) => res.json(store.incidents));
app.post('/api/incidents', requireAuth, requirePermission('alerts.report'), (req, res) => {
  const schema = z.object({
    location: z.string().min(1),
    wasteType: z.string().min(1),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    description: z.string().min(1),
    reporter: z.string().optional()
  });

  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid incident report', details: parsed.error.flatten() });

  const incident = agent.reportIncident(parsed.data);
  res.status(201).json(incident);
});
app.get('/api/notifications', requireAuth, (_, res) => res.json(store.notifications));
app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
  const notification = store.notifications.find(item => item.id === req.params.id);
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  notification.read = true;
  res.json(notification);
});
app.patch('/api/notifications/read-all', requireAuth, (req, res) => {
  store.notifications.forEach(item => { item.read = true; });
  res.json({ success: true, count: store.notifications.length });
});
app.get('/api/audit-logs', requireAuth, requirePermission('audit.read'), (_, res) => res.json(store.auditLogs));
app.get('/api/drivers', requireAuth, requirePermission('drivers.read'), (_, res) => res.json(store.drivers.map(driver => ({ ...driver, currentTask: store.tasks.find(task => task.driver === driver.name && !['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(task.status)) || null, taskHistory: store.tasks.filter(task => task.driver === driver.name) }))));
app.patch('/api/drivers/:id', requireAuth, requirePermission('drivers.update'), (req, res) => {
  const schema = z.object({ name: z.string().min(1).optional(), phone: z.string().min(1).optional(), licenseNumber: z.string().min(1).optional(), status: z.enum(['ONLINE', 'OFFLINE', 'ON_ROUTE', 'ON_BREAK', 'BUSY']).optional(), vehicleId: z.string().nullable().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid driver update', details: parsed.error.flatten() });
  const driver = store.drivers.find(item => item.id === req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  if (parsed.data.vehicleId && !store.vehicles.some(item => item.id === parsed.data.vehicleId)) return res.status(404).json({ error: 'Vehicle not found' });
  Object.assign(driver, parsed.data);
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Updated driver', resource: 'driver', resourceId: driver.id, timestamp: new Date().toISOString(), metadata: parsed.data });
  res.json(driver);
});
app.get('/api/agents', requireAuth, requirePermission('agents.read'), (_, res) => res.json(store.agents));
app.post('/api/agents/route-optimize', requireAuth, requireRole('ADMIN'), async (_, res) => {
  const run = await agent.runOptimization('manual', _.user);
  res.status(201).json({ success: true, message: 'Route optimization completed', data: run, ...run });
});
app.post('/api/agents/overflow-predict', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
  const binId = String(req.body?.binId || '').trim();
  const bins = agent.getBinStatus();
  const predictions = binId ? bins.filter(bin => bin.id === binId) : bins.filter(bin => ['CRITICAL', 'HIGH', 'MEDIUM'].includes(bin.priority));
  res.json({ success: true, message: 'Overflow predictions loaded', data: predictions, predictions });
});
app.post('/api/agents/dispatch', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
  const payload = req.body || {};
  const selectedBins = Array.isArray(payload.bins) && payload.bins.length ? payload.bins : ['HYG-001'];
  const vehicleId = payload.vehicleId || agent.getAvailableVehiclesForBins(selectedBins.map(id => ({ id }))).find(Boolean)?.id || store.vehicles[0]?.id;
  const task = agent.createCollectionTask({ bins: selectedBins, vehicleId, source: payload.source || 'AI', priority: payload.priority || 'HIGH', reason: payload.reason || 'Dispatch recommendation' });
  res.status(201).json({ success: true, message: 'Dispatch generated', data: task, ...task });
});
app.get('/api/agents/activity', requireAuth, requirePermission('agents.read'), (_, res) => res.json(store.auditLogs.filter(log => ['task', 'vehicle', 'alert', 'agent'].includes(log.resource)).slice(0, 20)));
app.get('/api/agents/memory', requireAuth, requirePermission('agents.read'), (_, res) => res.json({
  runs: store.agentRuns.slice(0, 20),
  decisions: store.agentDecisions.slice(0, 50),
  timeline: store.agentTimeline.slice(0, 50),
  audit: store.auditLogs.filter(log => log.resource === 'agent').slice(0, 50)
}));
app.get('/api/settings', requireAuth, requirePermission('settings.read'), (_, res) => res.json(store.settings));
app.patch('/api/settings', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const schema = z.object({ organizationName: z.string().min(1).optional(), overflowThreshold: z.number().min(1).max(100).optional(), vehicleLoadWarning: z.number().min(1).max(100).optional(), criticalAlerts: z.boolean().optional(), vehicleAlerts: z.boolean().optional(), taskAlerts: z.boolean().optional(), agentAlerts: z.boolean().optional(), mapZoom: z.number().min(1).max(20).optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid settings update', details: parsed.error.flatten() });
  Object.assign(store.settings, parsed.data);
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Settings changed', resource: 'settings', resourceId: 'SYSTEM', timestamp: new Date().toISOString(), metadata: parsed.data });
  res.json(store.settings);
});
app.post('/api/settings/reset', requireAuth, requirePermission('settings.manage'), (_, res) => {
  Object.assign(store.settings, store.defaultSettings, { mapCenter: [...store.defaultSettings.mapCenter] });
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: _.user.email, role: _.user.role, action: 'Settings reset', resource: 'settings', resourceId: 'SYSTEM', timestamp: new Date().toISOString(), metadata: {} });
  res.json(store.settings);
});
app.get('/api/analytics', requireAuth, requirePermission('analytics.read'), (req, res) => {
  const payload = getDashboardState(req.user.workspace || 'Hyderabad Operations', req.user);
  res.json({ success: true, message: 'Analytics loaded', data: payload, ...payload });
});
app.get('/api/reports', requireAuth, requirePermission('reports.read'), (req, res) => res.json({ generatedAt: new Date().toISOString(), metrics: getDashboardState(req.user.workspace || 'Hyderabad Operations', req.user).metrics, tasks: req.user.role === ROLES.OPERATOR ? store.tasks.filter(task => task.assigneeId === req.user.sub) : store.tasks }));
app.get('/api/ai/status', requireAuth, (_, res) => res.json({
  online: true,
  mode: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY ? 'LLM' : 'LOCAL_RULE_ENGINE',
  lastRun: store.aiRuns[0] || null,
  state: agent.getAgentRuntime().state,
  updatedAt: agent.getAgentRuntime().updatedAt,
  lastError: agent.getAgentRuntime().lastError,
  nextRun: automation.nextRunAt,
  scheduler: automation.enabled,
  automation: { enabled: automation.enabled, intervalMs: automation.intervalMs, lastRunAt: automation.lastRunAt, lastError: automation.lastError }
}));
app.get('/api/ai/runs', requireAuth, requirePermission('analytics.read'), (_, res) => res.json(store.aiRuns));
app.post('/api/ai/run', requireAuth, requireRole('ADMIN'), async (_, res) => {
  const run = await agent.runOptimization('manual', _.user);
  res.status(201).json(run);
});
app.post('/api/agent/query', requireAuth, async (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Ask a question or give the operations agent a command.' });

  try {
    const result = await agent.runAgentLoop({ trigger: 'chat', prompt: query, user: req.user });
    return res.json({
      answer: result.answer || 'The AI agent processed the latest Hyderabad operational state.',
      run: result,
      refresh: true,
      engine: result.mode === 'LLM' ? 'OpenAI' : 'Local AI Decision Engine'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Agent query failed.' });
  }
});
app.patch('/api/collections/:id', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  if (req.user.role === ROLES.OPERATOR && task.assigneeId !== req.user.sub) return res.status(403).json({ error: 'Task is not assigned to you' });

  const requestedStatus = String(req.body?.status || '').toUpperCase();
  if (!requestedStatus) return res.status(400).json({ error: 'Missing task status' });

  if (req.user.role === ROLES.OPERATOR && !['DISPATCHED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'COLLECTING', 'COMPLETED', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS'].includes(requestedStatus)) return res.status(403).json({ error: 'Operators cannot perform this task action' });

  if (requestedStatus === 'COMPLETED') {
    const updated = agent.completeTask(task.id, {
      collectedQuantity: Number(req.body?.collectedQuantity ?? 0),
      notes: req.body?.notes || '',
      contaminationLevel: req.body?.contaminationLevel || 'MEDIUM'
    });
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Completed collection task', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: { collectedQuantity: updated.collectedQuantity } });
    return res.json(updated);
  }

  try {
    agent.transitionTask(task, requestedStatus);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  res.json(task);
});
app.get('/api/alerts', requireAuth, requirePermission('alerts.read'), (_, res) => res.json(store.incidents));
app.patch('/api/alerts/:id/status', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
  const requestedStatus = String(req.body?.status || '').toUpperCase();
  const isAdmin = req.user.role === ROLES.ADMIN;
  if (requestedStatus === 'RESOLVED' && !isAdmin) return res.status(403).json({ error: 'Only administrators can resolve alerts' });
  if (!isAdmin && !['ACKNOWLEDGED', 'IN_PROGRESS'].includes(requestedStatus)) return res.status(403).json({ error: 'Operators can only acknowledge or progress alerts' });
  if (!isAdmin && !store.incidents.find(item => item.id === req.params.id)) return res.status(404).json({ error: 'Alert not found' });
  try {
    const incident = agent.updateIncident(req.params.id, requestedStatus);
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: `Changed alert status to ${requestedStatus}`, resource: 'alert', resourceId: incident.id, timestamp: new Date().toISOString(), metadata: {} });
    res.json(incident);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.use((err, _, res, __) => res.status(500).json({ success: false, error: 'Unexpected server error', message: err.message }));

const server = app.listen(port, () => console.log(`EcoFlow API listening on http://localhost:${port}`));
const runScheduledOptimization = async () => {
  if (!automation.enabled) return;
  try {
    const monitoring = agent.monitorActiveTasks('scheduled');
    const run = await agent.runOptimization('scheduled', { role: 'ADMIN', workspace: 'Hyderabad Operations' });
    automation.lastResult = { monitoring, runId: run.id, replanned: run.replanned || monitoring.replanned };
    automation.lastRunAt = new Date().toISOString();
    automation.lastError = null;
  } catch (error) {
    automation.lastError = error.message;
    console.error('EcoFlow scheduled optimization failed:', error.message);
  } finally {
    automation.nextRunAt = new Date(Date.now() + automation.intervalMs).toISOString();
  }
};
if (automation.enabled) {
  runScheduledOptimization();
  setInterval(runScheduledOptimization, automation.intervalMs);
}
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`EcoFlow API is already running on port ${port}; refusing to start a duplicate server.`);
    server.close();
    process.exitCode = 0;
    return;
  }

  console.error('EcoFlow API failed to start:', error);
  process.exitCode = 1;
});
