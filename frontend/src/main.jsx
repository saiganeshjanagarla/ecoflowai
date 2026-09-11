import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import { Activity, AlertTriangle, Bell, Bot, Check, CheckCircle2, ChevronRight, CircleDot, Clock3, Fuel, Gauge, ImageOff, Layers3, Leaf, LogOut, Map, Menu, MessageCircle, PackageCheck, Radio, Route, Send, Settings2, Truck, UserRound, X } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './styles.css';
import './monitoring.css';
import './interactions.css';
import './visual-overrides.css';
import './operations.css';
import 'leaflet/dist/leaflet.css';

const API = 'http://localhost:4000/api';
const SUPPORTED_WORKSPACES = ['Hyderabad Operations', 'Warangal Operations'];
const CITY_CONFIG = {
  'Hyderabad Operations': { name: 'Hyderabad', latitude: 17.3850, longitude: 78.4867, zoom: 11 },
  'Warangal Operations': { name: 'Warangal', latitude: 17.9689, longitude: 79.5941, zoom: 12 }
};
const fetchJson = (path, options = {}) => fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(localStorage.getItem('ecoflow_token') ? { Authorization: `Bearer ${localStorage.getItem('ecoflow_token')}` } : {}), ...options.headers } }).then(async response => {
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof body === 'string' ? `API request failed (${response.status})` : (body.error || 'Request failed'));
  if (typeof body === 'string') throw new Error(`API returned non-JSON data for ${path}`);
  return body;
});
const ROLE_NAV = {
  ADMIN: [['Overview', Gauge], ['Map', Map], ['Bin Monitoring', Layers3], ['Collection Tasks', Route], ['Routes', Route], ['Fleet', Truck], ['Drivers', UserRound], ['Locations', Map], ['Public Reports', PackageCheck], ['Agents', Bot], ['Analytics', Activity], ['Users', UserRound], ['Audit Logs', Radio], ['Settings', Settings2]],
  OPERATOR: [['Overview', Gauge], ['Map', Map], ['Bin Monitoring', Layers3], ['Collection Tasks', Route], ['My Routes', Route], ['Fleet Status', Truck], ['Drivers', UserRound], ['Public Reports', PackageCheck], ['Agent Activity', Bot], ['Notifications', Bell]],
  VIEWER: [['Home', Gauge], ['Report an Issue', Send], ['My Reports', PackageCheck], ['Notifications', Bell], ['Profile', UserRound]],
  CITIZEN: [['Home', Gauge], ['Report an Issue', Send], ['My Reports', PackageCheck], ['Notifications', Bell], ['Profile', UserRound]]
};
const ROLE_SERVICES = { VIEWER: [], CITIZEN: [] };

