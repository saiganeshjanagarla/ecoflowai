require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const store = require('./store');
const agent = require('./agent');
const { authenticateUser, getProfile, updateProfile, issueToken, requireAuth, requireRole, requirePermission, listUsers, createUser, updateUser, deleteUser, findUser, ROLES } = require('./auth');

const app = express();
const port = process.env.PORT || 4000;
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
  const activeTasks = visibleTasks.filter(task => !['COMPLETED', 'CANCELLED'].includes(task.status)).length;
  const totalWasteGenerated = bins.reduce((sum, bin) => sum + Math.max(0, bin.fill * (bin.capacity / 100)), 0);
  const totalWasteCollected = visibleTasks.filter(task => task.status === 'COMPLETED').reduce((sum, task) => sum + (task.collectedQuantity || 0), 0);
  const diversion = totalWasteCollected > 0 ? Math.min(95, Math.round((totalWasteCollected / Math.max(totalWasteGenerated, 1)) * 100)) : 62;
  const routeDistance = Number(visibleTasks.reduce((sum, task) => sum + (task.distance || 0), 0).toFixed(1));
  const routeEfficiency = Math.max(70, Math.min(97, Math.round(100 - (routeDistance / Math.max(totalWasteGenerated / 16, 1)))));
  const recyclingRate = Math.max(35, Math.min(95, Math.round((bins.filter(bin => ['Organic', 'Paper', 'Glass'].includes(bin.wasteType)).reduce((sum, bin) => sum + bin.fill, 0) / Math.max(bins.length, 1)))));
  return {
    metrics: {
      totalBins: bins.length,
      criticalBins: critical,
      overflowRisk: critical + high,
      todaysWaste: Math.round(totalWasteGenerated * 0.62),
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
      completedCollections: visibleTasks.filter(task => task.status === 'COMPLETED').length,
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
app.get('/api/collections', requireAuth, requirePermission('tasks.read'), (req, res) => {
  const tasks = req.user.role === ROLES.OPERATOR ? store.tasks.filter(task => task.assigneeId === req.user.sub) : store.tasks;
  res.json(tasks);
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
  if (parsed.data.vehicleId && !store.vehicles.some(item => item.id === parsed.data.vehicleId)) return res.status(404).json({ error: 'Vehicle not found' });
  if (parsed.data.assigneeId) {
    const assignee = findUser(parsed.data.assigneeId);
    if (!assignee || assignee.role !== ROLES.OPERATOR || assignee.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
  }
  Object.assign(task, parsed.data);
  if (parsed.data.vehicleId) task.vehicle = parsed.data.vehicleId;
  if (parsed.data.assigneeId) { task.driver = findUser(parsed.data.assigneeId).name; if (task.status === 'PENDING') task.status = 'ASSIGNED'; }
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Updated collection task', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: parsed.data });
  res.json(task);
});
app.patch('/api/collections/:id/assign', requireAuth, requirePermission('tasks.assign'), (req, res) => {
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  const assignee = findUser(req.body?.assigneeId);
  if (!assignee || assignee.role !== ROLES.OPERATOR || assignee.status !== 'ACTIVE') return res.status(400).json({ error: 'An active operator is required' });
  task.assigneeId = assignee.id;
  task.driver = assignee.name;
  if (task.status === 'PENDING') task.status = 'ASSIGNED';
  store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Assigned collection task', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: { assigneeId: assignee.id } });
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
app.get('/api/drivers', requireAuth, requirePermission('drivers.read'), (_, res) => res.json(store.drivers.map(driver => ({ ...driver, currentTask: store.tasks.find(task => task.driver === driver.name && !['COMPLETED', 'CANCELLED'].includes(task.status)) || null, taskHistory: store.tasks.filter(task => task.driver === driver.name) }))));
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
app.get('/api/agents/activity', requireAuth, requirePermission('agents.read'), (_, res) => res.json(store.auditLogs.filter(log => ['task', 'vehicle', 'alert', 'agent'].includes(log.resource)).slice(0, 20)));
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
app.get('/api/analytics', requireAuth, requirePermission('analytics.read'), (req, res) => res.json(getDashboardState(req.user.workspace || 'Hyderabad Operations', req.user)));
app.get('/api/reports', requireAuth, requirePermission('reports.read'), (req, res) => res.json({ generatedAt: new Date().toISOString(), metrics: getDashboardState(req.user.workspace || 'Hyderabad Operations', req.user).metrics, tasks: req.user.role === ROLES.OPERATOR ? store.tasks.filter(task => task.assigneeId === req.user.sub) : store.tasks }));
app.get('/api/ai/status', requireAuth, (_, res) => res.json({ online: true, mode: process.env.LLM_API_KEY ? 'LLM' : 'LOCAL_RULE_ENGINE', lastRun: store.aiRuns[0] || null, nextRun: null, scheduler: false }));
app.get('/api/ai/runs', requireAuth, requirePermission('analytics.read'), (_, res) => res.json(store.aiRuns));
app.post('/api/ai/run', requireAuth, requireRole('ADMIN'), (_, res) => res.status(201).json(agent.runOptimization('manual')));
app.post('/api/agent/query', requireAuth, (req, res) => {
  const query = String(req.body?.query || '').toLowerCase();
  const bins = agent.getBinStatus();
  const criticalBins = bins.filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority));
  const binMatch = query.match(/b-\d{3}/i);
  const normalizedBinMatch = query.match(/(?:hyg|b)-\d{3}/i);

  if (!query.trim()) return res.status(400).json({ error: 'Ask a question or give the operations agent a command.' });

  if (query.includes('create') && (query.includes('task') || query.includes('collection'))) {
    if (req.user.role === ROLES.VIEWER) return res.status(403).json({ error: 'Viewers cannot create collection tasks.' });
    const requestedBin = normalizedBinMatch?.[0]?.toUpperCase() || criticalBins[0]?.id;
    const selectedBin = bins.find(bin => bin.id.toLowerCase() === requestedBin?.toLowerCase());
    if (!selectedBin) return res.status(404).json({ error: 'Mention a valid Hyderabad bin such as HYG-001.' });
    const vehicleMatch = query.match(/v-\d{2}/i);
    const vehicle = vehicleMatch ? store.vehicles.find(item => item.id.toLowerCase() === vehicleMatch[0].toLowerCase()) : agent.getAvailableVehiclesForBins([selectedBin])[0];
    if (!vehicle) return res.status(409).json({ error: 'No available vehicle can handle this collection.' });
    if (vehicle.status === 'MAINTENANCE' || vehicle.status === 'OFFLINE') return res.status(409).json({ error: `${vehicle.id} is not available for dispatch.` });
    const operatorMatch = query.match(/(?:assign(?:ed)? to|operator)\s+([a-z ]+?)(?=\s+(?:for|on|with|using|vehicle|v-\d{2})|$)/i);
    const operator = operatorMatch && [...require('./auth').users].find(user => user.role === ROLES.OPERATOR && user.name.toLowerCase() === operatorMatch[1].trim().toLowerCase());
    const assigneeId = operator?.id || (req.user.role === ROLES.OPERATOR ? req.user.sub : null);
    if (operatorMatch && !operator) return res.status(404).json({ error: `No active operator named ${operatorMatch[1].trim()} was found.` });
    const priority = query.includes('critical') ? 'CRITICAL' : query.includes('medium') ? 'MEDIUM' : query.includes('low') ? 'LOW' : selectedBin.priority === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
    try {
      const task = agent.createCollectionTask({ bins: [selectedBin.id], vehicleId: vehicle.id, source: 'MANUAL', priority, reason: `Created by ${req.user.name} through the operations assistant.`, assigneeId });
      if (assigneeId) { task.status = 'ASSIGNED'; task.driver = require('./auth').findUser(assigneeId).name; }
      store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: 'Created collection task via assistant', resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: { binId: selectedBin.id, vehicleId: vehicle.id, assigneeId } });
      return res.status(201).json({ answer: `Created ${task.id} for ${selectedBin.id} in ${selectedBin.location}. ${vehicle.id} is assigned${task.driver ? ` to ${task.driver}` : ''}.`, task, refresh: true, engine: 'Local Operations Assistant' });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  }

  const taskMatch = query.match(/(?:task|collection)\s+(ct-\d{3,6})/i);
  if ((query.includes('complete') || query.includes('finish') || query.includes('start') || query.includes('accept') || query.includes('advance')) && taskMatch) {
    const task = store.tasks.find(item => item.id.toLowerCase() === taskMatch[1].toLowerCase());
    if (!task) return res.status(404).json({ error: `${taskMatch[1].toUpperCase()} was not found.` });
    if (req.user.role === ROLES.VIEWER) return res.status(403).json({ error: 'Viewers cannot change task status.' });
    if (req.user.role === ROLES.OPERATOR && task.assigneeId !== req.user.sub) return res.status(403).json({ error: 'That task is not assigned to you.' });
    const nextStatus = query.includes('complete') || query.includes('finish') ? 'COMPLETED' : task.status === 'PENDING' ? 'ASSIGNED' : task.status === 'ASSIGNED' ? 'EN_ROUTE' : task.status === 'EN_ROUTE' ? 'COLLECTING' : 'COMPLETED';
    if (nextStatus === 'COMPLETED') agent.completeTask(task.id, { collectedQuantity: Number(task.bins.length * 120), notes: 'Completed through operations assistant', contaminationLevel: 'MEDIUM' });
    else agent.transitionTask(task, nextStatus);
    store.auditLogs.unshift({ id: `AL-${Date.now()}`, user: req.user.email, role: req.user.role, action: `Changed task status to ${nextStatus} via assistant`, resource: 'task', resourceId: task.id, timestamp: new Date().toISOString(), metadata: {} });
    return res.json({ answer: `${task.id} is now ${task.status}.`, task, refresh: true, engine: 'Local Operations Assistant' });
  }

  if (query.includes('report incident') || query.includes('incident')) {
    if (req.user.role === ROLES.VIEWER) return res.status(403).json({ error: 'Viewers cannot report operational incidents.' });
    const severity = query.includes('critical') ? 'CRITICAL' : query.includes('high') ? 'HIGH' : query.includes('low') ? 'LOW' : 'MEDIUM';
    const wasteType = /organic|plastic|paper|glass|metal|mixed|food/i.exec(query)?.[0] || 'Mixed';
    const location = /hitec city|madhapur|gachibowli|kondapur|kukatpally|jubilee hills|banjara hills|ameerpet|begumpet|secunderabad|mehdipatnam|lb nagar|uppal|dilsukhnagar|charminar|financial district/i.exec(query)?.[0] || 'Hyderabad Operations';
    const incident = agent.reportIncident({
      location: location.charAt(0).toUpperCase() + location.slice(1),
      wasteType: wasteType.charAt(0).toUpperCase() + wasteType.slice(1),
      severity,
      description: `AI-generated incident report for ${wasteType} waste observed near ${location}.`,
      reporter: req.user?.email || 'system@ecoflow.local'
    });
    return res.json({ answer: `Incident ${incident.id} has been logged and assigned for review.`, incident, engine: 'Local AI Decision Engine' });
  }

  if (query.includes('optimize') || query.includes('run today')) {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Only administrators can execute AI optimization.' });
    return res.json({ answer: 'I started a verified optimization run using the live bin and vehicle state.', run: agent.runOptimization('chat') });
  }

  if (binMatch && (query.includes('why') || query.includes('critical') || query.includes('explain'))) {
    const bin = bins.find(item => item.id.toLowerCase() === binMatch[0].toLowerCase());
    if (!bin) return res.status(404).json({ error: `Bin ${binMatch[0].toUpperCase()} was not found.` });
    return res.json({
      answer: `${bin.id} is ${bin.priority.toLowerCase()} because it is ${bin.fill}% full and filling at ${bin.fillRate}% per hour. The local forecast estimates overflow in ${bin.forecast.hours} hours.`,
      bin,
      engine: 'Local AI Decision Engine'
    });
  }

  if (query.includes('which bins need collection') || query.includes('critical') || query.includes('need collection')) {
    return res.json({
      answer: `${criticalBins.length} bins need attention: ${criticalBins.map(bin => `${bin.id} (${bin.fill}%)`).join(', ') || 'none right now.'}`,
      bins: criticalBins,
      engine: 'Local AI Decision Engine'
    });
  }

  if (query.includes('most urgent') || query.includes('urgent')) {
    const urgent = [...bins].sort((a, b) => b.fill - a.fill)[0];
    return res.json({ answer: `${urgent.id} is the most urgent bin at ${urgent.fill}% fill with a ${urgent.priority} priority.`, bin: urgent, engine: 'Local AI Decision Engine' });
  }

  if (query.includes('vehicle') && normalizedBinMatch) {
    const bin = bins.find(item => item.id.toLowerCase() === normalizedBinMatch[0].toLowerCase());
    if (!bin) return res.status(404).json({ error: `Bin ${normalizedBinMatch[0].toUpperCase()} was not found.` });
    const vehicles = agent.getAvailableVehiclesForBins([bin]).filter(vehicle => vehicle.availableCapacity >= Math.max(0, bin.fill * 2));
    return res.json({ answer: vehicles.length ? `${vehicles[0].id} is the best-fit vehicle with ${vehicles[0].availableCapacity} kg remaining capacity.` : 'No available vehicle has enough capacity for that bin.', vehicles, engine: 'Local AI Decision Engine' });
  }

  if (query.includes('waste') || query.includes('collected today')) {
    const collected = store.tasks.filter(task => task.status === 'COMPLETED').reduce((sum, task) => sum + (task.collectedQuantity || 0), 0);
    return res.json({ answer: `A total of ${collected} kg of waste has been collected today.`, collected, engine: 'Local AI Decision Engine' });
  }

  if (query.includes('available')) {
    return res.json({ answer: `${store.vehicles.filter(vehicle => vehicle.status === 'AVAILABLE').length} vehicles are currently available.`, vehicles: store.vehicles.filter(vehicle => vehicle.status === 'AVAILABLE'), engine: 'Local AI Decision Engine' });
  }

  return res.json({ answer: 'I can answer live questions about urgent bins, vehicle readiness, route optimization, and current waste collection totals using the Local AI Decision Engine.', engine: 'Local AI Decision Engine' });
});
app.patch('/api/collections/:id', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
  const task = store.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Collection task not found' });
  if (req.user.role === ROLES.OPERATOR && task.assigneeId !== req.user.sub) return res.status(403).json({ error: 'Task is not assigned to you' });

  const requestedStatus = String(req.body?.status || '').toUpperCase();
  if (!requestedStatus) return res.status(400).json({ error: 'Missing task status' });

  if (req.user.role === ROLES.OPERATOR && !['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'].includes(requestedStatus)) return res.status(403).json({ error: 'Operators cannot perform this task action' });

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
app.use((err, _, res, __) => res.status(500).json({ error: 'Unexpected server error', message: err.message }));

const server = app.listen(port, () => console.log(`EcoFlow API listening on http://localhost:${port}`));
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