const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfile, updateProfile, PERMISSIONS, ROLES, issueToken, verifyToken } = require('./auth');

test('profile updates persist user workspace and notification preferences', () => {
  const user = { id: 'U-001', email: 'saiganesh@gmail.com' };

  const updated = updateProfile(user, {
    workspace: 'Hyderabad Operations',
    notifications: false,
    autoRefresh: false
  });

  assert.equal(updated.workspace, 'Hyderabad Operations');
  assert.equal(updated.notifications, false);
  assert.equal(updated.autoRefresh, false);

  const stored = getProfile(user);
  assert.equal(stored.workspace, 'Hyderabad Operations');
  assert.equal(stored.notifications, false);
  assert.equal(stored.autoRefresh, false);
});

test('permission registry separates admin, operator, and viewer capabilities', () => {
  assert.equal(PERMISSIONS[ROLES.ADMIN].has('users.create'), true);
  assert.equal(PERMISSIONS[ROLES.OPERATOR].has('users.create'), false);
  assert.equal(PERMISSIONS[ROLES.OPERATOR].has('tasks.updateOwn'), true);
  assert.equal(PERMISSIONS[ROLES.VIEWER].has('tasks.updateOwn'), false);
  assert.equal(PERMISSIONS[ROLES.VIEWER].has('analytics.read'), true);
});

test('issued session token carries the authenticated role', () => {
  const token = issueToken({ id: 'U-003', email: 'user@gmail.com', role: ROLES.VIEWER, name: 'EcoFlow Viewer', workspace: 'Hyderabad Operations' });
  assert.equal(verifyToken(token).role, ROLES.VIEWER);
});