function App() {
  const [dashboard, setDashboard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [run, setRun] = useState({ actions: [] });
  const [agentMode, setAgentMode] = useState('LOCAL_RULE_ENGINE');
  const [agentState, setAgentState] = useState('OFFLINE');
  const [section, setSection] = useState('Overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspace, setWorkspace] = useState(() => localStorage.getItem('ecoflow_workspace') || 'Hyderabad Operations');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([{ role: 'agent', text: 'I am connected to live EcoFlow operations. Ask which bins need collection, why a bin is critical, or ask me to optimize today\'s route.' }]);
  const [sessionUser, setSessionUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [incidentForm, setIncidentForm] = useState({ location: '', wasteType: 'Mixed', severity: 'MEDIUM', description: '' });
  const [incidentStatus, setIncidentStatus] = useState({ type: '', message: '' });

  const load = async (selectedWorkspace = workspace, role = sessionUser?.role) => {
    try { setError(''); const [overview, collectionTasks, notices, fleet, status] = await Promise.all([
      ['CITIZEN', 'VIEWER'].includes(role) ? Promise.resolve({ metrics: {}, bins: [], incidents: [], wasteTrend: [] }) : fetchJson(`/dashboard?workspace=${encodeURIComponent(selectedWorkspace)}`),
      ['CITIZEN', 'VIEWER'].includes(role) ? Promise.resolve([]) : fetchJson('/collections'),
      fetchJson('/notifications'),
      ['CITIZEN', 'VIEWER'].includes(role) ? Promise.resolve([]) : fetchJson('/vehicles'),
      ['CITIZEN', 'VIEWER'].includes(role) ? Promise.resolve({ mode: 'CITIZEN', state: 'ONLINE' }) : fetchJson('/ai/status')
    ]); setDashboard(overview); setTasks(collectionTasks); setNotifications(notices); setVehicles(fleet); setAgentMode(status.mode || 'LOCAL_RULE_ENGINE'); setAgentState(status.state || 'OFFLINE'); } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  const saveProfileSettings = async (updates) => {
    try {
      const response = await fetchJson('/auth/profile', { method: 'PATCH', body: JSON.stringify(updates) });
      setSessionUser(response.user);
      if (response.user.workspace) {
        localStorage.setItem('ecoflow_workspace', response.user.workspace);
        setWorkspace(response.user.workspace);
      }
      return response.user;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };
  useEffect(() => { (async () => { try { const token = localStorage.getItem('ecoflow_token'); if (!token) return; const session = await fetchJson('/auth/me'); setSessionUser(session.user); await load(workspace, session.user.role); } catch (_) { localStorage.removeItem('ecoflow_token'); } finally { setAuthLoading(false); } })(); }, []);
  useEffect(() => {
    if (!sessionUser) return undefined;
    if (!sessionUser.autoRefresh) return undefined;
    const timer = setInterval(() => {
      if (localStorage.getItem('ecoflow_token')) load(workspace);
    }, 5000);
    return () => clearInterval(timer);
  }, [sessionUser?.autoRefresh, sessionUser?.id, workspace]);
  const login = async (email, password) => { setAuthError(''); try { const session = await fetchJson('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); localStorage.setItem('ecoflow_token', session.token); setSessionUser(session.user); await load(workspace, session.user.role); } catch (err) { setAuthError(err.message || 'Invalid email or password'); } };
  const runAgent = async () => { setRun({ loading: true }); try { const result = await fetchJson('/ai/run', { method: 'POST' }); setRun(result); setAgentMode(result.mode || 'LOCAL_RULE_ENGINE'); setAgentState(result.agentStatus || result.state || 'COMPLETED'); await load(); return result; } catch (err) { setRun({ error: err.message }); setAgentState('ERROR'); setError(err.message); throw err; } };
  const runCommand = async query => {
    if (/run autonomous optimization|optimize today'?s routes/i.test(query)) return runAgent();
    setRun({ loading: true, prompt: query });
    try {
      const result = await fetchJson('/agent/query', { method: 'POST', body: JSON.stringify({ query }) });
      setRun(result.run || { answer: result.answer, status: 'VERIFIED' });
      setAgentMode(result.run?.mode || 'LOCAL_RULE_ENGINE'); setAgentState(result.run?.agentStatus || result.run?.state || 'COMPLETED');
      if (result.refresh || result.run) await load();
      return result.run || result;
    } catch (err) {
      setRun({ error: err.message, status: 'ERROR', prompt: query });
      setError(err.message);
      throw err;
    }
  };
  const updateTask = async (taskId, status) => { try { await fetchJson(`/collections/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (err) { setError(err.message); } };
  const createTask = async (payload) => {
    try {
      setError('');
      const task = await fetchJson('/collections', { method: 'POST', body: JSON.stringify(payload) });
      await load();
      setSection('Collection Tasks');
      return task;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };
  const saveIncident = async (event) => {
    event.preventDefault();
    const payload = {
      location: incidentForm.location.trim(),
      wasteType: incidentForm.wasteType,
      severity: incidentForm.severity,
      description: incidentForm.description.trim(),
      reporter: sessionUser?.email || 'system@ecoflow.local'
    };

    if (!payload.location || !payload.description) {
      setIncidentStatus({ type: 'error', message: 'Location and description are required.' });
      return;
    }

    try {
      setIncidentStatus({ type: 'loading', message: 'Submitting incident...' });
      await fetchJson('/incidents', { method: 'POST', body: JSON.stringify(payload) });
      setIncidentForm({ location: '', wasteType: 'Mixed', severity: 'MEDIUM', description: '' });
      setIncidentStatus({ type: 'success', message: 'Incident logged and shared with operations.' });
      await load();
    } catch (err) {
      setIncidentStatus({ type: 'error', message: err.message || 'Unable to report incident.' });
    }
  };
  const markNotificationRead = async notification => { try { await fetchJson(`/notifications/${notification.id}/read`, { method: 'PATCH' }); setNotifications(current => current.map(item => item.id === notification.id ? { ...item, read: true } : item)); } catch (err) { setError(err.message); } };
  const submitChat = async event => { event.preventDefault(); const query = chatInput.trim(); if (!query) return; setChatInput(''); setChatMessages(current => [...current, { role: 'user', text: query }]); try { const result = await runCommand(query); setChatMessages(current => [...current, { role: 'agent', run: result, text: result?.answer || 'Agent completed the requested operation.' }]); } catch (err) { setChatMessages(current => [...current, { role: 'agent', error: err.message, text: err.message }]); } };
  const logout = () => { localStorage.removeItem('ecoflow_token'); setSessionUser(null); setDashboard(null); setTasks([]); setNotifications([]); };
  const changeWorkspace = async value => {
    setWorkspace(value);
    localStorage.setItem('ecoflow_workspace', value);
    setWorkspaceOpen(false);
    if (sessionUser) {
      await saveProfileSettings({ workspace: value });
      await load(value);
    }
  };

  const roleNav = ROLE_NAV[sessionUser?.role] || ROLE_NAV.VIEWER;
  const roleServices = ROLE_SERVICES[sessionUser?.role] || [];
  const hiddenSections = sessionUser?.role === 'ADMIN' ? ['AI Command Center'] : [];
  const canVisit = [...roleNav, ...roleServices].some(([label]) => label === section) || hiddenSections.includes(section);
  useEffect(() => {
    const allowed = [...(ROLE_NAV[sessionUser?.role] || []), ...(ROLE_SERVICES[sessionUser?.role] || [])];
    if (sessionUser && !allowed.some(([label]) => label === section) && !(sessionUser.role === 'ADMIN' && section === 'AI Command Center')) setSection(['CITIZEN', 'VIEWER'].includes(sessionUser.role) ? 'Home' : 'Overview');
  }, [sessionUser?.role, section]);
  useEffect(() => {
    const handleDashboardShortcut = event => {
      const button = event.target.closest?.('button');
      if (!button) return;
      const text = button.textContent.trim().toLowerCase();
      if (text.includes('manage tasks')) setSection('Collection Tasks');
      else if (text.includes('view all')) setSection('Bin Monitoring');
      else if (text.includes('open ai command center')) setSection('AI Command Center');
      else if (button.classList.contains('more-button')) setSection('Analytics');
    };
    document.addEventListener('click', handleDashboardShortcut);
    return () => document.removeEventListener('click', handleDashboardShortcut);
  }, []);

  useEffect(() => {
    if (!notificationsOpen) return undefined;
    const closeOnOutsideClick = event => {
      if (!event.target.closest('.notification-popover-anchor')) setNotificationsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [notificationsOpen]);

  if (authLoading) return <div className="loading-screen"><div className="spinner" /><span>Checking your EcoFlow session...</span></div>;
  if (!sessionUser) return <LoginScreen onLogin={login} error={authError} />;
  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Connecting to EcoFlow operations...</span></div>;
  return <div className="app-shell">
    <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><div className="brand-mark"><Leaf size={19} /></div><div><strong>EcoFlow</strong><span>AI OPERATIONS</span></div><button className="mobile-close" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
        {!['VIEWER', 'CITIZEN'].includes(sessionUser.role) && <div className="workspace"><span className="eyebrow">WORKSPACE</span><button className="workspace-select" onClick={() => setWorkspaceOpen(value => !value)}><span className="workspace-dot" />{workspace}<ChevronRight size={15} /></button>{workspaceOpen && <WorkspaceMenu current={workspace} onChange={changeWorkspace} />}</div>}
      <nav>{roleNav.map(([label, Icon]) => <button key={label} className={section === label ? 'nav-item active' : 'nav-item'} onClick={() => { setSection(label); setMenuOpen(false); }}><Icon size={18} /><span>{label}</span>{label === 'AI Command Center' && <span className="nav-badge">3</span>}</button>)}{roleServices.length > 0 && <><span className="nav-section-label">CITIZEN SERVICES</span>{roleServices.map(([label, Icon]) => <button key={label} className={section === label ? 'nav-item active' : 'nav-item'} onClick={() => { setSection(label); setMenuOpen(false); }}><Icon size={18} /><span>{label}</span></button>)}</>}</nav>
      {!['VIEWER', 'CITIZEN'].includes(sessionUser.role) && <div className="sidebar-bottom"><div className="agent-mini"><div className="agent-pulse"><Bot size={17} /></div><div><strong>Agent online</strong><span>{agentMode === 'LLM' ? 'OpenAI LLM' : 'Local rule engine'}</span></div><CircleDot size={13} className="online-icon" /></div><button className="user-chip" onClick={() => setProfileOpen(value => !value)}><div className="avatar">{initials(sessionUser.name)}</div><div><strong>{sessionUser.name}</strong><span>{displayRole(sessionUser.role)}</span></div><ChevronRight size={15} /></button>{profileOpen && <ProfileMenu user={sessionUser} logout={logout} onOpenSettings={sessionUser.role === 'ADMIN' ? () => { setProfileOpen(false); setSettingsOpen(true); } : undefined} />}{settingsOpen && <ProfileSettings user={sessionUser} workspace={workspace} onChangeWorkspace={value => { changeWorkspace(value); saveProfileSettings({ workspace: value }); }} onClose={() => setSettingsOpen(false)} onSave={async (values) => { const updated = await saveProfileSettings(values); if (updated) { setSessionUser(updated); setWorkspace(updated.workspace || workspace); } setSettingsOpen(false); }} />}</div>}
    </aside>
    <main className="main-content">
        <header className="topbar"><button className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><div><span className="breadcrumb">OPERATIONS /</span><strong>{section}</strong></div><div className="top-actions"><div className="system-status"><span />All systems operational</div><div className="popover-anchor notification-popover-anchor"><button className="icon-button notification-button" aria-label="Open notifications" onClick={() => { setNotificationsOpen(value => !value); setProfileOpen(false); }}><Bell size={18} />{notifications.some(n => !n.read) && <span>{notifications.filter(n => !n.read).length}</span>}</button>{notificationsOpen && <NotificationMenu notifications={notifications} onRead={markNotificationRead} />}</div><div className="popover-anchor"><button className="top-avatar" aria-label="Open profile" onClick={() => { setProfileOpen(value => !value); setNotificationsOpen(false); }}>{initials(sessionUser.name)}</button>{profileOpen && <ProfileMenu user={sessionUser} logout={logout} />}</div></div></header>
      {error && <div className="error-banner"><AlertTriangle size={17} />{error}<button onClick={load}>Retry</button></div>}
        {((section === 'Overview' && !['CITIZEN', 'VIEWER'].includes(sessionUser.role)) || (section === 'Home' && ['CITIZEN', 'VIEWER'].includes(sessionUser.role))) ? <RoleDashboard role={sessionUser.role} dashboard={dashboard} tasks={tasks} run={run} runAgent={runAgent} agentMode={agentMode} userName={sessionUser.name} workspace={workspace} updateTask={updateTask} onNavigate={setSection} /> : canVisit ? <SectionView section={section} dashboard={dashboard} tasks={tasks} vehicles={vehicles} workspace={workspace} run={run} runAgent={runAgent} runCommand={runCommand} agentMode={agentMode} agentState={agentState} canOptimize={sessionUser.role === 'ADMIN'} operator={sessionUser.role === 'OPERATOR'} sessionUser={sessionUser} updateTask={updateTask} createTask={createTask} incidentForm={incidentForm} setIncidentForm={setIncidentForm} incidentStatus={incidentStatus} saveIncident={saveIncident} role={sessionUser.role} onNavigate={setSection} notifications={notifications} onReadNotification={markNotificationRead} /> : <AccessDenied />}
      {sessionUser.role === 'OPERATOR' && section === 'Overview' && <OperatorTaskActions tasks={tasks} updateTask={updateTask} />}
      {!['VIEWER', 'CITIZEN'].includes(sessionUser.role) && <><button className="chat-launcher" title="Open EcoFlow operations assistant" aria-label="Open EcoFlow operations assistant" onClick={() => setChatOpen(value => !value)}>{chatOpen ? <X size={16} /> : <Bot size={20} />}{!chatOpen && <span className="chat-dot" />}</button>{chatOpen && <ChatPanel messages={chatMessages} input={chatInput} setInput={setChatInput} onSubmit={submitChat} onClose={() => setChatOpen(false)} mode={agentMode} />}</>}
    </main>
  </div>;
}

function AccessDenied() { return <div className="page"><div className="section-placeholder"><div className="placeholder-icon"><AlertTriangle size={24} /></div><h2>403 - Access denied</h2><p>Your role does not have access to this area.</p></div></div>; }
function RoleDashboard({ role, dashboard, tasks, run, runAgent, agentMode, userName, workspace, updateTask, onNavigate }) {
  if (role === 'CITIZEN') return <CitizenDashboard userName={userName} onNavigate={onNavigate} notifications={[]} />;
  if (!dashboard) return <div className="loading-screen"><div className="spinner" /><span>Loading EcoFlow operations...</span></div>;
  if (role === 'OPERATOR') return <><OperatorDashboard dashboard={dashboard} tasks={tasks} userName={userName} workspace={workspace} updateTask={updateTask} onNavigate={onNavigate} /><AgentActivityPanel /></>;
  if (role === 'VIEWER') return <ViewerHome userName={userName} onNavigate={onNavigate} />;
  return <><Overview dashboard={dashboard} tasks={tasks} run={run} runAgent={runAgent} agentMode={agentMode} canOptimize userName={userName} workspace={workspace} onNavigate={onNavigate} /><AgentActivityPanel /></>;
}
function OperatorDashboard({ dashboard, tasks, userName, workspace, updateTask, onNavigate }) {
  const active = tasks.filter(task => ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(task.status));
  const nextAction = task => task.status === 'PENDING' ? 'ASSIGNED' : task.status === 'ASSIGNED' ? 'IN_PROGRESS' : 'COMPLETED';
  const actionLabel = task => task.status === 'PENDING' ? 'Accept task' : task.status === 'ASSIGNED' ? 'Start collection' : 'Complete';
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">OPERATOR WORKSPACE</span><h1>Good morning, {userName}<span className="heading-period">.</span></h1><p>Your assigned collections and operational alerts for {workspace}.</p></div><span className="role-badge operator">OPERATOR</span></div><section className="metric-grid">{[['Assigned tasks', active.length], ['In progress', active.filter(task => task.status === 'IN_PROGRESS').length], ['Completed', tasks.filter(task => task.status === 'COMPLETED').length], ['Critical bins', dashboard.metrics.criticalBins]].map(([label, value]) => <div className="metric-card" key={label}><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-foot">Live operational count</span></div>)}</section><div className="panel tasks-panel"><div className="panel-heading"><div><span className="eyebrow">TODAY&apos;S WORK</span><h2>Assigned collection tasks</h2></div><span className="live-label"><span />MY QUEUE</span></div>{active.length ? active.map(task => <div className="task-row full-task-row" key={task.id}><strong>{task.id}<small>{task.bins.join(' → ')} · {task.priority}</small></strong><span className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</span><span className="route-cell"><Route size={14} />{task.vehicle}<small>{task.distance} km · {task.duration} min</small></span><span className={`task-status ${task.status.toLowerCase()}`}><span />{task.status.replace('_', ' ')}</span><button className="secondary-button" onClick={() => updateTask(task.id, nextAction(task))}>{actionLabel(task)}</button></div>) : <div className="empty-popover">No assigned collection tasks.</div>}</div><div className="lower-grid"><div className="panel bin-panel"><div className="panel-heading"><div><span className="eyebrow">NEARBY RISK</span><h2>Critical bins</h2></div></div><div className="bin-list">{dashboard.bins.filter(bin => bin.priority === 'CRITICAL').slice(0, 5).map(bin => <div className="bin-row" key={bin.id}><div className="bin-status critical"><Layers3 size={17} /></div><div className="bin-meta"><strong>{bin.id}<small>{bin.location}</small></strong><span>{bin.fill}% full · {bin.forecast.hours}h to overflow</span></div></div>)}</div></div><IncidentPanel incidents={dashboard.incidents || []} /></div></div>;
}
function ViewerHome({ userName, onNavigate }) {
  const [reports, setReports] = useState([]);
  useEffect(() => { let active = true; const load = async () => { try { const response = await fetchJson('/public-reports?mine=true'); if (active) setReports(response.data || []); } catch (_) {} }; load(); const timer = setInterval(load, 5000); return () => { active = false; clearInterval(timer); }; }, []);
  const active = reports.filter(report => !['RESOLVED', 'CLOSED'].includes(report.status));
  const resolved = reports.filter(report => ['RESOLVED', 'CLOSED'].includes(report.status));
  return <div className="page viewer-home"><div className="page-heading"><div><span className="eyebrow">PERSONAL SPACE</span><h1>Welcome, {userName}<span className="heading-period">.</span></h1><p>Report a local waste issue and follow its progress.</p></div><button className="primary-button" onClick={() => onNavigate('Report an Issue')}><Send size={16} />Report an issue</button></div><section className="metric-grid viewer-metrics"><div className="metric-card"><span className="metric-label">Open reports</span><strong className="metric-value">{active.length}</strong><span className="metric-foot">Your submitted reports</span></div><div className="metric-card"><span className="metric-label">Resolved reports</span><strong className="metric-value">{resolved.length}</strong><span className="metric-foot">Issues completed</span></div></section><section className="viewer-welcome panel"><div><span className="eyebrow">YOUR REPORTS</span><h2>Track what you have submitted</h2><p>Every report stays private to your account.</p></div><button className="secondary-button" onClick={() => onNavigate('My Reports')}>View my reports <ChevronRight size={15} /></button></section></div>;
}

function CitizenDashboard({ userName, onNavigate }) {
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const loadReports = async () => { try { setLoadingReports(true); const response = await fetchJson('/public-reports?mine=true'); setReports(response.data || []); } catch (_) {} finally { setLoadingReports(false); } };
  useEffect(() => { loadReports(); const timer = setInterval(loadReports, 5000); return () => clearInterval(timer); }, []);
  const active = reports.filter(report => !['RESOLVED', 'CLOSED'].includes(report.status));
  const resolved = reports.filter(report => ['RESOLVED', 'CLOSED'].includes(report.status));
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">CITIZEN HOME</span><h1>Welcome to EcoFlow<span className="heading-period">.</span></h1><p>Report waste problems in your area and track their resolution.</p></div><button className="primary-button" onClick={() => onNavigate('Report an Issue')}><Send size={16} />Report an issue</button></div><div className="metric-grid"><div className="metric-card"><span className="metric-label">My active reports</span><strong className="metric-value">{loadingReports ? '...' : active.length}</strong><span className="metric-foot">Backend-tracked</span></div><div className="metric-card"><span className="metric-label">Resolved reports</span><strong className="metric-value">{loadingReports ? '...' : resolved.length}</strong><span className="metric-foot">Verified outcomes</span></div></div><ReportSummary title="My Active Reports" reports={active} empty="You haven't reported any active waste issues yet." onNavigate={onNavigate} /><ReportSummary title="My Resolved Reports" reports={resolved} empty="No reports have been resolved yet." onNavigate={onNavigate} /></div>;
}

function ReportImage({ src, alt = 'Report photo', className = '' }) { const [failed, setFailed] = useState(!src); if (failed) return <div className={`report-image-placeholder ${className}`} aria-label="Photo unavailable"><ImageOff size={22} /><span>Photo unavailable</span></div>; return <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />; }
function readableIssue(issueType = '') { return ({ OVERFLOWING_BIN: 'Overflowing waste', GARBAGE_DUMPED_OUTSIDE_BIN: 'Waste outside bin', MISSED_COLLECTION: 'Missed collection', ILLEGAL_DUMPING: 'Illegal dumping', DAMAGED_BIN: 'Damaged bin', OTHER_WASTE_ISSUE: 'Waste issue' }[issueType] || 'Waste issue'); }
function readableStatus(status = '') { return ({ OPEN: 'Under review', IN_PROGRESS: 'Response in progress', RESOLVED: 'Issue resolved', CLOSED: 'Issue resolved', NO_FLEET_AVAILABLE: 'Response pending', SEVERITY_ASSESSED: 'Report reviewed', TASK_CREATED: 'Response in progress' }[status] || 'Under review'); }
function readableSeverity(severity = '') { return severity ? `${severity[0]}${severity.slice(1).toLowerCase()} priority` : 'Priority pending'; }
function formatReportDate(value) { return value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Date unavailable'; }
function ReportSummary({ title, reports, empty, onNavigate }) { return <section className="panel tasks-panel" style={{ marginTop: 18 }}><div className="panel-heading"><div><span className="eyebrow">MY REPORTS</span><h2>{title}</h2></div></div>{reports.length ? reports.slice(0, 5).map(report => <button className="task-row full-task-row" key={report.id} onClick={() => onNavigate('My Reports')}><strong>{report.id}<small>{readableIssue(report.issueType)} · {formatReportDate(report.createdAt || report.timestamp)}</small></strong><span className={`priority ${String(report.severity || 'MEDIUM').toLowerCase()}`}>{readableSeverity(report.severity)}</span><span>{readableStatus(report.status)}</span><ChevronRight size={16} /></button>) : <div className="empty-popover">{empty}</div>}</section>; }

function initials(name = '') { return name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
function displayRole(role = '') { return role === 'VIEWER' ? 'USER' : role; }
function PublicReportLauncher() {
  const [open, setOpen] = useState(false);
  return open ? <div className="login-shell" style={{ position: 'fixed', inset: 0, zIndex: 20, overflow: 'auto' }}><PublicReportForm onBack={() => setOpen(false)} /></div> : <button className="primary-button" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 10 }} onClick={() => setOpen(true)}>Report a waste issue <Send size={16} /></button>;
}
function PublicReportForm({ onBack }) {
  const [form, setForm] = useState({ issueType: 'OVERFLOWING_BIN', description: '', latitude: '17.4401', longitude: '78.3489', photo: '' });
  const [status, setStatus] = useState('');
  const [report, setReport] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) { setStatus('Location is not supported by this browser. Enter coordinates manually.'); return; }
    setStatus('Getting your location...');
    navigator.geolocation.getCurrentPosition(
      position => { setForm(current => ({ ...current, latitude: position.coords.latitude.toFixed(6), longitude: position.coords.longitude.toFixed(6) })); setStatus('Location updated on the map.'); },
      error => setStatus(error.code === 1 ? 'Location permission was denied. Allow location access or enter coordinates manually.' : 'Unable to get your location. Enter coordinates manually.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };
  const choosePhoto = event => { const file = event.target.files?.[0]; if (!file || !file.type.startsWith('image/')) { setStatus('Please choose an image file.'); return; } const reader = new FileReader(); reader.onload = () => setForm(current => ({ ...current, photo: String(reader.result) })); reader.readAsDataURL(file); };
  const submit = async event => { event.preventDefault(); if (!form.photo || !form.description.trim() || !form.latitude || !form.longitude) { setStatus('Photo, description, and location are required.'); return; } setSubmitting(true); try { setStatus(''); const result = await fetchJson('/public-reports', { method: 'POST', body: JSON.stringify({ ...form, description: form.description.trim(), latitude: Number(form.latitude), longitude: Number(form.longitude), source: 'CITIZEN' }) }); setReport(result.data || result); setStatus('Report submitted successfully'); } catch (error) { setStatus(error.message); } finally { setSubmitting(false); } };
  useEffect(() => { if (!report?.id || report.status === 'RESOLVED') return undefined; const timer = setInterval(async () => { try { const response = await fetchJson(`/public-reports/${report.id}/status`); setReport(current => ({ ...current, ...response.data })); } catch (_) {} }, 5000); return () => clearInterval(timer); }, [report?.id, report?.status]);
  if (report) return <section className="login-panel report-submitted"><div className="login-brand"><div className="brand-mark"><Leaf size={20} /></div><div><strong>EcoFlow</strong><span>PERSONAL REPORT</span></div></div><div className="login-copy"><span className="eyebrow">REPORT SUBMITTED</span><h1><CheckCircle2 size={28} /> Report received</h1><p>Report submitted successfully</p></div><div className="report-confirmation"><span>Report ID</span><strong>{report.id}</strong></div><button className="primary-button" onClick={() => onBack(report)}>View details <ChevronRight size={16} /></button><button className="secondary-button" onClick={() => onBack()}>Return to my reports</button></section>;
  return <section className="login-panel"><div className="login-brand"><div className="brand-mark"><Leaf size={20} /></div><div><strong>EcoFlow</strong><span>PUBLIC REPORT</span></div></div><div className="login-copy"><span className="eyebrow">CITIZEN REPORTING</span><h1>Report a waste issue<span>.</span></h1><p>Submit evidence for backend analysis and operational follow-up.</p></div><form className="login-form" onSubmit={submit}><label>Issue type<select value={form.issueType} onChange={event => setForm(current => ({ ...current, issueType: event.target.value }))}><option value="OVERFLOWING_BIN">Overflowing Bin</option><option value="GARBAGE_DUMPED_OUTSIDE_BIN">Garbage Dumped Outside Bin</option><option value="MISSED_COLLECTION">Missed Collection</option><option value="ILLEGAL_DUMPING">Illegal Dumping</option><option value="DAMAGED_BIN">Damaged Bin</option><option value="OTHER_WASTE_ISSUE">Other Waste Issue</option></select></label><label>Photo evidence<input type="file" accept="image/*" onChange={choosePhoto} required />{form.photo && <img className="report-photo-preview" src={form.photo} alt="Selected report evidence preview" />}</label><label>Description<textarea placeholder="Describe the problem..." value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} required /></label><div className="report-location"><span className="eyebrow">LOCATION</span><LocationMap latitude={form.latitude} longitude={form.longitude} /><div className="location-coordinates"><label>Latitude<input type="number" step="any" value={form.latitude} onChange={event => setForm(current => ({ ...current, latitude: event.target.value }))} required /></label><label>Longitude<input type="number" step="any" value={form.longitude} onChange={event => setForm(current => ({ ...current, longitude: event.target.value }))} required /></label></div><button className="secondary-button" type="button" onClick={locate}>Use my location</button></div>{status && <div className="login-error">{status}</div>}<button className="primary-button login-submit" disabled={!form.photo || submitting}>{submitting ? 'Submitting...' : 'Submit report'} <Send size={16} /></button></form><button className="text-button" onClick={onBack}>Return</button></section>;
}

function LocationMap({ latitude, longitude }) {
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  useEffect(() => {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!mapRef.current || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    const map = L.map(mapRef.current, { zoomControl: true }).setView([lat, lon], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    markerRef.current = L.marker([lat, lon]).addTo(map);
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); markerRef.current = null; };
  }, []);
  useEffect(() => {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (markerRef.current && Number.isFinite(lat) && Number.isFinite(lon)) markerRef.current.setLatLng([lat, lon]);
  }, [latitude, longitude]);
  return <div className="report-location-map" ref={mapRef} aria-label="Selected report location map" />;
}

function CitizenReportsView() {
  const [reports, setReports] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = async () => { try { setLoading(true); setError(''); const response = await fetchJson('/public-reports?mine=true'); setReports(response.data || []); } catch (loadError) { setError(loadError.message || 'Unable to load your reports.'); } finally { setLoading(false); } };
  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []);
  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading your reports...</span></div>;
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">PERSONAL REPORTS</span><h1>My Reports<span className="heading-period">.</span></h1><p>Private updates for the waste issues you submitted.</p></div></div>{error && <div className="error-banner"><AlertTriangle size={17} />{error}<button onClick={load}>Retry</button></div>}{reports.length ? <div className="personal-report-grid">{reports.map(report => <button className="personal-report-card" key={report.id} onClick={() => setSelected(report)}><ReportImage src={report.photo} alt="Uploaded waste report" className="personal-report-photo" /><div className="personal-report-content"><div className="personal-report-topline"><span className="report-id">{report.id}</span><span className={`personal-status ${String(report.status || 'OPEN').toLowerCase()}`}>{readableStatus(report.status)}</span></div><h2>{readableIssue(report.issueType)}</h2><p className="personal-report-description">{report.description || 'No description provided.'}</p><div className="personal-report-meta"><span>Reported {formatReportDate(report.createdAt || report.timestamp)}</span><span>{readableSeverity(report.severity)}</span></div><span className="personal-report-action">View details <ChevronRight size={15} /></span></div></button>)}</div> : !error && <div className="section-placeholder"><h2>No reports yet</h2><p>Your submitted waste issues will appear here.</p></div>}{selected && <CitizenReportDetail report={selected} onClose={() => setSelected(null)} />}</div>;
}

function CitizenReportDetail({ report, onClose }) {
  const [detail, setDetail] = useState(report);
  useEffect(() => { let active = true; fetchJson(`/public-reports/${report.id}/status`).then(response => { if (active) setDetail(current => ({ ...current, ...response.data })); }).catch(() => {}); return () => { active = false; }; }, [report.id, report.status]);
  const timeline = detail.timeline || [];
  const reviewed = timeline.some(item => ['REPORT_ANALYZED', 'SEVERITY_ASSESSED'].includes(item.action));
  const responding = ['IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(detail.status) || timeline.some(item => ['TASK_CREATED', 'TASK_DISPATCHED'].includes(item.action));
  const resolved = ['RESOLVED', 'CLOSED'].includes(detail.status);
  const steps = [['submitted', 'Report submitted', true], ['reviewed', 'Report reviewed', reviewed || responding || resolved], ['response', 'Response in progress', responding], ['resolved', 'Issue resolved', resolved]];
  return <div className="detail-drawer personal-report-detail"><button className="icon-button" onClick={onClose} aria-label="Close report"><X size={16} /></button><span className="eyebrow">YOUR REPORT</span><h2>Report #{detail.id}</h2><ReportImage src={detail.photo} alt="Uploaded waste report" className="report-detail-photo" /><div className="personal-detail-copy"><p><strong>Issue</strong>{readableIssue(detail.issueType)}</p><p><strong>Description</strong>{detail.description || 'No description provided.'}</p><p><strong>Location</strong>{detail.latitude != null && detail.longitude != null ? `${detail.latitude}, ${detail.longitude}` : 'Not available'}</p><p><strong>Reported</strong>{detail.createdAt || detail.timestamp ? new Date(detail.createdAt || detail.timestamp).toLocaleString() : 'Date unavailable'}</p><p><strong>Status</strong><span className="personal-status">{readableStatus(detail.status || detail.currentAction)}</span></p></div>{resolved && <div className="task-success"><strong>Your reported issue has been resolved.</strong>{detail.resolutionDetails && <span>{detail.resolutionDetails}</span>}</div>}<div className="personal-timeline"><span className="eyebrow">STATUS TIMELINE</span>{steps.map(([key, label, complete], index) => <div className="personal-timeline-item" key={key}><span className={complete ? 'timeline-check complete' : index === steps.findIndex(step => !step[2]) ? 'timeline-check current' : 'timeline-check'}>{complete ? '✓' : index === steps.findIndex(step => !step[2]) ? '●' : '○'}</span><span>{label}</span></div>)}</div></div>;
}

function CitizenNotificationsView() {
  const [notifications, setNotifications] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const load = async () => { try { setNotifications(await fetchJson('/notifications')); } catch (_) {} };
  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []);
  const openNotification = async notification => { try { await fetchJson(`/notifications/${notification.id}/read`, { method: 'PATCH' }); if (notification.reportId) { const response = await fetchJson(`/public-reports/${notification.reportId}/status`); setSelectedReport(response.data); } load(); } catch (_) {} };
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">CITIZEN UPDATES</span><h1>Notifications<span className="heading-period">.</span></h1><p>Updates about your submitted reports.</p></div></div><NotificationPage notifications={notifications} onRead={openNotification} />{selectedReport && <CitizenReportDetail report={selectedReport} onClose={() => setSelectedReport(null)} />}</div>;
}

function NotificationPage({ notifications, onRead }) { return <div className="panel tasks-panel">{notifications.length ? notifications.map(notification => <button className={notification.read ? 'notice read' : 'notice'} key={notification.id} onClick={() => onRead(notification)}><div className="notice-icon"><Bell size={14} /></div><div><strong>{notification.title}</strong><span>{notification.body}</span><small>{notification.time}</small></div>{!notification.read && <Check size={14} />}</button>) : <div className="empty-popover">No notifications yet.</div>}</div>; }
function LoginScreen({ onLogin, error }) {
  const [email, setEmail] = useState('saiganesh@gmail.com');
  const [password, setPassword] = useState('ultron2026');
  const [submitting, setSubmitting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const submit = async event => { event.preventDefault(); setSubmitting(true); await onLogin(email, password); setSubmitting(false); };
  const choose = (account, accountPassword) => { setEmail(account); setPassword(accountPassword); };
  if (reporting) return <main className="login-shell"><PublicReportForm onBack={() => setReporting(false)} /><aside className="login-aside"><div className="login-aside-content"><span className="eyebrow">PUBLIC REPORTING</span><h2>Report once. Track the response.</h2><p>Your report is analyzed by the existing EcoFlow operations agent and linked to the verified fleet workflow.</p></div></aside></main>;
  return <main className="login-shell"><section className="login-panel"><div className="login-brand"><div className="brand-mark"><Leaf size={20} /></div><div><strong>EcoFlow</strong><span>AI OPERATIONS</span></div></div><div className="login-copy"><span className="eyebrow">SECURE OPERATIONS ACCESS</span><h1>Welcome back<span>.</span></h1><p>Sign in to monitor waste intelligence and coordinate your campus operations.</p></div><form className="login-form" onSubmit={submit}><label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>{error && <div className="login-error"><AlertTriangle size={15} />{error}</div>}<button className="primary-button login-submit" disabled={submitting}>{submitting ? 'Signing in...' : 'Sign in to EcoFlow'}<ChevronRight size={16} /></button></form><div className="demo-access"><span className="eyebrow">DEMO ACCESS</span><div className="demo-options"><button onClick={() => choose('saiganesh@gmail.com', 'ultron2026')}><strong>Admin</strong><small>Full operational control</small></button><button onClick={() => choose('bhanu@gmail.com', 'ultron2026')}><strong>Operator</strong><small>Field task access</small></button><button onClick={() => choose('user@gmail.com', '123456')}><strong>Viewer</strong><small>Read-only analytics</small></button></div></div></section><aside className="login-aside"><div className="login-aside-content"><span className="eyebrow">AUTONOMOUS WASTE INTELLIGENCE</span><h2>Know what happens next.</h2><p>EcoFlow observes your campus, predicts overflow, and turns live signals into verified collection decisions.</p><div className="login-proof"><div><strong>24</strong><span>Connected bins</span></div><div><strong>87</strong><span>Eco score</span></div><div><strong>91%</strong><span>Route efficiency</span></div></div></div></aside></main>;
}
function OperatorTaskActions({ tasks, updateTask }) { const assigned = tasks.filter(task => ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(task.status)); return <div className="operator-actions"><div><span className="eyebrow">OPERATOR CONSOLE</span><strong>Assigned collection actions</strong></div>{assigned.slice(0, 3).map(task => <div className="operator-task" key={task.id}><div><strong>{task.id}</strong><span>{task.bins.join(' → ')} · {task.vehicle}</span></div>{task.status === 'IN_PROGRESS' ? <button className="secondary-button" onClick={() => updateTask(task.id, 'COMPLETED')}><CheckCircle2 size={14} />Complete</button> : <button className="secondary-button" onClick={() => updateTask(task.id, task.status === 'PENDING' ? 'ASSIGNED' : 'IN_PROGRESS')}><Truck size={14} />{task.status === 'PENDING' ? 'Accept task' : 'Start task'}</button>}</div>)}</div>; }
function ProfileMenu({ user, logout, onOpenSettings }) { return <div className="profile-menu popover"><div className="profile-heading"><div className="avatar">{initials(user.name)}</div><div><strong>{user.name}</strong><span>{displayRole(user.role)} · {user.email}</span></div></div>{onOpenSettings && <button onClick={onOpenSettings}><UserRound size={15} />Profile settings</button>}<button onClick={logout}><LogOut size={15} />Sign out</button></div>; }
function ProfileSettings({ user, workspace, onChangeWorkspace, onClose, onSave }) {
  const [localWorkspace, setLocalWorkspace] = useState(workspace);
  const [notifications, setNotifications] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    setLocalWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    setNotifications(Boolean(user?.notifications ?? true));
    setAutoRefresh(Boolean(user?.autoRefresh ?? true));
  }, [user]);

  const save = () => {
    if (localWorkspace !== workspace) onChangeWorkspace(localWorkspace);
    onSave({ workspace: localWorkspace, notifications, autoRefresh });
  };

  return <div className="profile-menu popover settings-panel"><div className="profile-heading"><div className="avatar">{initials(user.name)}</div><div><strong>{user.name}</strong><span>{displayRole(user.role)} · {user.email}</span></div></div><div className="panel-heading"><div><span className="eyebrow">PROFILE SETTINGS</span><h2>Preferences</h2></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={15} /></button></div><div className="settings-list"><label className="settings-field"><span>City</span><select value={localWorkspace} onChange={event => setLocalWorkspace(event.target.value)}>{SUPPORTED_WORKSPACES.map(option => <option value={option} key={option}>{option.replace(' Operations', '')}</option>)}</select></label><label className="settings-field"><span>Notifications</span><input type="checkbox" checked={notifications} onChange={event => setNotifications(event.target.checked)} /></label><label className="settings-field"><span>Auto-refresh</span><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} /></label></div><button className="primary-button" onClick={save}>Save changes</button></div>;
}
function WorkspaceMenu({ current, onChange }) { return <div className="workspace-menu"><span className="workspace-menu-label">SELECT CITY</span>{SUPPORTED_WORKSPACES.map(option => <button className={current === option ? 'workspace-option selected' : 'workspace-option'} key={option} onClick={() => onChange(option)}><span className="workspace-dot" />{option.replace(' Operations', '')}{current === option && <Check size={14} />}</button>)}</div>; }
function NotificationMenu({ notifications, onRead }) { return <div className="notification-menu popover"><div className="popover-title"><strong>Notifications</strong><span>{notifications.filter(item => !item.read).length} unread</span></div>{notifications.length ? notifications.slice(0, 5).map(notification => <button className={notification.read ? 'notice read' : 'notice'} key={notification.id} onClick={() => onRead(notification)}><div className="notice-icon"><Bell size={14} /></div><div><strong>{notification.title}</strong><span>{notification.body}</span><small>{notification.time}</small></div>{!notification.read && <Check size={14} />}</button>) : <div className="empty-popover">You&apos;re all caught up.</div>}</div>; }
function ChatPanel({ messages, input, setInput, onSubmit, onClose, mode }) { return <section className="chat-panel"><div className="chat-header"><div className="chat-agent-icon"><Bot size={17} /></div><div><strong>EcoFlow assistant</strong><span>Hyderabad live operations · {mode === 'LLM' ? 'OpenAI LLM' : 'validated local engine'}</span></div><button onClick={onClose}><X size={16} /></button></div><div className="chat-messages">{messages.map((message, index) => <div className={`chat-message ${message.role} ${message.error ? 'chat-error' : ''}`} key={`${message.role}-${index}`}>{message.role === 'agent' && <Bot size={14} /> }<div>{message.run ? <OperationCard run={message.run} compact /> : <p>{message.text}</p>}</div></div>)}</div><form className="chat-form" onSubmit={onSubmit}><input value={input} onChange={event => setInput(event.target.value)} placeholder="Ask about bins, routes, or dispatch..." aria-label="Ask EcoFlow assistant" /><button type="submit" aria-label="Send message"><Send size={16} /></button></form></section>; }

  function Overview({ dashboard, tasks, run, runAgent, agentMode, canOptimize, operator, userName, workspace, onNavigate }) {
  const { metrics, wasteTrend, categoryMix, bins } = dashboard;
    const campusName = workspace || 'Hyderabad Operations';
  const todayLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date()).toUpperCase();
    return <div className="page"><div className="page-heading"><div><span className="eyebrow">{todayLabel}</span><h1>Good morning, {userName}<span className="heading-period">.</span></h1><p>{operator ? 'Your assigned field operations and campus collection status.' : 'Here is what is happening across your campus today.'}</p></div>{canOptimize && <button className="primary-button" onClick={runAgent}><Bot size={17} />Run AI optimization <span className="shortcut">⌘ ↵</span></button>}</div><div className="collection-visual"><img src="https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?auto=format&fit=crop&w=1400&q=85" alt="Sorted recycling containers ready for collection" /><div className="collection-visual-copy"><span className="eyebrow">{campusName.toUpperCase()} COLLECTION NETWORK</span><h2>Cleaner routes.<br />Smarter recovery.</h2><p>Live collection intelligence for a healthier campus.</p><div className="visual-stats"><span><strong>{dashboard.metrics.totalBins}</strong> sensor bins</span><span><strong>{dashboard.metrics.ecoScore}</strong> eco score</span></div></div><div className="visual-live"><span>LIVE OPERATIONS</span></div></div>
    <div className="agent-strip"><div className="agent-strip-icon"><Bot size={21} /></div><div className="agent-copy"><strong>Autonomous agent is monitoring your operations</strong><span>{run?.loading ? 'Analyzing live bin conditions...' : run ? `Last run completed just now · ${run.actions?.length || 0} actions verified` : 'No automated optimization is scheduled. Use the Run AI optimization action when needed.'}</span></div><div className="agent-mode"><span className="green-dot" />{agentMode === 'LLM' ? 'OPENAI LLM' : 'LOCAL RULE ENGINE'}</div><button className="text-button" onClick={() => document.querySelector('.agent-card')?.scrollIntoView({ behavior: 'smooth' })}>View activity <ChevronRight size={15} /></button></div>
    <section className="metric-grid">{[[PackageCheck, 'Today\'s waste', `${metrics.todaysWaste} kg`, '+8.4%', 'teal'], [AlertTriangle, 'Critical bins', metrics.criticalBins, `${metrics.overflowRisk} at risk`, 'coral'], [Truck, 'Active collections', metrics.activeTasks, '2 in progress', 'blue'], [Fuel, 'Est. monthly savings', `₹${(metrics.estimatedSavings / 1000).toFixed(1)}k`, '+12.6%', 'green']].map(([Icon, label, value, foot, tone]) => <div className="metric-card" key={label}><div className={`metric-icon ${tone}`}><Icon size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className={`metric-foot ${tone === 'coral' ? 'warning' : ''}`}>{tone === 'coral' ? <AlertTriangle size={12} /> : <span className="trend">↗</span>}{foot}</span></div>)}</section>
      <section className="metric-grid">{[[PackageCheck, 'Current bin estimate', `${metrics.todaysWaste} kg`, 'Current bin estimate', 'teal'], [AlertTriangle, 'Critical bins', metrics.criticalBins, `${metrics.overflowRisk} at risk`, 'coral'], [Truck, 'Active collections', metrics.activeTasks, 'Live task count', 'blue'], [Fuel, 'Distance-based estimate', `₹${(metrics.estimatedSavings / 1000).toFixed(1)}k`, 'Distance-based estimate', 'green']].map(([Icon, label, value, foot, tone]) => <div className="metric-card" key={label}><div className={`metric-icon ${tone}`}><Icon size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className={`metric-foot ${tone === 'coral' ? 'warning' : ''}`}>{tone === 'coral' ? <AlertTriangle size={12} /> : <span className="trend">↗</span>}{foot}</span></div>)}</section>
    <section className="chart-grid"><div className="panel chart-panel"><div className="panel-heading"><div><span className="eyebrow">WASTE GENERATED</span><h2>Daily volume</h2></div><div className="chart-legend"><span className="legend-total" />Total waste <span className="legend-organic" />Organic</div></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={wasteTrend}><defs><linearGradient id="fillTotal" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#168a77" stopOpacity=".22" /><stop offset="100%" stopColor="#168a77" stopOpacity="0" /></linearGradient></defs><CartesianGrid vertical={false} stroke="#e7edea" /><XAxis dataKey="day" tickFormatter={value => value.replace('Day ', 'D')} tickLine={false} axisLine={false} tick={{ fill: '#8a9996', fontSize: 11 }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8a9996', fontSize: 11 }} /><Tooltip /><Area type="monotone" dataKey="total" stroke="#168a77" strokeWidth={2.5} fill="url(#fillTotal)" /><Area type="monotone" dataKey="organic" stroke="#f0a85c" strokeWidth={1.5} fill="none" /></AreaChart></ResponsiveContainer></div></div><div className="panel category-panel"><div className="panel-heading"><div><span className="eyebrow">WASTE STREAM</span><h2>By category</h2></div><button className="more-button">···</button></div><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={categoryMix} innerRadius={57} outerRadius={78} paddingAngle={3} dataKey="value" stroke="none">{categoryMix.map((_, index) => <Cell key={index} fill={['#168a77', '#f0a85c', '#7aa6bd', '#d77659', '#a8b5a8'][index]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><div className="donut-center"><strong>428</strong><span>KG TOTAL</span></div></div><div className="category-list">{categoryMix.slice(0, 4).map((item, index) => <div key={item.name}><span><i style={{ background: ['#168a77', '#f0a85c', '#7aa6bd', '#d77659'][index] }} />{item.name}</span><strong>{item.value}%</strong></div>)}</div></div></section>
    <section className="lower-grid"><div className="panel bin-panel"><div className="panel-heading"><div><span className="eyebrow">LIVE MONITORING</span><h2>Bins needing attention</h2></div><button className="text-button">View all <ChevronRight size={15} /></button></div><div className="bin-list">{bins.filter(bin => bin.priority !== 'LOW').slice(0, 4).map(bin => <div className="bin-row" key={bin.id}><div className={`bin-status ${bin.priority.toLowerCase()}`}><Layers3 size={17} /></div><div className="bin-meta"><strong>{bin.id} <small>{bin.location}</small></strong><span>{bin.wasteType} · {bin.forecast.hours}h to overflow</span></div><div className="fill-meter"><div><span>{bin.fill}% full</span><span>{bin.priority}</span></div><i><b className={bin.priority.toLowerCase()} style={{ width: `${bin.fill}%` }} /></i></div><ChevronRight size={16} className="row-arrow" /></div>)}</div></div><div className="panel agent-card"><div className="panel-heading"><div><span className="eyebrow">AGENT ACTIVITY</span><h2>Decision trail</h2></div><span className="live-label"><span />LIVE</span></div><div className="trail">{run?.decisions?.length ? run.decisions.map((event, index) => <div className="trail-item" key={`${event.type}-${index}`}><div className={`trail-dot ${index === 0 ? 'current' : ''}`} />{index < run.decisions.length - 1 && <i className="trail-line" />}<div><strong>{event.type} <span>· {event.subject}</span></strong><p>{event.reason}</p><small>{index === 0 ? 'just now' : `${index * 4 + 3} min ago`}</small></div></div>) : <div className="empty-popover">No verified agent run recorded yet.</div>}</div><button className="panel-footer-button">Open AI Command Center <ChevronRight size={15} /></button></div></section>
    <section className="panel tasks-panel"><div className="panel-heading"><div><span className="eyebrow">OPERATIONS QUEUE</span><h2>Collection tasks</h2></div><button className="text-button">Manage tasks <ChevronRight size={15} /></button></div><div className="task-table"><div className="task-head"><span>TASK</span><span>PRIORITY</span><span>ROUTE</span><span>STATUS</span><span /></div>{tasks.slice(0, 3).map((task, index) => <div className="task-row" key={`${task.id}-${index}`}><strong>{task.id}<small>{task.source === 'AI' ? 'AI generated' : 'Manual'} · {task.driver}</small></strong><span className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</span><span className="route-cell"><Route size={14} />{task.bins.join(' → ')}</span><span className={`task-status ${task.status.toLowerCase()}`}><span />{task.status.replace('_', ' ')}</span><ChevronRight size={16} /></div>)}</div></section>
  </div>;
}

function SectionView({ section, dashboard, tasks, vehicles, workspace, run, runAgent, runCommand, agentMode, agentState, canOptimize, operator, sessionUser, updateTask, createTask, incidentForm, setIncidentForm, incidentStatus, saveIncident, role, onNavigate, notifications, onReadNotification }) {
  if (section === 'Report an Issue') return <div className="page"><PublicReportForm onBack={report => onNavigate(report ? 'My Reports' : role === 'CITIZEN' ? 'Home' : 'Overview')} /></div>;
  if (section === 'My Reports') return <CitizenReportsView />;
  if (['CITIZEN', 'VIEWER'].includes(role)) {
    if (section === 'Notifications') return <CitizenNotificationsView />;
    if (section === 'Profile') return <div className="page"><div className="panel"><span className="eyebrow">PROFILE</span><h2>{sessionUser.name}</h2><p>{sessionUser.email}</p></div></div>;
  }
  if (section === 'Bin Monitoring') return <>{role === 'ADMIN' && <SimulatorControls />}<LiveSensorTable bins={dashboard.bins} /><BinMonitoring dashboard={dashboard} workspace={workspace} />{role === 'ADMIN' && <BinAdminControls bins={dashboard.bins} />}</>;
  if (section === 'Collection Tasks') return <CollectionTasks tasks={tasks} operator={operator} admin={role === 'ADMIN'} sessionUser={sessionUser} updateTask={updateTask} createTask={createTask} />;
  if (section === 'Routes' || section === 'My Routes') return <RoutesView admin={role === 'ADMIN'} operator={operator} />;
  if (section === 'Locations') return <LocationsView />;
  if (section === 'Fleet') return <>{<FleetView vehicles={vehicles} admin={role === 'ADMIN'} />} {role === 'ADMIN' && <VehicleAdminControls />}</>;
  if (section === 'Drivers') return <DriversView admin={role === 'ADMIN'} />;
  if (section === 'Agents') return <AgentsView />;
  if (section === 'Map') return <MapView dashboard={dashboard} vehicles={vehicles} tasks={tasks} workspace={workspace} />;
  if (section === 'Analytics') return <DynamicAnalyticsView dashboard={dashboard} />;
  if (section === 'Users') return <UsersView />;
  if (section === 'Alerts') return <AlertsView role={role} />;
  if (section === 'Reports' || section === 'Public Reports') return <ReportsView />;
  if (section === 'Agent Activity') return <AgentsView />;
  if (section === 'Fleet Status') return <FleetView vehicles={vehicles} admin={false} />;
  if (section === 'Notifications') return role === 'VIEWER' ? <CitizenNotificationsView /> : <NotificationPage notifications={notifications} onRead={onReadNotification} />;
  if (section === 'Audit Logs') return <AuditView />;
  if (section === 'Settings') return <SettingsView admin={role === 'ADMIN'} />;

  function UsersView() {
    const [users, setUsers] = useState([]);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('');
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [newUser, setNewUser] = useState({ name: '', email: '', phone: '', role: 'OPERATOR', password: '' });
    const loadUsers = async () => { setLoadingUsers(true); try { setUsers(await fetchJson('/users')); setStatus(''); } catch (error) { setStatus(error.message); } finally { setLoadingUsers(false); } };
    useEffect(() => { loadUsers(); }, []);
    const toggle = async user => { try { await fetchJson(`/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ status: user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }) }); await loadUsers(); } catch (error) { setStatus(error.message); } };
    const remove = async user => { if (!window.confirm(`Delete ${user.name}?`)) return; try { await fetchJson(`/users/${user.id}`, { method: 'DELETE' }); await loadUsers(); } catch (error) { setStatus(error.message); } };
    const changeRole = async (user, role) => { try { await fetchJson(`/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role }) }); await loadUsers(); } catch (error) { setStatus(error.message); } };
    const addUser = async event => { event.preventDefault(); try { await fetchJson('/users', { method: 'POST', body: JSON.stringify(newUser) }); setNewUser({ name: '', email: '', phone: '', role: 'OPERATOR', password: '' }); setStatus('User created successfully.'); await loadUsers(); } catch (error) { setStatus(error.message); } };
    const visible = users.filter(user => `${user.name} ${user.email}`.toLowerCase().includes(query.toLowerCase()));
    return <div className="page"><div className="page-heading"><div><span className="eyebrow">ADMINISTRATION</span><h1>Users<span className="heading-period">.</span></h1><p>Manage access, roles, and account status.</p></div></div><div className="panel" style={{ marginBottom: 20 }}><div className="panel-heading"><div><span className="eyebrow">ADD ACCOUNT</span><h2>Create user</h2></div></div><form className="incident-form" onSubmit={addUser}><label>Name<input value={newUser.name} onChange={event => setNewUser(current => ({ ...current, name: event.target.value }))} required /></label><label>Email<input type="email" value={newUser.email} onChange={event => setNewUser(current => ({ ...current, email: event.target.value }))} required /></label><label>Phone<input value={newUser.phone} onChange={event => setNewUser(current => ({ ...current, phone: event.target.value }))} /></label><label>Role<select value={newUser.role} onChange={event => setNewUser(current => ({ ...current, role: event.target.value }))}><option value="OPERATOR">OPERATOR</option><option value="VIEWER">VIEWER</option><option value="ADMIN">ADMIN</option></select></label><label>Temporary password<input type="password" minLength="6" value={newUser.password} onChange={event => setNewUser(current => ({ ...current, password: event.target.value }))} required /></label><button className="primary-button" type="submit">Add user</button></form></div><div className="panel tasks-panel"><div className="panel-heading"><div><span className="eyebrow">USER DIRECTORY</span><h2>{users.length} accounts</h2></div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search users" aria-label="Search users" /></div>{status && <div className="login-error">{status}</div>}{loadingUsers ? <div className="empty-popover">Loading users...</div> : <div className="task-table"><div className="task-head"><span>USER</span><span>ROLE</span><span>STATUS</span><span>LAST LOGIN</span><span>ACTIONS</span></div>{visible.map(user => <div className="task-row full-task-row" key={user.id}><strong>{user.name}<small>{user.email} · {user.phone}</small></strong><select value={user.role} onChange={event => changeRole(user, event.target.value)}><option value="ADMIN">ADMIN</option><option value="OPERATOR">OPERATOR</option><option value="VIEWER">VIEWER</option></select><span className={`task-status ${user.status.toLowerCase()}`}><span />{user.status}</span><span>{user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never'}</span><button className="secondary-button" onClick={() => toggle(user)}>{user.status === 'ACTIVE' ? 'Disable' : 'Activate'}</button><button className="secondary-button" onClick={() => remove(user)}>Delete</button></div>)}</div>}</div></div>;
  }
  function AlertsView({ role }) {
    const [alerts, setAlerts] = useState([]);
    const [error, setError] = useState('');
    const loadAlerts = async () => { try { setAlerts(await fetchJson('/alerts')); } catch (err) { setError(err.message); } };
    useEffect(() => { loadAlerts(); }, []);
    const update = async (id, status) => { try { await fetchJson(`/alerts/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadAlerts(); } catch (err) { setError(err.message); } };
    return <div className="page"><div className="page-heading"><div><span className="eyebrow">OPERATIONAL SIGNALS</span><h1>Alerts<span className="heading-period">.</span></h1><p>{role === 'ADMIN' ? 'Review and resolve all operational alerts.' : role === 'OPERATOR' ? 'Acknowledge alerts relevant to your assigned work.' : 'Read-only operational alerts and incidents.'}</p></div></div>{error && <div className="error-banner"><AlertTriangle size={17} />{error}</div>}<IncidentPanel incidents={alerts} />{alerts.map(alert => <div className="alert-actions" key={alert.id}><strong>{alert.id}</strong><span>{alert.status}</span>{role !== 'VIEWER' && alert.status !== 'RESOLVED' && <><button className="secondary-button" onClick={() => update(alert.id, role === 'ADMIN' ? 'RESOLVED' : 'ACKNOWLEDGED')}>{role === 'ADMIN' ? 'Resolve' : 'Acknowledge'}</button></>}</div>)}</div>;
  }
  function ReportsView() {
    const [reports, setReports] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
      const load = async () => {
        try {
          setLoading(true);
          const response = await fetchJson('/public-reports');
          setReports(response.data || []);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      };
      load();
    }, []);

    if (error) return <AccessDenied />;
    if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading reports...</span></div>;

    const openReports = reports.filter(report => !['RESOLVED', 'CLOSED'].includes(report.status || 'OPEN')).length;
    const checkins = reports.filter(report => report.source === 'CITIZEN').length;

    return (
      <div className="page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">REPORTING</span>
            <h1>Public reports<span className="heading-period">.</span></h1>
            <p>Citizen-submitted observations and operational follow-up from the Hyderabad network.</p>
          </div>
        </div>

        <section className="metric-grid">
          {[
            ['Open reports', openReports],
            ['Citizen submissions', checkins],
            ['Total photos', reports.filter(report => report.photo).length],
            ['Resolved', reports.filter(report => report.status === 'RESOLVED').length]
          ].map(([label, value]) => (
            <div className="metric-card" key={label}>
              <span className="metric-label">{label}</span>
              <strong className="metric-value">{value}</strong>
            </div>
          ))}
        </section>

        <div className="analytics-grid">
          <div className="panel analytics-chart">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">PUBLIC SIGNALS</span>
                <h2>Report queue</h2>
              </div>
            </div>
            <div className="task-table">
              {reports.length ? reports.slice(0, 8).map(report => (
                <div className="task-row full-task-row" key={report.id}>
                  <strong>{report.id}<small>{report.location || 'Unknown location'}</small></strong>
                  <span className={`priority ${String(report.severity || 'MEDIUM').toLowerCase()}`}>{report.severity || 'MEDIUM'}</span>
                  <span className="route-cell">
                    <Radio size={14} />{report.issueType || report.type || 'Waste concern'}
                    <small>{report.description || 'No additional details provided.'}</small>
                  </span>
                  <span className={`task-status ${(report.status || 'OPEN').toLowerCase()}`}><span />{report.status || 'OPEN'}</span>
                  <span className="route-cell"><small>{report.currentAction || 'Awaiting agent'}</small>{report.resolvedAt ? `Resolved ${new Date(report.resolvedAt).toLocaleTimeString()}` : report.taskId ? `Task ${report.taskId}` : 'No task assigned'}</span>
                  {report.photo ? (
                    <img src={report.photo} alt="Citizen report evidence" style={{ maxWidth: 120, height: 70, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(19, 51, 43, 0.12)' }} />
                  ) : (
                    <div className="empty-popover" style={{ width: 120 }}>No photo</div>
                  )}
                </div>
              )) : (
                <div className="empty-popover">No public reports have been submitted.</div>
              )}
            </div>
          </div>

          <div className="panel impact-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">RESPONSE SUMMARY</span>
                <h2>Latest citizen insight</h2>
              </div>
            </div>
            {reports[0] ? (
              <>
                <div className="impact-row">
                  <strong>{reports[0].issueType || 'Overflow concern'}</strong>
                  <span>Most recent report<br /><small>{reports[0].location || 'Hyderabad'}</small></span>
                </div>
                <div className="impact-row">
                  <strong>{reports[0].source || 'CITIZEN'}</strong>
                  <span>Source<br /><small>{reports[0].timestamp ? new Date(reports[0].timestamp).toLocaleString() : 'Live intake'}</small></span>
                </div>
                <div className="impact-row">
                  <strong>{reports[0].linkedBinId || 'Unlinked'}</strong>
                  <span>Linked bin<br /><small>{reports[0].confidence ? `${Math.round(reports[0].confidence * 100)}% confidence` : 'Needs operator review'}</small></span>
                </div>
              </>
            ) : (
              <div className="empty-popover">No live public reports yet.</div>
            )}
          </div>
        </div>
      </div>
    );
  }
  function AuditView() {
    const [logs, setLogs] = useState([]); const [query, setQuery] = useState(''); const [roleFilter, setRoleFilter] = useState('ALL'); const [error, setError] = useState('');
    useEffect(() => { fetchJson('/audit-logs').then(setLogs).catch(err => setError(err.message)); }, []);
    const visible = logs.filter(log => roleFilter === 'ALL' || log.role === roleFilter).filter(log => `${log.action} ${log.user} ${log.resource} ${log.resourceId}`.toLowerCase().includes(query.toLowerCase()));
    return <div className="page"><div className="page-heading"><div><span className="eyebrow">GOVERNANCE</span><h1>Audit logs<span className="heading-period">.</span></h1><p>Searchable, append-only traceability for operational actions.</p></div></div>{error ? <div className="error-banner"><AlertTriangle size={17} />{error}</div> : <div className="panel tasks-panel"><div className="panel-heading"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search audit logs" aria-label="Search audit logs" /><select value={roleFilter} onChange={event => setRoleFilter(event.target.value)}><option>ALL</option><option>ADMIN</option><option>OPERATOR</option><option>VIEWER</option></select></div><div className="task-table">{visible.length ? visible.map(log => <div className="task-row full-task-row" key={log.id}><strong>{log.action}<small>{log.user || 'System'} · {log.role || 'ENGINE'}</small></strong><span>{log.resource}</span><span>{log.resourceId}</span><span>{new Date(log.timestamp).toLocaleString()}</span></div>) : <div className="empty-popover">No matching activity recorded.</div>}</div></div>}</div>;
  }
  function SettingsView({ admin }) {
    const [settings, setSettings] = useState(null);
    const [message, setMessage] = useState('');
    useEffect(() => { fetchJson('/settings').then(setSettings).catch(error => setMessage(error.message)); }, []);
    const save = async event => { event.preventDefault(); try { const saved = await fetchJson('/settings', { method: 'PATCH', body: JSON.stringify({ ...settings, overflowThreshold: Number(settings.overflowThreshold), vehicleLoadWarning: Number(settings.vehicleLoadWarning), mapZoom: Number(settings.mapZoom) }) }); setSettings(saved); setMessage('Settings saved and audit recorded.'); } catch (error) { setMessage(error.message); } };
    const reset = async () => { if (!window.confirm('Reset operational settings to defaults?')) return; try { setSettings(await fetchJson('/settings/reset', { method: 'POST' })); setMessage('Settings reset to defaults.'); } catch (error) { setMessage(error.message); } };
    if (!settings) return <div className="loading-screen"><div className="spinner" /><span>Loading system settings...</span></div>;
    return <div className="page"><div className="page-heading"><div><span className="eyebrow">SYSTEM CONTROL</span><h1>Settings<span className="heading-period">.</span></h1><p>{admin ? 'Configure operational thresholds and notifications.' : 'Read-only operational configuration for Hyderabad.'}</p></div><span className={`role-badge ${admin ? 'admin' : 'viewer'}`}>{admin ? 'ADMIN EDITOR' : 'READ ONLY'}</span></div>{message && <div className="task-success">{message}</div>}<form className="panel settings-list" onSubmit={save}><div className="panel-heading"><div><span className="eyebrow">GENERAL</span><h2>{settings.organizationName}</h2></div></div><label className="settings-field"><span>Organization name</span><input disabled={!admin} value={settings.organizationName} onChange={event => setSettings(current => ({ ...current, organizationName: event.target.value }))} /></label><label className="settings-field"><span>Operating city</span><input disabled value={settings.operatingCity} /></label><label className="settings-field"><span>Overflow threshold (%)</span><input disabled={!admin} type="number" min="1" max="100" value={settings.overflowThreshold} onChange={event => setSettings(current => ({ ...current, overflowThreshold: event.target.value }))} /></label><label className="settings-field"><span>Vehicle load warning (%)</span><input disabled={!admin} type="number" min="1" max="100" value={settings.vehicleLoadWarning} onChange={event => setSettings(current => ({ ...current, vehicleLoadWarning: event.target.value }))} /></label><label className="settings-field"><span>Critical alerts</span><input disabled={!admin} type="checkbox" checked={settings.criticalAlerts} onChange={event => setSettings(current => ({ ...current, criticalAlerts: event.target.checked }))} /></label><label className="settings-field"><span>Vehicle alerts</span><input disabled={!admin} type="checkbox" checked={settings.vehicleAlerts} onChange={event => setSettings(current => ({ ...current, vehicleAlerts: event.target.checked }))} /></label><label className="settings-field"><span>Task alerts</span><input disabled={!admin} type="checkbox" checked={settings.taskAlerts} onChange={event => setSettings(current => ({ ...current, taskAlerts: event.target.checked }))} /></label><div><strong>System</strong><p>Backend connected · In-memory demo persistence · Version {settings.version}</p></div>{admin && <div className="route-actions"><button className="primary-button" type="submit">Save settings</button><button className="secondary-button" type="button" onClick={reset}>Reset defaults</button></div>}</form></div>;
  }
  if (section === 'AI Command Center') return <AICommandCenterView dashboard={dashboard} run={run} runAgent={runAgent} runCommand={runCommand} agentMode={agentMode} agentState={agentState} incidents={dashboard?.incidents || []} incidentForm={incidentForm} setIncidentForm={setIncidentForm} incidentStatus={incidentStatus} saveIncident={saveIncident} />;
  const title = section === 'AI Command Center' ? 'AI command center' : section;
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">ECOSYSTEM CONTROL</span><h1>{title}<span className="heading-period">.</span></h1><p>Live operational data and verified actions from the EcoFlow platform.</p></div>{section === 'AI Command Center' && <button className="primary-button" onClick={runAgent}><Bot size={17} />Run analysis now</button>}</div>{section === 'AI Command Center' ? <div className="command-layout"><div className="command-status"><div className="online-orb"><Bot size={31} /></div><span className="status-kicker">AGENT STATUS</span><h2>Online and observing</h2><p>Local rule engine is monitoring {dashboard.metrics.totalBins} bins and {dashboard.metrics.availableVehicles} available vehicles.</p><div className="status-pills"><span><CheckCircle2 size={14} />Observe</span><span><CheckCircle2 size={14} />Predict</span><span><CheckCircle2 size={14} />Plan</span></div></div><div className="panel explain-panel"><div className="panel-heading"><div><span className="eyebrow">CLOSED-LOOP TRACE</span><h2>Latest reasoning</h2></div><span className="live-label"><span />VERIFIED</span></div>{(run?.actions || [{ type: 'PREDICT_OVERFLOW', status: 'SUCCESS', result: 'B-102 · 1h 42m' }, { type: 'CREATE_COLLECTION_TASK', status: 'SUCCESS', result: 'CT-1048 · V-02 assigned' }, { type: 'NOTIFY_OPERATOR', status: 'SUCCESS', result: 'Operator notification sent' }]).map((action, index) => <div className="action-step" key={action.type}><div className="step-number">0{index + 1}</div><div><strong>{action.type.replaceAll('_', ' ')}</strong><p>{action.result || action.status}</p></div><CheckCircle2 size={18} className="success-icon" /></div>)}</div></div> : <div className="section-placeholder"><div className="placeholder-icon"><Map size={24} /></div><h2>{section} is connected to live operations</h2><p>{section === 'Bin Monitoring' ? `${dashboard.bins.length} sensor-connected bins are reporting. ${dashboard.metrics.criticalBins} are critical.` : `${tasks.length} tasks and the current fleet state are available through the operations API.`}</p><button className="secondary-button" onClick={section === 'Bin Monitoring' ? () => window.location.reload() : runAgent}><Activity size={16} />Refresh live data</button></div>}</div>;
}

function IncidentPanel({ incidents }) {
  return <div className="panel explain-panel">
    <div className="panel-heading"><div><span className="eyebrow">INCIDENT REPORTS</span><h2>Waste issues</h2></div></div>
    <div className="task-table">{incidents.length ? incidents.map((incident) => (
      <div key={incident.id} className="task-row full-task-row">
        <strong>{incident.id}<small>{incident.location}</small></strong>
        <span className={`priority ${incident.severity?.toLowerCase() || 'medium'}`}>{incident.severity || 'MEDIUM'}</span>
        <span className="route-cell"><Radio size={14} />{incident.wasteType}<small>{incident.description}</small></span>
        <span className={`task-status ${incident.status?.toLowerCase() || 'open'}`}><span />{incident.status || 'OPEN'}</span>
      </div>
    )) : <div className="empty-popover">No waste incidents reported.</div>}</div>
  </div>;
}

function parseActionResult(action) {
  if (!action) return {};
  if (typeof action.result === 'object') return action.result;
  try { return JSON.parse(action.result); } catch (_) { return {}; }
}

function OperationCard({ run, dashboard, compact = false }) {
  const actions = run?.actions || [];
  const created = actions.find(action => action.taskId || action.type === 'CREATE_COLLECTION_TASK');
  const details = parseActionResult(created);
  const urgentBins = (dashboard?.bins || []).filter(bin => ['CRITICAL', 'HIGH'].includes(bin.priority)).slice(0, 5);
  const phases = ['OBSERVE', 'ANALYZE', 'DECIDE', 'ACT', 'MONITOR', 'VERIFY'];
  const completedPhase = run?.loading ? -1 : run?.state === 'COMPLETED' ? phases.length - 1 : Math.max(0, actions.length ? 3 : 0);
  if (run?.error) return <div className="operation-card operation-error"><AlertTriangle size={16} /><div><strong>Agent could not complete the operation</strong><p>{run.error}</p></div></div>;
  if (run?.loading) return <div className="operation-card operation-thinking"><div className="thinking-dots"><i /><i /><i /></div><div><strong>Agent is thinking</strong><p>Reading Hyderabad bins, fleet capacity, drivers, and active tasks...</p></div></div>;
  if (!run?.decisions?.length && !actions.length) return null;
  return <div className={`operation-card ${compact ? 'operation-card-compact' : ''}`}><div className="operation-card-head"><div><span className="eyebrow">BACKEND AGENT RUN</span><h3>{run.answer || 'Hyderabad operations assessed.'}</h3></div><span className="operation-status"><span />{run.state || 'COMPLETED'}</span></div>{!compact && <div className="operation-grid"><div><small>URGENT BINS</small><strong>{urgentBins.length ? urgentBins.map(bin => bin.id).join(', ') : 'None detected'}</strong></div><div><small>VEHICLE / DRIVER</small><strong>{details.vehicleId || 'No assignment'}{details.driver ? ` · ${details.driver}` : ''}</strong></div><div><small>ROUTE / BINS</small><strong>{details.route?.join(' → ') || details.bins?.join(', ') || 'Monitoring only'}</strong></div><div><small>TASK CREATED</small><strong>{details.taskId || 'No task created'}</strong></div></div>}{run.replanned?.length > 0 && <div className="operation-replan"><Route size={15} />Re-planned {run.replanned.join(', ')} after conditions changed.</div>}<details className="operation-timeline" open={!compact}><summary>Tool activity timeline</summary><div className="phase-track">{phases.map((phase, index) => <span className={index <= completedPhase ? 'complete' : ''} key={phase}><i />{phase}</span>)}</div>{actions.map((action, index) => <div className="operation-action" key={`${action.type}-${index}`}><CheckCircle2 size={15} /><div><strong>{String(action.type || 'ACTION').replaceAll('_', ' ')}</strong><span>{typeof action.result === 'string' ? action.result : action.status || 'Recorded'}</span></div></div>)}</details>{!compact && run.state === 'COMPLETED' && <div className="operation-verification"><CheckCircle2 size={15} />Backend state completed and recorded in agent history.</div>}</div>;
}

function QuickCommands({ onCommand, disabled }) {
  const commands = ['Run autonomous optimization', 'Show urgent bins', "Optimize today's routes", 'Show active tasks', 'Explain current fleet status'];
  return <div className="quick-commands"><span className="eyebrow">QUICK COMMANDS</span><div>{commands.map(command => <button key={command} disabled={disabled} onClick={() => onCommand(command)}><Bot size={14} />{command}</button>)}</div></div>;
}

function AICommandCenterView({ dashboard, run, runAgent, runCommand, agentMode, agentState, incidents, incidentForm, setIncidentForm, incidentStatus, saveIncident }) {
  const isWorking = run?.loading;
  const status = run?.error ? 'ERROR' : agentState || run?.agentStatus || run?.state || 'OFFLINE';
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">ECOSYSTEM CONTROL · HYDERABAD</span><h1>AI command center<span className="heading-period">.</span></h1><p>Live autonomous waste operations with verified backend actions.</p></div><button className="primary-button" onClick={runAgent} disabled={isWorking}><Bot size={17} />{isWorking ? 'Agent working...' : 'Run autonomous optimization'}</button></div><QuickCommands onCommand={runCommand} disabled={isWorking} /><div className="command-layout"><div className={`command-status command-status-${status.toLowerCase()}`}><div className="online-orb"><Bot size={31} /></div><span className="status-kicker">AGENT STATUS</span><h2>{status}</h2><p>{isWorking ? 'Analyzing live Hyderabad operations...' : `Monitoring ${dashboard.metrics.totalBins} bins, ${dashboard.metrics.availableVehicles} available vehicles, and active collection tasks.`}</p><div className="status-pills"><span><CheckCircle2 size={14} />Observe</span><span><CheckCircle2 size={14} />Analyze</span><span><CheckCircle2 size={14} />Decide</span><span><CheckCircle2 size={14} />Verify</span></div></div><OperationCard run={run} dashboard={dashboard} /></div></div>;
}

function AICommandCenter({ dashboard, run, runAgent, agentMode, incidents, incidentForm, setIncidentForm, incidentStatus, saveIncident }) {
  const modeLabel = agentMode === 'LLM' ? 'OpenAI LLM' : 'local rule engine';
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">ECOSYSTEM CONTROL</span><h1>AI command center<span className="heading-period">.</span></h1><p>Verified actions, live risk monitoring, and incident intake from the local operations engine.</p></div><button className="primary-button" onClick={runAgent}><Bot size={17} />Run analysis now</button></div><div className="command-layout"><div className="command-status"><div className="online-orb"><Bot size={31} /></div><span className="status-kicker">AGENT STATUS</span><h2>Online and observing</h2><p>Local rule engine is monitoring {dashboard.metrics.totalBins} bins and {dashboard.metrics.availableVehicles} available vehicles.</p><div className="status-pills"><span><CheckCircle2 size={14} />Observe</span><span><CheckCircle2 size={14} />Predict</span><span><CheckCircle2 size={14} />Plan</span></div></div><div className="panel explain-panel"><div className="panel-heading"><div><span className="eyebrow">CLOSED-LOOP TRACE</span><h2>Latest reasoning</h2></div><span className="live-label"><span />VERIFIED</span></div>{(run?.actions || [{ type: 'PREDICT_OVERFLOW', status: 'SUCCESS', result: 'B-102 · 1h 42m' }, { type: 'CREATE_COLLECTION_TASK', status: 'SUCCESS', result: 'CT-1048 · V-02 assigned' }, { type: 'NOTIFY_OPERATOR', status: 'SUCCESS', result: 'Operator notification sent' }]).map((action, index) => <div className="action-step" key={`${action.type}-${index}`}><div className="step-number">0{index + 1}</div><div><strong>{action.type.replaceAll('_', ' ')}</strong><p>{action.result || action.status}</p></div><CheckCircle2 size={18} className="success-icon" /></div>)}</div></div><div className="panel" style={{ marginTop: 20 }}><div className="panel-heading"><div><span className="eyebrow">INCIDENT REPORT</span><h2>Submit waste issue</h2></div></div><form className="incident-form" onSubmit={saveIncident}><label>Location<input value={incidentForm.location} onChange={event => setIncidentForm(current => ({ ...current, location: event.target.value }))} placeholder="Main Gate" required /></label><label>Waste type<select value={incidentForm.wasteType} onChange={event => setIncidentForm(current => ({ ...current, wasteType: event.target.value }))}><option value="Organic">Organic</option><option value="Plastic">Plastic</option><option value="Paper">Paper</option><option value="Glass">Glass</option><option value="Metal">Metal</option><option value="Mixed">Mixed</option></select></label><label>Severity<select value={incidentForm.severity} onChange={event => setIncidentForm(current => ({ ...current, severity: event.target.value }))}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="CRITICAL">Critical</option></select></label><label>Description<textarea rows="4" value={incidentForm.description} onChange={event => setIncidentForm(current => ({ ...current, description: event.target.value }))} placeholder="Describe the issue and whether it blocks access or requires urgent collection" required /></label>{incidentStatus.message && <div className={incidentStatus.type === 'error' ? 'login-error' : 'task-success'}>{incidentStatus.message}</div>}<button className="primary-button" type="submit" disabled={incidentStatus.type === 'loading'}>{incidentStatus.type === 'loading' ? 'Submitting...' : 'Submit incident'}</button></form></div><IncidentPanel incidents={incidents} /></div>;
}

function MapView({ dashboard, vehicles, tasks, workspace }) {
  const bins = dashboard.bins || [];
  const city = CITY_CONFIG[workspace] || CITY_CONFIG['Hyderabad Operations'];
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layersRef = useRef(null);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return undefined;
    const map = L.map(container, { zoomControl: true }).setView([city.latitude, city.longitude], city.zoom);
    mapInstanceRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    layersRef.current = L.layerGroup().addTo(map);
    const resizeMap = () => map.invalidateSize({ pan: false });
    const resizeFrame = requestAnimationFrame(resizeMap);
    const resizeTimer = window.setTimeout(resizeMap, 120);
    window.addEventListener('resize', resizeMap);
    return () => {
      cancelAnimationFrame(resizeFrame);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', resizeMap);
      layersRef.current?.clearLayers();
      layersRef.current = null;
      map.remove();
      if (mapInstanceRef.current === map) mapInstanceRef.current = null;
    };
  }, [workspace]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return undefined;
    layers.clearLayers();
    const colorFor = bin => bin.priority === 'CRITICAL' ? '#d64545' : bin.priority === 'HIGH' ? '#ef8d32' : bin.priority === 'MEDIUM' ? '#e3b341' : '#238b68';
    bins.forEach(bin => L.circleMarker([bin.latitude, bin.longitude], { radius: 8, color: '#fff', weight: 2, fillColor: colorFor(bin), fillOpacity: 0.9 }).bindPopup(`<strong>${bin.id}</strong><br>${bin.area || bin.location}, ${city.name}<br>Fill: ${bin.fill}%<br>Status: ${bin.status}`).addTo(layers));
    vehicles.filter(item => item.status !== 'MAINTENANCE').forEach((vehicle, index) => { const bin = bins[index % Math.max(bins.length, 1)]; if (bin) L.circleMarker([bin.latitude + 0.005, bin.longitude + 0.005], { radius: 7, color: '#1f6fb2', fillColor: '#4ca3df', fillOpacity: 1 }).bindPopup(`<strong>${vehicle.id}</strong><br>${city.name} operating area: ${vehicle.location}<br>Status: ${vehicle.status}<br>Driver: ${vehicle.driver || 'Unassigned'}<br>Load: ${vehicle.currentLoad} / ${vehicle.capacity} kg`).addTo(layers); });
    tasks.filter(task => !['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(task.status)).slice(0, 3).forEach((task, index) => { const points = task.bins.map(id => bins.find(bin => bin.id === id)).filter(Boolean).map(bin => [bin.latitude, bin.longitude]); if (points.length > 1) L.polyline(points, { color: ['#168a77', '#d77659', '#7a6fb2'][index], weight: 4, opacity: 0.8 }).addTo(layers).bindPopup(`${task.id} · ${task.status}`); });
    map.invalidateSize({ pan: false });
  }, [bins, vehicles, tasks, workspace, city.name]);

  const [search, setSearch] = useState('');
  const mapSearch = event => { event.preventDefault(); const match = bins.find(bin => `${bin.area} ${bin.location}`.toLowerCase().includes(search.toLowerCase())); if (match && mapInstanceRef.current) mapInstanceRef.current.setView([match.latitude, match.longitude], 14); };
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">LIVE {city.name.toUpperCase()} OPERATIONS</span><h1>{city.name} collection map<span className="heading-period">.</span></h1><p>OpenStreetMap view of {city.name} bins, simulated vehicle positions, and active collection routes.</p></div></div><div className="panel" style={{ padding: 20 }}><form className="incident-form" onSubmit={mapSearch}><label>Search {city.name} area<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search a location" /></label><button className="primary-button" type="submit">Center map</button></form><div ref={mapContainerRef} className="map-container" /></div></div>;
}

function RoutesView({ admin, operator }) {
  const [routes, setRoutes] = useState([]);
  const [users, setUsers] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [message, setMessage] = useState('');
  const [editingRoute, setEditingRoute] = useState(null);
  const [form, setForm] = useState({ name: '', bins: '', operatorId: '', vehicleId: '' });
  const load = async () => { try { setRoutes(await fetchJson('/routes')); if (admin) { const [directory, fleet] = await Promise.all([fetchJson('/users'), fetchJson('/vehicles')]); setUsers(directory.filter(user => user.role === 'OPERATOR' && user.status === 'ACTIVE')); setVehicles(fleet); } } catch (error) { setMessage(error.message); } };
  useEffect(() => { load(); }, []);
  const updateStatus = async (route, status) => { try { await fetchJson(`/routes/${route.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (error) { setMessage(error.message); } };
  const saveRoute = async event => { event.preventDefault(); try { const payload = { name: form.name, bins: form.bins.split(',').map(value => value.trim()).filter(Boolean), operatorId: form.operatorId || null, vehicleId: form.vehicleId || null }; await fetchJson(editingRoute ? `/routes/${editingRoute.id}` : '/routes', { method: editingRoute ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); setForm({ name: '', bins: '', operatorId: '', vehicleId: '' }); setEditingRoute(null); setMessage(editingRoute ? 'Route updated.' : 'Route created.'); await load(); } catch (error) { setMessage(error.message); } };
  const editRoute = route => { setEditingRoute(route); setForm({ name: route.name, bins: route.bins.join(', '), operatorId: route.operatorId || '', vehicleId: route.vehicleId || '' }); };
  const remove = async route => { if (!window.confirm(`Delete ${route.id}?`)) return; try { await fetchJson(`/routes/${route.id}`, { method: 'DELETE' }); await load(); } catch (error) { setMessage(error.message); } };
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">HYDERABAD ROUTE CONTROL</span><h1>Collection routes<span className="heading-period">.</span></h1><p>{admin ? 'Create, assign, and monitor Hyderabad collection routes.' : 'View routes and operational progress for Hyderabad.'}</p></div></div>{admin && <div className="panel" style={{ marginBottom: 20 }}><div className="panel-heading"><div><span className="eyebrow">ADMIN ACTION</span><h2>{editingRoute ? 'Edit route' : 'Create route'}</h2></div></div><form className="incident-form" onSubmit={saveRoute}><label>Route name<input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} required /></label><label>Bin IDs<input value={form.bins} onChange={event => setForm(current => ({ ...current, bins: event.target.value }))} placeholder="HYG-001, HYG-002" required /></label><label>Operator<select value={form.operatorId} onChange={event => setForm(current => ({ ...current, operatorId: event.target.value }))}><option value="">Unassigned</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label>Vehicle<select value={form.vehicleId} onChange={event => setForm(current => ({ ...current, vehicleId: event.target.value }))}><option value="">Unassigned</option>{vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.id} · {vehicle.registration}</option>)}</select></label><button className="primary-button" type="submit">{editingRoute ? 'Save route' : 'Create route'}</button>{editingRoute && <button className="secondary-button" type="button" onClick={() => { setEditingRoute(null); setForm({ name: '', bins: '', operatorId: '', vehicleId: '' }); }}>Cancel</button>}</form></div>}{message && <div className="task-success">{message}</div>}<div className="panel tasks-panel"><div className="panel-heading"><div><span className="eyebrow">ROUTE BOARD</span><h2>{routes.length} routes</h2></div></div><div className="task-table"><div className="task-head"><span>ROUTE</span><span>STOPS</span><span>ASSIGNMENT</span><span>STATUS</span><span>ACTIONS</span></div>{routes.length ? routes.map(route => <div className="task-row full-task-row" key={route.id}><strong>{route.id}<small>{route.name}</small></strong><span className="route-cell"><Route size={14} />{route.stops?.join(' → ') || route.bins.join(' → ')}<small>{route.distance} km</small></span><span>{route.operatorId || 'Unassigned'}<small>{route.vehicleId || 'No vehicle'}</small></span><span className={`task-status ${route.status.toLowerCase()}`}><span />{route.status}</span><span className="route-actions">{admin && <button className="secondary-button" onClick={() => editRoute(route)}>Edit</button>}{route.status !== 'COMPLETED' && route.status !== 'CANCELLED' && <button className="secondary-button" onClick={() => updateStatus(route, operator ? 'IN_PROGRESS' : route.status === 'PLANNED' ? 'IN_PROGRESS' : 'COMPLETED')}>{operator ? 'Update' : route.status === 'PLANNED' ? 'Start' : 'Complete'}</button>}{admin && <button className="secondary-button" onClick={() => remove(route)}>Delete</button>}</span></div>) : <div className="empty-popover">No routes available.</div>}</div></div></div>;
}

function LocationsView() {
  const [locations, setLocations] = useState([]);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', area: '', latitude: '17.3850', longitude: '78.4867' });
  const load = async () => { try { setLocations(await fetchJson('/locations')); } catch (error) { setMessage(error.message); } };
  useEffect(() => { load(); }, []);
  const create = async event => { event.preventDefault(); try { await fetchJson('/locations', { method: 'POST', body: JSON.stringify({ ...form, latitude: Number(form.latitude), longitude: Number(form.longitude) }) }); setForm({ name: '', area: '', latitude: '17.3850', longitude: '78.4867' }); setMessage('Collection location added.'); await load(); } catch (error) { setMessage(error.message); } };
  const remove = async location => { if (!window.confirm(`Delete ${location.name}?`)) return; try { await fetchJson(`/locations/${location.id}`, { method: 'DELETE' }); await load(); } catch (error) { setMessage(error.message); } };
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">ADMINISTRATION</span><h1>Collection locations<span className="heading-period">.</span></h1><p>Maintain Hyderabad collection points used by bins and routes.</p></div></div><div className="panel" style={{ marginBottom: 20 }}><div className="panel-heading"><div><span className="eyebrow">ADMIN ACTION</span><h2>Add location</h2></div></div><form className="incident-form" onSubmit={create}><label>Name<input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} required /></label><label>Area<input value={form.area} onChange={event => setForm(current => ({ ...current, area: event.target.value }))} required /></label><label>Latitude<input type="number" step="any" value={form.latitude} onChange={event => setForm(current => ({ ...current, latitude: event.target.value }))} required /></label><label>Longitude<input type="number" step="any" value={form.longitude} onChange={event => setForm(current => ({ ...current, longitude: event.target.value }))} required /></label><button className="primary-button" type="submit">Add location</button></form></div>{message && <div className="task-success">{message}</div>}<div className="panel tasks-panel"><div className="panel-heading"><div><span className="eyebrow">LOCATION DIRECTORY</span><h2>{locations.length} Hyderabad locations</h2></div></div><div className="task-table">{locations.map(location => <div className="task-row full-task-row" key={location.id}><strong>{location.name}<small>{location.area}</small></strong><span>{location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}</span><span>{location.city}, {location.state}</span><button className="secondary-button" onClick={() => remove(location)}>Delete</button></div>)}</div></div></div>;
}

function BinAdminControls({ bins }) {
  const [selectedId, setSelectedId] = useState(bins[0]?.id || '');
  const [fill, setFill] = useState(bins[0]?.fill || 0);
  const [newBin, setNewBin] = useState({ id: '', location: '', wasteType: 'Mixed', capacity: 240, latitude: 17.3850, longitude: 78.4867 });
  const [status, setStatus] = useState('');
  const selected = bins.find(bin => bin.id === selectedId);
  const update = async event => { event.preventDefault(); try { await fetchJson(`/bins/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ fill: Number(fill) }) }); setStatus(`${selectedId} updated.`); } catch (error) { setStatus(error.message); } };
  const remove = async () => { if (!selected || !window.confirm(`Delete ${selected.id}?`)) return; try { await fetchJson(`/bins/${selected.id}`, { method: 'DELETE' }); setStatus(`${selected.id} deleted.`); } catch (error) { setStatus(error.message); } };
  const add = async event => { event.preventDefault(); try { await fetchJson('/bins', { method: 'POST', body: JSON.stringify({ ...newBin, capacity: Number(newBin.capacity), latitude: Number(newBin.latitude), longitude: Number(newBin.longitude) }) }); setStatus(`${newBin.id} created.`); setNewBin({ id: '', location: '', wasteType: 'Mixed', capacity: 240, latitude: 17.3850, longitude: 78.4867 }); } catch (error) { setStatus(error.message); } };
  return <div className="panel" style={{ marginTop: 20 }}><div className="panel-heading"><div><span className="eyebrow">ADMIN CONTROL</span><h2>Manage bins</h2></div></div><form className="incident-form" onSubmit={update}><label>Bin<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setFill(bins.find(bin => bin.id === event.target.value)?.fill || 0); }}>{bins.map(bin => <option key={bin.id} value={bin.id}>{bin.id} · {bin.location}</option>)}</select></label><label>Fill level (%)<input type="number" min="0" max="100" value={fill} onChange={event => setFill(event.target.value)} /></label><button className="primary-button" type="submit">Save bin</button><button className="secondary-button" type="button" onClick={remove}>Delete selected bin</button></form><form className="incident-form" onSubmit={add}><label>New bin ID<input value={newBin.id} onChange={event => setNewBin(current => ({ ...current, id: event.target.value }))} placeholder="B-130" required /></label><label>Location<input value={newBin.location} onChange={event => setNewBin(current => ({ ...current, location: event.target.value }))} required /></label><label>Waste type<select value={newBin.wasteType} onChange={event => setNewBin(current => ({ ...current, wasteType: event.target.value }))}><option>Mixed</option><option>Organic</option><option>Plastic</option><option>Paper</option></select></label><label>Capacity (L)<input type="number" min="1" value={newBin.capacity} onChange={event => setNewBin(current => ({ ...current, capacity: event.target.value }))} /></label><button className="primary-button" type="submit">Add bin</button></form>{status && <div className="task-success">{status}</div>}</div>;
}

