const crypto = require('crypto');

const hashPassword = password => crypto.createHash('sha256').update(String(password)).digest('hex');

const ROLES = Object.freeze({ ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', VIEWER: 'VIEWER' });
const PERMISSIONS = Object.freeze({
  ADMIN: new Set(['users.read', 'users.create', 'users.update', 'users.delete', 'bins.read', 'bins.create', 'bins.update', 'bins.delete', 'tasks.read', 'tasks.create', 'tasks.assign', 'tasks.update', 'tasks.delete', 'routes.read', 'routes.create', 'routes.update', 'routes.delete', 'routes.assign', 'locations.read', 'locations.create', 'locations.update', 'locations.delete', 'vehicles.read', 'vehicles.create', 'vehicles.update', 'vehicles.delete', 'drivers.read', 'drivers.create', 'drivers.update', 'drivers.delete', 'alerts.read', 'alerts.report', 'alerts.resolve', 'analytics.read', 'reports.read', 'reports.export', 'audit.read', 'agents.read', 'settings.read', 'settings.manage']),
  OPERATOR: new Set(['bins.read', 'tasks.read', 'tasks.create', 'tasks.updateOwn', 'routes.read', 'routes.updateOwn', 'locations.read', 'vehicles.read', 'drivers.read', 'alerts.read', 'alerts.report', 'alerts.resolveOwn', 'analytics.read', 'reports.read', 'agents.read', 'settings.read', 'performance.readOwn']),
  VIEWER: new Set(['bins.read', 'tasks.read', 'routes.read', 'locations.read', 'vehicles.read', 'drivers.read', 'alerts.read', 'analytics.read', 'reports.read', 'agents.read', 'settings.read'])
});

const users = [
  { id: 'U-001', email: 'saiganesh@gmail.com', password: hashPassword('ultron2026'), name: 'Sai Ganesh', phone: '+91 90000 00001', role: ROLES.ADMIN, status: 'ACTIVE', lastLogin: null, workspace: 'Hyderabad Operations', notifications: true, autoRefresh: true },
  { id: 'U-002', email: 'bhanu@gmail.com', password: hashPassword('ultron2026'), name: 'Raj', phone: '+91 90000 00002', role: ROLES.OPERATOR, status: 'ACTIVE', lastLogin: null, workspace: 'Hyderabad Operations', notifications: true, autoRefresh: true },
  { id: 'U-003', email: 'user@gmail.com', password: hashPassword('123456'), name: 'EcoFlow Viewer', phone: '+91 90000 00003', role: ROLES.VIEWER, status: 'ACTIVE', lastLogin: null, workspace: 'Hyderabad Operations', notifications: true, autoRefresh: true }
];

const profileStore = new Map();

function getProfile(user) {
  const base = users.find(item => item.id === user.id) || user;
  const stored = profileStore.get(user.id) || {};
  return {
    id: base.id,
    email: base.email,
    name: base.name,
    phone: base.phone || '',
    role: base.role,
    status: base.status || 'ACTIVE',
    lastLogin: base.lastLogin || null,
    workspace: stored.workspace || base.workspace || 'Hyderabad Operations',
    notifications: stored.notifications ?? (base.notifications ?? true),
    autoRefresh: stored.autoRefresh ?? (base.autoRefresh ?? true)
  };
}

function updateProfile(user, updates = {}) {
  const current = getProfile(user);
  const next = {
    ...current,
    ...updates,
    notifications: updates.notifications ?? current.notifications,
    autoRefresh: updates.autoRefresh ?? current.autoRefresh
  };
  profileStore.set(user.id, {
    workspace: next.workspace,
    notifications: next.notifications,
    autoRefresh: next.autoRefresh
  });
  const profileUser = users.find(item => item.id === user.id);
  if (profileUser) {
    profileUser.workspace = next.workspace;
    profileUser.notifications = next.notifications;
    profileUser.autoRefresh = next.autoRefresh;
  }
  return next;
}

function publicUser(user) {
  const profile = getProfile(user);
  return { ...profile };
}

function listUsers() {
  return users.map(publicUser);
}

function findUser(id) {
  return users.find(user => user.id === id) || null;
}

function createUser({ name, email, phone = '', role, password }) {
  if (!Object.values(ROLES).includes(role)) throw new Error('Invalid role');
  if (users.some(user => user.email.toLowerCase() === email.toLowerCase())) throw new Error('Email is already in use');
  const user = { id: `U-${String(Date.now()).slice(-6)}`, name, email, phone, password: hashPassword(password), role, status: 'ACTIVE', lastLogin: null, workspace: 'Hyderabad Operations', notifications: true, autoRefresh: true };
  users.push(user);
  return publicUser(user);
}

function updateUser(id, updates = {}) {
  const user = findUser(id);
  if (!user) return null;
  const previous = { role: user.role, status: user.status, name: user.name, email: user.email };
  if (updates.role && !Object.values(ROLES).includes(updates.role)) throw new Error('Invalid role');
  if (updates.email && users.some(item => item.id !== id && item.email.toLowerCase() === updates.email.toLowerCase())) throw new Error('Email is already in use');
  const { password, ...safeUpdates } = updates;
  Object.assign(user, safeUpdates);
  if (password) user.password = hashPassword(password);
  return publicUser(user);
}

function deleteUser(id) {
  const index = users.findIndex(user => user.id === id);
  if (index < 0) return false;
  users.splice(index, 1);
  profileStore.delete(id);
  return true;
}

const insecureDefaultSecret = 'replace-me-with-a-strong-secret';
const secret = process.env.JWT_SECRET || insecureDefaultSecret;
if (process.env.NODE_ENV === 'production' && secret === insecureDefaultSecret) {
  throw new Error('JWT_SECRET must be configured with a strong production secret.');
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');

function issueToken(user) {
  const payload = encode({ sub: user.id, email: user.email, role: user.role, name: user.name, workspace: user.workspace, exp: Date.now() + 8 * 60 * 60 * 1000 });
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || sign(payload) !== signature) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch (_) { return null; }
}

function authenticateUser(email, password) {
  const hashed = hashPassword(password);
  const user = users.find(item => item.email === email && item.password === hashed && item.status === 'ACTIVE') || null;
  if (user) user.lastLogin = new Date().toISOString();
  return user;
}

function requireAuth(req, res, next) {
  const user = verifyToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = { ...user, ...getProfile({ id: user.sub, email: user.email, role: user.role, name: user.name }) };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Insufficient permissions' });
}

function requirePermission(permission) {
  return (req, res, next) => PERMISSIONS[req.user?.role]?.has(permission) ? next() : res.status(403).json({ error: `Permission required: ${permission}` });
}

module.exports = { ROLES, PERMISSIONS, users, authenticateUser, getProfile, updateProfile, publicUser, listUsers, findUser, createUser, updateUser, deleteUser, issueToken, verifyToken, requireAuth, requireRole, requirePermission };