function VehicleAdminControls() {
  const [form, setForm] = useState({ id: '', registration: '', capacity: 900, driver: '' });
  const [message, setMessage] = useState('');
  const submit = async event => { event.preventDefault(); try { await fetchJson('/vehicles', { method: 'POST', body: JSON.stringify({ ...form, capacity: Number(form.capacity) }) }); setForm({ id: '', registration: '', capacity: 900, driver: '' }); setMessage('Vehicle added.'); } catch (error) { setMessage(error.message); } };
  return <div className="panel" style={{ marginTop: 20 }}><div className="panel-heading"><div><span className="eyebrow">ADMIN CONTROL</span><h2>Add vehicle</h2></div></div><form className="incident-form" onSubmit={submit}><label>Vehicle ID<input value={form.id} onChange={event => setForm(current => ({ ...current, id: event.target.value }))} placeholder="V-07" required /></label><label>Registration<input value={form.registration} onChange={event => setForm(current => ({ ...current, registration: event.target.value }))} required /></label><label>Capacity (kg)<input type="number" min="1" value={form.capacity} onChange={event => setForm(current => ({ ...current, capacity: event.target.value }))} required /></label><label>Driver<input value={form.driver} onChange={event => setForm(current => ({ ...current, driver: event.target.value }))} required /></label><button className="primary-button" type="submit">Add vehicle</button></form>{message && <div className="task-success">{message}</div>}</div>;
}

function SimulatorControls() {
  const [status, setStatus] = useState({ enabled: false, running: false, scenario: 'NORMAL', intervalMs: 5000 });
  const [message, setMessage] = useState('');
  const loadStatus = async () => { try { setStatus(await fetchJson('/simulator/status')); setMessage(''); } catch (error) { setMessage(error.message); } };
  useEffect(() => { loadStatus(); }, []);
  const control = async (action, selectedScenario = status.scenario) => { try { setStatus(await fetchJson('/simulator/control', { method: 'POST', body: JSON.stringify({ action, scenario: selectedScenario }) })); setMessage(`Scenario set to ${selectedScenario}.`); } catch (error) { setMessage(error.message); } };
  return <section className="panel monitoring-panel" style={{ marginBottom: 18 }}><div className="panel-heading"><div><span className="eyebrow">SIMULATED ESP32 CONTROL</span><h2>Sensor simulator</h2></div><span className={status.running ? 'live-label' : 'date-filter'}><span />{status.running ? 'RUNNING' : 'STOPPED'}</span></div><div className="incident-form"><label>Demo scenario<select value={status.scenario} onChange={event => control(status.running ? 'start' : undefined, event.target.value)}><option>NORMAL</option><option>HIGH_FILL</option><option>RAPID_FILL</option><option>CRITICAL</option><option>SENSOR_FAILURE</option></select></label><span className="monitoring-health"><span />{status.enabled ? `POST /api/telemetry every ${status.intervalMs}ms` : 'Disabled in backend configuration'}</span><button className="primary-button" type="button" onClick={() => control(status.running ? 'stop' : 'start')}>{status.running ? 'Stop simulator' : 'Start simulator'}</button></div>{message && <div className="task-success">{message}</div>}</section>;
}

function LiveSensorTable({ bins }) {
  return <section className="panel monitoring-panel" style={{ marginBottom: 18 }}><div className="panel-heading"><div><span className="eyebrow">TELEMETRY STREAM</span><h2>Live sensor readings</h2></div><span className="live-label"><span />LIVE · SIMULATED</span></div><div style={{ overflowX: 'auto' }}><div className="monitor-table" style={{ minWidth: 920 }}><div className="monitor-head" style={{ gridTemplateColumns: '1fr .8fr .8fr .8fr 1.1fr .8fr 1fr' }}><span>BIN / SENSOR</span><span>FILL</span><span>WEIGHT</span><span>TEMP</span><span>LAST TELEMETRY</span><span>STATUS</span><span>DATA SOURCE</span></div>{bins.map(bin => <div className="monitor-row" style={{ gridTemplateColumns: '1fr .8fr .8fr .8fr 1.1fr .8fr 1fr' }} key={bin.id}><span className="monitor-bin"><strong>{bin.id}<small>{bin.sensorId || 'No sensor ID'}</small></strong></span><span>{bin.fill}%</span><span>{Number(bin.weightKg || 0).toFixed(1)} kg</span><span>{Number(bin.temperature || 0).toFixed(1)} C</span><span>{bin.lastTelemetryAt ? new Date(bin.lastTelemetryAt).toLocaleTimeString() : 'No reading'}</span><span>{bin.sensorStatus || 'UNKNOWN'}</span><span>{bin.dataSource || 'SIMULATED'}</span></div>)}</div></div></section>;
}

function BinMonitoring({ dashboard, workspace }) {
  const [filter, setFilter] = useState('ALL');
  const bins = dashboard.bins.filter(bin => filter === 'ALL' || bin.priority === filter);
  const counts = dashboard.bins.reduce((result, bin) => { result[bin.priority] = (result[bin.priority] || 0) + 1; return result; }, {});
  const sensorHealth = dashboard.bins.filter(bin => bin.sensorStatus === 'ONLINE').length;
  const dataSources = dashboard.bins.reduce((result, bin) => { const source = bin.dataSource || 'SIMULATED'; result[source] = (result[source] || 0) + 1; return result; }, {});
  const topRiskBins = [...dashboard.bins].sort((a, b) => (b.forecast?.predictedFill3h || b.fill) - (a.forecast?.predictedFill3h || a.fill)).slice(0, 4);
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">LIVE SENSOR NETWORK</span><h1>Bin monitoring<span className="heading-period">.</span></h1><p>{dashboard.bins.length} connected bins reporting across {workspace}.</p></div><div className="monitoring-health"><span />SENSORS ONLINE <strong>{sensorHealth}/{dashboard.bins.length}</strong></div></div><div className="monitor-summary">{[['ALL', 'All bins', dashboard.bins.length], ['CRITICAL', 'Critical', counts.CRITICAL || 0], ['HIGH', 'High priority', counts.HIGH || 0], ['MEDIUM', 'Watch list', counts.MEDIUM || 0]].map(([value, label, count]) => <button key={value} className={filter === value ? 'summary-filter selected' : 'summary-filter'} onClick={() => setFilter(value)}><span>{label}</span><strong>{count}</strong></button>)}</div><section className="metric-grid">{[['Data sources', Object.entries(dataSources).map(([source, value]) => `${source}: ${value}`).join(' · ') || 'No sources'], ['Sensor health', `${sensorHealth}/${dashboard.bins.length} online`], ['Avg fill', `${Math.round(dashboard.bins.reduce((sum, bin) => sum + bin.fill, 0) / Math.max(dashboard.bins.length, 1))}%`], ['Risk hits', dashboard.metrics.overflowPredictions]].map(([label, value]) => <div className="metric-card" key={label}><span className="metric-label">{label}</span><strong className="metric-value" style={{ fontSize: value.length > 18 ? 18 : 22 }}>{value}</strong></div>)}</section><div className="analytics-grid"><div className="panel analytics-chart"><div className="panel-heading"><div><span className="eyebrow">LIVE SENSOR PANEL</span><h2>Telemetry health</h2></div></div><div className="task-table">{topRiskBins.map(bin => <div className="task-row full-task-row" key={bin.id}><strong>{bin.id}<small>{bin.location}</small></strong><span className={`priority ${bin.priority.toLowerCase()}`}>{bin.priority}</span><span className="route-cell"><Radio size={14} />{bin.dataSource || 'SIMULATED'}<small>{bin.sensorId || 'No sensor id'} · {bin.sensorStatus || 'OFFLINE'}</small></span><span className="forecast-cell"><Clock3 size={14} />{bin.forecast?.hours || 'N/A'}h <small>forecast</small></span></div>)}</div></div><div className="panel impact-panel"><div className="panel-heading"><div><span className="eyebrow">PREDICTION PANEL</span><h2>Overflow watch</h2></div></div>{topRiskBins.map(bin => <div className="impact-row" key={`${bin.id}-prediction`}><strong>{bin.id}</strong><span>{bin.forecast?.overflowRisk || bin.priority}<br /><small>{bin.forecast?.factors?.[0] || `${bin.fill}% current fill`}</small></span></div>)}{!topRiskBins.length && <div className="empty-popover">No bins are currently predicted to overflow.</div>}</div></div><div className="panel monitoring-panel"><div className="panel-heading"><div><span className="eyebrow">CURRENT CONDITIONS</span><h2>{filter === 'ALL' ? 'All bins' : `${filter.toLowerCase()} priority bins`}</h2></div><span className="live-label"><span />AUTO-REFRESH 30S</span></div><div className="monitor-table"><div className="monitor-head"><span>BIN</span><span>WASTE STREAM</span><span>FILL LEVEL</span><span>FORECAST</span><span>SENSOR</span><span>PRIORITY</span></div>{bins.map(bin => <div className="monitor-row" key={bin.id}><div className="monitor-bin"><div className={`bin-status ${bin.priority.toLowerCase()}`}><Layers3 size={16} /></div><strong>{bin.id}<small>{bin.location}</small></strong></div><span className="waste-label">{bin.wasteType}<small>{bin.capacity}L capacity</small></span><div className="monitor-fill"><div><strong>{bin.fill}%</strong><span>{bin.fillRate}% / hr</span></div><i><b className={bin.priority.toLowerCase()} style={{ width: `${bin.fill}%` }} /></i></div><span className="forecast-cell"><Clock3 size={14} />{bin.forecast.hours}h <small>until overflow</small></span><span className={bin.sensorStatus === 'ONLINE' ? 'sensor-good' : 'sensor-warn'}><span />{bin.sensorStatus}</span><span className={`priority ${bin.priority.toLowerCase()}`}>{bin.priority}</span></div>)}</div>{bins.length === 0 && <div className="empty-state"><Layers3 size={22} /><strong>No bins match this priority</strong><span>Try another monitoring filter.</span></div>}</div></div>;
}

function CollectionTasks({ tasks, operator, admin, sessionUser, updateTask, createTask }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ bins: '', vehicleId: '', assigneeId: '', priority: 'HIGH', reason: '' });
  const [operators, setOperators] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  useEffect(() => { Promise.all([fetchJson('/vehicles'), ...(admin ? [fetchJson('/users')] : [])]).then(([fleet, users = []]) => { setVehicles(fleet); setOperators(users.filter(user => user.role === 'OPERATOR' && user.status === 'ACTIVE')); }).catch(error => setMessage(error.message)); }, [admin]);
  const visible = tasks.filter(task => statusFilter === 'ALL' || task.status === statusFilter).filter(task => `${task.id} ${task.reason} ${task.vehicle} ${task.driver} ${task.bins.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const save = async event => { event.preventDefault(); const result = await createTask({ bins: form.bins.split(',').map(value => value.trim()).filter(Boolean), vehicleId: form.vehicleId, assigneeId: admin ? form.assigneeId || null : sessionUser?.id, priority: form.priority, reason: form.reason || 'Manual collection task created' }); if (result) { setForm({ bins: '', vehicleId: '', assigneeId: '', priority: 'HIGH', reason: '' }); setMessage('Task created and added to the live queue.'); } };
  const assign = async (task, assigneeId, vehicleId) => { try { if (assigneeId) await fetchJson(`/collections/${task.id}/assign`, { method: 'PATCH', body: JSON.stringify({ assigneeId }) }); if (vehicleId) await fetchJson(`/collections/${task.id}/details`, { method: 'PATCH', body: JSON.stringify({ vehicleId }) }); setMessage(`${task.id} assignment saved.`); setSelected(null); } catch (error) { setMessage(error.message); } };
  const nextStatus = status => ({ CREATED: 'DISPATCHED', DISPATCHED: 'DRIVER_EN_ROUTE', DRIVER_EN_ROUTE: 'ARRIVED', ARRIVED: 'COLLECTING', COLLECTING: 'COMPLETED', COMPLETED: 'VERIFIED', PENDING: 'ASSIGNED', ASSIGNED: 'EN_ROUTE', EN_ROUTE: 'COLLECTING', IN_PROGRESS: 'COLLECTING' }[status] || 'COMPLETED');
  const startResponse = async task => { try { await fetchJson(`/collections/${task.id}/demo-start`, { method: 'POST', body: JSON.stringify({ delayMs: 1500 }) }); setMessage(`${task.id} response started through the backend lifecycle.`); } catch (error) { setMessage(error.message); } };
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">FIELD OPERATIONS</span><h1>Manage tasks<span className="heading-period">.</span></h1><p>Search, filter, assign, and update the shared Hyderabad collection queue.</p></div></div>{(admin || operator) && <form className="panel incident-form" onSubmit={save}><div className="panel-heading"><div><span className="eyebrow">{admin ? 'DISPATCH ACTION' : 'FIELD ACTION'}</span><h2>Create collection task</h2></div></div><label>Bin IDs<input value={form.bins} onChange={event => setForm(current => ({ ...current, bins: event.target.value }))} placeholder="HYG-001, HYG-002" required /></label><label>Vehicle<select value={form.vehicleId} onChange={event => setForm(current => ({ ...current, vehicleId: event.target.value }))} required><option value="">Select vehicle</option>{vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.id} · {vehicle.driver}</option>)}</select></label><label>Priority<select value={form.priority} onChange={event => setForm(current => ({ ...current, priority: event.target.value }))}><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></label>{admin && <label>Operator<select value={form.assigneeId} onChange={event => setForm(current => ({ ...current, assigneeId: event.target.value }))}><option value="">Unassigned</option>{operators.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>}<label>Reason<input value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} placeholder="Why is this collection needed?" /></label><button className="primary-button" type="submit">Create task</button></form>}{message && <div className="task-success">{message}</div>}<div className="panel tasks-panel full-tasks-panel"><div className="panel-heading"><div><span className="eyebrow">DISPATCH BOARD</span><h2>{visible.length} tasks</h2></div><div className="task-filters"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" /><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option>ALL</option><option>PENDING</option><option>ASSIGNED</option><option>EN_ROUTE</option><option>COLLECTING</option><option>IN_PROGRESS</option><option>COMPLETED</option><option>CANCELLED</option></select></div></div><div className="task-table"><div className="task-head"><span>TASK</span><span>PRIORITY</span><span>LOCATION</span><span>ASSIGNMENT</span><span>STATUS</span></div>{visible.length ? visible.map(task => <button className="task-row full-task-row" key={task.id} onClick={() => setSelected(task)}><strong>{task.id}<small>{task.source === 'AI' ? 'AI generated' : 'Manual'} · {task.reason}</small></strong><span className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</span><span className="route-cell"><Route size={14} />{task.bins.join(' → ')}<small>{task.distance} km · {task.duration} min</small></span><span className="assignment-cell"><Truck size={14} /><span>{task.vehicle}<small>{task.driver || 'Unassigned'}</small></span></span><span className={`task-status ${task.status.toLowerCase()}`}><span />{task.status.replace('_', ' ')}</span></button>) : <div className="empty-popover">No tasks match the current filters.</div>}</div></div>{selected && <div className="detail-drawer"><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close task details"><X size={16} /></button><span className="eyebrow">TASK DETAIL</span><h2>{selected.id}</h2><p>{selected.reason}<br />Status {selected.status}<br />Priority {selected.priority}<br />Vehicle {selected.vehicle}<br />Driver {selected.driver || 'Unassigned'}{selected.reportId ? <><br />Report {selected.reportId}<br />Data source SIMULATED / PUBLIC REPORT</> : null}</p>{(selected.reportId && ['CREATED', 'DISPATCHED'].includes(selected.status) || selected.source === 'PUBLIC_REPORT_AGENT') && !['VERIFIED', 'CANCELLED'].includes(selected.status) && <button className="primary-button" onClick={() => { startResponse(selected); setSelected(null); }}>Start response</button>}{admin && <><label>Assign operator<select defaultValue={selected.assigneeId || ''} onChange={event => assign(selected, event.target.value, '')}><option value="">Unassigned</option>{operators.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label>Assign vehicle<select defaultValue={selected.vehicle || ''} onChange={event => assign(selected, '', event.target.value)}><option value="">Select vehicle</option>{vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.id}</option>)}</select></label></>}{!['COMPLETED', 'CANCELLED'].includes(selected.status) && !selected.reportId && <button className="secondary-button" onClick={() => { updateTask(selected.id, nextStatus(selected.status)); setSelected(null); }}>Advance status</button>}</div>}</div>;
}

function LegacyCollectionTasks({ tasks, operator, updateTask }) {
  const active = tasks.filter(task => ['PENDING', 'ASSIGNED', 'IN_PROGRESS'].includes(task.status)).length;
  const completed = tasks.filter(task => task.status === 'COMPLETED').length;
  const aiCreated = tasks.filter(task => task.source === 'AI').length;
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">FIELD OPERATIONS</span><h1>Collection tasks<span className="heading-period">.</span></h1><p>Coordinate assignments, routes, and verified collection outcomes.</p></div><button className="primary-button" onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}><Route size={17} />Review operations queue</button></div><div className="collection-summary"><div className="task-stat"><span className="stat-accent active" /><div><strong>{active}</strong><span>Active tasks</span></div></div><div className="task-stat"><span className="stat-accent done" /><div><strong>{completed}</strong><span>Completed today</span></div></div><div className="task-stat"><span className="stat-accent ai" /><div><strong>{aiCreated}</strong><span>AI generated</span></div></div><div className="task-stat"><span className="stat-accent route" /><div><strong>{tasks.reduce((sum, task) => sum + task.distance, 0).toFixed(1)} km</strong><span>Planned distance</span></div></div></div><div className="panel tasks-panel full-tasks-panel"><div className="panel-heading"><div><span className="eyebrow">DISPATCH BOARD</span><h2>Today&apos;s collection plan</h2></div><span className="live-label"><span />LIVE QUEUE</span></div><div className="task-table"><div className="task-head"><span>TASK</span><span>PRIORITY</span><span>ROUTE</span><span>VEHICLE / DRIVER</span><span>STATUS</span></div>{tasks.map(task => <div className="task-row full-task-row" key={task.id}><strong>{task.id}<small>{task.source === 'AI' ? 'AI generated' : 'Manual'} · {task.reason}</small></strong><span className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</span><span className="route-cell"><Route size={14} />{task.bins.join(' → ')}<small>{task.distance} km · {task.duration} min</small></span><span className="assignment-cell"><Truck size={14} /><span>{task.vehicle}<small>{task.driver}</small></span></span><span className={`task-status ${task.status.toLowerCase()}`}><span />{task.status.replace('_', ' ')}</span></div>)}</div>{tasks.length === 0 && <div className="empty-state"><Route size={22} /><strong>No collection tasks yet</strong><span>Run the AI optimization to create a verified route.</span></div>}</div></div>;
}

function FleetView({ vehicles, admin }) {
  const [selected, setSelected] = useState(null);
  const [fleet, setFleet] = useState(vehicles);
  const [message, setMessage] = useState('');
  useEffect(() => { setFleet(vehicles); }, [vehicles]);
  const updateStatus = async status => { try { await fetchJson(`/vehicles/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setFleet(current => current.map(vehicle => vehicle.id === selected.id ? { ...vehicle, status } : vehicle)); setSelected(current => ({ ...current, status })); setMessage(`Vehicle ${selected.id} is now ${status}.`); } catch (error) { setMessage(error.message); } };
  const available = fleet.filter(vehicle => vehicle.status === 'AVAILABLE').length;
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">FLEET CONTROL</span><h1>Fleet operations<span className="heading-period">.</span></h1><p>Live vehicle readiness, load, location, and assignment state.</p></div><div className="monitoring-health"><span />FLEET READY <strong>{available}/{fleet.length}</strong></div></div>{message && <div className="task-success">{message}</div>}<div className="fleet-summary"><div className="task-stat"><span className="stat-accent done" /><div><strong>{available}</strong><span>Available now</span></div></div><div className="task-stat"><span className="stat-accent active" /><div><strong>{fleet.filter(vehicle => ['ASSIGNED', 'EN_ROUTE', 'COLLECTING'].includes(vehicle.status)).length}</strong><span>Active vehicles</span></div></div><div className="task-stat"><span className="stat-accent route" /><div><strong>{fleet.filter(vehicle => vehicle.status === 'MAINTENANCE').length}</strong><span>In maintenance</span></div></div></div><div className="fleet-grid">{fleet.map(vehicle => <button className="fleet-card" key={vehicle.id} onClick={() => setSelected(vehicle)}><div className="fleet-card-head"><div className="vehicle-icon"><Truck size={19} /></div><span className={`fleet-status ${vehicle.status.toLowerCase()}`}><span />{vehicle.status}</span></div><strong className="vehicle-id">{vehicle.id}</strong><span className="registration">{vehicle.registration} · {vehicle.type || 'Collection vehicle'}</span><div className="vehicle-details"><span>Capacity <strong>{vehicle.capacity} kg</strong></span><span>Load <strong>{vehicle.currentLoad} kg ({Math.round((vehicle.currentLoad / Math.max(vehicle.capacity, 1)) * 100)}%)</strong></span></div><div className="driver-line"><div className="avatar">{(vehicle.driver || 'Unassigned').split(' ').map(name => name[0]).join('')}</div><span><small>DRIVER · {vehicle.location}</small>{vehicle.driver || 'Unassigned'}</span><ChevronRight size={15} /></div></button>)}</div>{selected && <div className="detail-drawer"><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close vehicle details"><X size={16} /></button><span className="eyebrow">VEHICLE DETAIL</span><h2>{selected.id} · {selected.registration}</h2><p>{selected.type || 'Collection vehicle'} operating from {selected.location}.</p><div className="metric-grid"><div className="metric-card"><span className="metric-label">Current load</span><strong className="metric-value">{selected.currentLoad} kg</strong></div><div className="metric-card"><span className="metric-label">Fuel level</span><strong className="metric-value">{selected.fuelLevel}%</strong></div></div><p><strong>Driver:</strong> {selected.driver || 'Unassigned'}<br /><strong>Status:</strong> {selected.status}<br /><strong>Last update:</strong> {new Date(selected.lastService).toLocaleString()}</p>{admin && <div className="route-actions"><button className="secondary-button" onClick={() => updateStatus('AVAILABLE')}>Return available</button><button className="secondary-button" onClick={() => updateStatus('MAINTENANCE')}>Mark maintenance</button></div>}</div>}</div>;
}

function DriversView({ admin }) {
  const [drivers, setDrivers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const load = async () => { try { setDrivers(await fetchJson('/drivers')); } catch (error) { setMessage(error.message); } };
  useEffect(() => { load(); }, []);
  const updateStatus = async status => { try { await fetchJson(`/drivers/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setMessage(`${selected.name} updated.`); setSelected(null); await load(); } catch (error) { setMessage(error.message); } };
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">FIELD TEAM</span><h1>Drivers<span className="heading-period">.</span></h1><p>Driver availability, current assignments, and performance across Hyderabad.</p></div></div>{message && <div className="task-success">{message}</div>}<div className="fleet-grid">{drivers.map(driver => <button className="fleet-card" key={driver.id} onClick={() => setSelected(driver)}><div className="fleet-card-head"><div className="avatar">{initials(driver.name)}</div><span className={`fleet-status ${driver.status.toLowerCase()}`}><span />{driver.status}</span></div><strong className="vehicle-id">{driver.name}</strong><span className="registration">{driver.id} · {driver.phone}</span><div className="vehicle-details"><span>Vehicle <strong>{driver.vehicleId || 'Unassigned'}</strong></span><span>Rating <strong>{driver.rating} / 5</strong></span></div><div className="driver-line"><span><small>LOCATION · {driver.location}</small>{driver.completedTasks} completed tasks</span><ChevronRight size={15} /></div></button>)}</div>{selected && <div className="detail-drawer"><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close driver details"><X size={16} /></button><span className="eyebrow">DRIVER DETAIL</span><h2>{selected.name}</h2><p>{selected.phone}<br />License {selected.licenseNumber}<br />Vehicle {selected.vehicleId || 'Unassigned'}<br />Current location {selected.location}</p><div className="metric-grid"><div className="metric-card"><span className="metric-label">Completed tasks</span><strong className="metric-value">{selected.completedTasks}</strong></div><div className="metric-card"><span className="metric-label">Performance</span><strong className="metric-value">{selected.rating}</strong></div></div>{selected.currentTask && <p><strong>Current task:</strong> {selected.currentTask.id} · {selected.currentTask.status}</p>}{admin && <div className="route-actions"><button className="secondary-button" onClick={() => updateStatus('ONLINE')}>Mark online</button><button className="secondary-button" onClick={() => updateStatus('ON_BREAK')}>Set break</button></div>}</div>}</div>;
}

function AgentsView() {
  const [agents, setAgents] = useState([]);
  const [activity, setActivity] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { Promise.all([fetchJson('/agents'), fetchJson('/agents/memory')]).then(([current, memory]) => { setAgents(current); setActivity(memory.timeline || memory.audit || []); }).catch(err => setError(err.message)); }, []);
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">ECOFLOW AI ORCHESTRATOR</span><h1>Agent status<span className="heading-period">.</span></h1><p>One backend-validated orchestrator: prediction, prioritization, fleet and driver assignment, routing, dispatch, monitoring, verification, and re-planning.</p></div><span className="role-badge operator">VALIDATED TOOLS</span></div>{error && <div className="error-banner"><AlertTriangle size={17} />{error}</div>}<div className="panel tasks-panel"><div className="panel-heading"><div><span className="eyebrow">ACTIVITY FEED</span><h2>Recent orchestrator actions</h2></div></div>{activity.length ? activity.map(item => <div className="task-row full-task-row" key={item.id}><strong>{item.action}<small>{item.user || 'EcoFlow Orchestrator'}</small></strong><span>{item.resource}</span><span>{item.resourceId}</span><span>{new Date(item.timestamp).toLocaleString()}</span></div>) : <div className="empty-popover">No agent activity recorded yet.</div>}</div></div>;
}

function AgentActivityPanel() {
  const [activity, setActivity] = useState([]);
  useEffect(() => { const load = () => fetchJson('/agents/memory').then(memory => setActivity(memory.timeline || [])).catch(() => {}); load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []);
  return <section className="panel tasks-panel" style={{ marginTop: 18 }}><div className="panel-heading"><div><span className="eyebrow">AI AGENT ACTIVITY</span><h2>Public report response trail</h2></div><span className="live-label"><span />LIVE</span></div>{activity.length ? activity.slice(0, 12).map(item => <div className="task-row full-task-row" key={item.id}><strong>{item.action}<small>{item.phase}</small></strong><span>{item.rationale}</span><span>{item.result?.reportId || item.result?.taskId || 'SYSTEM'}</span><span>{new Date(item.timestamp).toLocaleTimeString()}</span></div>) : <div className="empty-popover">No agent activity recorded yet.</div>}</section>;
}

function DynamicAnalyticsView({ dashboard }) {
  const { wasteTrend, metrics } = dashboard;
  const cards = [
    ['Waste collected', `${metrics.totalWasteCollected} kg`, 'Verified collection records'],
    ['Bins serviced', metrics.completedCollections, `${metrics.taskCompletionRate}% task completion`],
    ['Route efficiency', `${metrics.routeEfficiency}%`, `${metrics.routeDistance} km recorded`],
    ['Estimated fuel usage', `${metrics.estimatedFuel} L`, 'Distance-based estimate'],
    ['Vehicle utilization', `${metrics.vehicleUtilization}%`, 'Current fleet state'],
    ['Driver utilization', `${metrics.driverUtilization}%`, 'Current driver state']
  ];
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">PERFORMANCE INTELLIGENCE</span><h1>Analytics<span className="heading-period">.</span></h1><p>Dynamic metrics calculated from current Hyderabad operational data.</p></div><span className="date-filter">CURRENT DATA <ChevronRight size={14} /></span></div><div className="metric-grid">{cards.map(([label, value, note]) => <div className="metric-card" key={label}><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-foot">{note}</span></div>)}</div><div className="analytics-grid"><div className="panel analytics-chart"><div className="panel-heading"><div><span className="eyebrow">WASTE VOLUME</span><h2>Generation vs recovery</h2></div></div><div className="analytics-chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={wasteTrend}><CartesianGrid vertical={false} stroke="#e7edea" /><XAxis dataKey="day" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><Tooltip /><Bar dataKey="total" fill="#168a77" /><Bar dataKey="recycled" fill="#b9dccc" /></BarChart></ResponsiveContainer></div></div><div className="panel impact-panel"><div className="panel-heading"><div><span className="eyebrow">ESTIMATES</span><h2>Operational impact</h2></div></div><div className="impact-row"><strong>₹{(metrics.estimatedSavings / 1000).toFixed(1)}k</strong><span>Estimated savings<br /><small>Clearly labelled distance and collection estimate</small></span></div><div className="impact-row"><strong>{metrics.overflowIncidents}</strong><span>Open overflow incidents<br /><small>Live incident count</small></span></div><div className="impact-row"><strong>{metrics.diversionPercentage}%</strong><span>Waste diverted<br /><small>Historical collection calculation</small></span></div></div></div></div>;
}

function AnalyticsView({ dashboard }) {
  const { wasteTrend, categoryMix, metrics } = dashboard;
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">PERFORMANCE INTELLIGENCE</span><h1>Analytics<span className="heading-period">.</span></h1><p>Operational efficiency and sustainability impact from live campus data.</p></div><span className="date-filter">LAST 14 DAYS <ChevronRight size={14} /></span></div><div className="metric-grid"><div className="metric-card"><div className="metric-icon teal"><Leaf size={18} /></div><span className="metric-label">Eco efficiency score</span><strong className="metric-value">{metrics.ecoScore}<small className="score-denom"> / 100</small></strong><span className="metric-foot">↗ 6.2% from last period</span></div><div className="metric-card"><div className="metric-icon green"><PackageCheck size={18} /></div><span className="metric-label">Waste diverted</span><strong className="metric-value">62%</strong><span className="metric-foot">↗ 4.8% recycling rate</span></div><div className="metric-card"><div className="metric-icon blue"><Route size={18} /></div><span className="metric-label">Route efficiency</span><strong className="metric-value">91%</strong><span className="metric-foot">↗ 2.4 km saved / day</span></div><div className="metric-card"><div className="metric-icon coral"><Fuel size={18} /></div><span className="metric-label">Fuel consumption</span><strong className="metric-value">184 L</strong><span className="metric-foot warning">↓ 11.3% optimized</span></div></div><div className="analytics-grid"><div className="panel analytics-chart"><div className="panel-heading"><div><span className="eyebrow">WASTE VOLUME</span><h2>Generation vs recovery</h2></div></div><div className="analytics-chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={wasteTrend}><CartesianGrid vertical={false} stroke="#e7edea" /><XAxis dataKey="day" tickFormatter={value => value.replace('Day ', 'D')} tickLine={false} axisLine={false} tick={{ fill: '#8a9996', fontSize: 11 }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8a9996', fontSize: 11 }} /><Tooltip /><Bar dataKey="total" fill="#168a77" radius={[3, 3, 0, 0]} /><Bar dataKey="recycled" fill="#b9dccc" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div></div><div className="panel impact-panel"><div className="panel-heading"><div><span className="eyebrow">SUSTAINABILITY IMPACT</span><h2>What changed</h2></div></div><div className="impact-row"><strong>12.6%</strong><span>Estimated cost savings<br /><small>₹{(metrics.estimatedSavings / 1000).toFixed(1)}k monthly</small></span></div><div className="impact-row"><strong>−18%</strong><span>Overflow incidents<br /><small>Compared with fixed schedules</small></span></div><div className="impact-row"><strong>62%</strong><span>Diverted from landfill<br /><small>Recycling and organic recovery</small></span></div></div></div></div>;
}

createRoot(document.getElementById('root')).render(<App />);
