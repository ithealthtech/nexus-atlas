const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const dialog = $('#editor');
const detail = $('#detail');
const state = { actor: null, csrf: '', stage: '', setup: false, enrollment: null, users: [], events: [], clients: [], records: [], activity: [], bitlocker: [], route: 'overview', client: '', query: '', filter: 'All', opened: null };
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M2 21h20M9 21v-5h4v5M8 7h1m4 0h1M8 11h1m4 0h1"/>',
  book: '<path d="M4 4h13a3 3 0 0 1 3 3v14H7a3 3 0 0 1-3-3V4Zm0 14a3 3 0 0 1 3-3h13M8 7h8M8 10h6"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  exit: '<path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-5-1 2 2"/>'
};
const icon = name => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initials = name => name.split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
const isEditor = () => ['admin','technician'].includes(state.actor?.role);
const isAdmin = () => state.actor?.role === 'admin';
const roleLabel = role => ({ admin: 'Administrator', technician: 'Technician', client: 'Client viewer' })[role] || role;
const date = value => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not scheduled';
const pill = status => `<span class="pill ${status === 'Current' ? 'current' : status === 'Needs review' ? 'review' : 'draft'}">${status === 'Current' ? icon('check') : status === 'Needs review' ? icon('clock') : ''}${esc(status)}</span>`;
function notify(message) { const toast = $('#toast'); toast.textContent = message; toast.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.hidden = true, 4500); }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && !['/session','/session/mfa','/setup'].includes(path)) { signedOut(); } throw new Error(data.error || 'Request failed.'); }
  return data;
}
async function refresh() {
  [state.clients, state.records, state.activity, state.bitlocker] = await Promise.all([api('/clients'), api('/records'), api('/activity'), api('/bitlocker')]);
  if (isAdmin()) [state.users, state.events] = await Promise.all([api('/users'), api('/security-events')]);
  if (state.client && !state.clients.some(c => c.id === state.client)) state.client = '';
}
function routeUrl(route, client = '') { return `#${route}${client ? `/${encodeURIComponent(client)}` : ''}`; }
function go(route, client = '') {
  const hash = routeUrl(route, client);
  if (location.hash === hash) { readRoute(); render(); } else location.hash = hash;
}
function readRoute() {
  const [route, client = ''] = location.hash.slice(1).split('/');
  state.route = ['overview','clients','assets','documents','vault','bitlocker','activity','search','account',...(isAdmin() ? ['users'] : [])].includes(route) ? route : 'overview';
  state.client = state.clients.some(c => c.id === client) ? client : '';
  state.filter = 'All'; closeDetail(false);
}
function currentRecords() { return state.records.filter(r => !state.client || r.client_id === state.client); }
// Sign-in, first-run setup, MFA and required password changes share one full-page layout.
function authScreen(notice = '') {
  const stage = state.actor ? state.stage : state.setup ? 'setup' : 'signin';
  const forms = {
    signin: ['Sign in to Atlas', 'Use the account your administrator created for you.', `${authField('Email','email','email','username')}${authField('Password','password','password','current-password')}`, 'Sign in'],
    setup: ['Create the first administrator', 'Enter the setup code shown in the Atlas server console, then choose your administrator account.', `${authField('Setup code','setupCode','text','off')}${authField('Your name','name','text','name')}${authField('Email','email','email','username')}${authField('Password','password','password','new-password','minlength="12"')}<p class="field-help">At least 12 characters. A long passphrase is best.</p>`, 'Create administrator'],
    mfa: ['Two-step verification', 'Enter the 6-digit code from your authenticator app.', authField('Authentication code','code','text','one-time-code','inputmode="numeric" pattern="[0-9]{6}" maxlength="6"'), 'Verify'],
    password: ['Choose a new password', 'Your administrator issued a temporary password. Replace it before continuing.', `${authField('Temporary password','current','password','current-password')}${authField('New password','next','password','new-password','minlength="12"')}<p class="field-help">At least 12 characters. A long passphrase is best.</p>`, 'Save password'],
    'mfa-setup': ['Protect your account', 'Atlas staff accounts require an authenticator app. Add this key to Microsoft Authenticator, Google Authenticator, 1Password, or a similar app.', state.enrollment ? `<div class="mfa-key"><span class="eyebrow">SETUP KEY</span><code>${esc(state.enrollment.secret.match(/.{1,4}/g).join(' '))}</code><button type="button" class="text-button" data-action="copy-key">Copy key</button><details><summary>Setup link for apps that accept one</summary><code class="mfa-uri">${esc(state.enrollment.uri)}</code></details></div>${authField('Code from your app','code','text','one-time-code','inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}` : '<p class="muted">Preparing your setup key…</p>', 'Turn on MFA']
  };
  const [title, description, fields, submit] = forms[stage];
  app.innerHTML = `<main id="main" class="welcome auth"><div class="welcome-brand"><span class="brand-mark">A</span> ATLAS <span>FOR MSPs</span></div><div class="welcome-grid"><section><div class="eyebrow">YOUR DOCUMENTATION WORKSPACE</div><h1>A clearer picture.<br>For every client.</h1><p>Bring infrastructure, knowledge, and the people you support into one connected workspace.</p><div class="welcome-note">Local development release · Synthetic data only<br>The encrypted vault is not available yet.</div></section><section class="welcome-card auth-card"><form id="auth-form" data-stage="${stage}"><h2>${esc(title)}</h2><p class="auth-lead">${esc(description)}</p>${fields}<p class="form-error" role="alert" ${notice ? '' : 'hidden'}>${esc(notice)}</p><button type="submit" class="btn primary large">${esc(submit)} ${icon('arrow')}</button>${state.actor ? '<button type="button" class="text-button" data-action="logout">Sign out</button>' : ''}</form></section></div></main>`;
  closeDetail(false);
  $('#auth-form input')?.focus();
}
function authField(label, name, type, autocomplete, extra = '') { return `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" required ${extra}></label>`; }
function signedOut() { if (dialog.open) dialog.close(); dialog.innerHTML = ''; Object.assign(state, { actor: null, csrf: '', stage: '', enrollment: null, managing: null, users: [], events: [] }); authScreen(); }
async function applySession(session) {
  state.actor = session.actor; state.csrf = session.csrf; state.stage = session.stage;
  if (state.stage === 'mfa-setup' && !state.enrollment) { authScreen(); state.enrollment = await api('/account/mfa/setup', { method: 'POST', body: '{}' }); }
  if (state.stage !== 'active') return authScreen();
  state.enrollment = null; await refresh(); readRoute(); render();
}
function navItem(route, label, image, count) { return `<a class="nav-item ${state.route === route ? 'active' : ''}" href="${routeUrl(route)}">${icon(image)}<span>${label}</span>${count !== undefined ? `<small>${count}</small>` : ''}</a>`; }
function render() {
  if (!state.actor || state.stage !== 'active') return authScreen();
  const company = state.clients.find(c => c.id === state.client);
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#overview"><span class="brand-mark">A</span><span>atlas<small>MSP WORKSPACE</small></span></a><div class="workspace-label"><span class="workspace-avatar">IT</span><div>IT Done Right<small>Documentation workspace</small></div></div><nav aria-label="Main navigation"><div class="nav-label">WORKSPACE</div>${navItem('overview','Overview','grid')}${navItem('clients','Clients','building',state.clients.length)}${navItem('documents','Knowledge base','book')}${navItem('assets','Assets','server')}${navItem('vault','Password vault','lock')}${navItem('bitlocker','BitLocker','shield')}${navItem('activity','Activity','pulse')}${isAdmin() ? navItem('users','Users','users',state.users.length) : ''}</nav><div class="nav-label client-label">CLIENT SHORTCUTS</div><div class="client-shortcuts">${state.clients.slice(0,5).map((c,i) => `<a href="${routeUrl('overview',c.id)}" class="shortcut ${state.client === c.id ? 'selected' : ''}"><span class="client-dot tone-${i % 4}"></span>${esc(c.name)}</a>`).join('')}</div><div class="sidebar-bottom"><div class="local-label">${icon('shield')} Local development</div><p>Sample data only.<br>Vault storage is disabled.</p><div class="profile"><a class="profile-link" href="#account"><span class="profile-avatar">${esc(initials(state.actor.name))}</span><div>${esc(state.actor.name)}<small>${esc(roleLabel(state.actor.role))}${state.actor.clientIds ? ` · ${state.actor.clientIds.length} client${state.actor.clientIds.length === 1 ? '' : 's'}` : ''}</small></div></a><button class="icon-button" data-action="logout" aria-label="Sign out">${icon('exit')}</button></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumbs"><span>Workspace</span>${icon('chevron')}<strong>${esc(company?.name || 'All clients')}</strong></div><form id="search-form" class="searchbox">${icon('search')}<input name="q" id="global-search" aria-label="Search all accessible documentation" placeholder="Search documentation…" maxlength="200" value="${esc(state.route === 'search' ? state.query : '')}"><kbd>/</kbd></form><span class="preview-badge">LOCAL PREVIEW</span></header><main id="main" tabindex="-1">${company ? clientTabs(company) : ''}${content(company)}</main><footer class="page-footer"><span>Atlas · Development release 0.2</span><a class="text-link" href="#account">Signed in as ${esc(state.actor.email)} ${icon('arrow')}</a></footer></div></div>`;
}
function heading(kicker, title, description, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="heading-actions">${actions}</div></div>`; }
function addButton(kind, label) { return isEditor() ? `<button class="btn primary" data-action="new-${kind}">${icon('plus')}${label}</button>` : ''; }
function empty(title, message) { return `<div class="empty">${icon('book')}<h3>${esc(title)}</h3><p>${esc(message)}</p></div>`; }
function stat(label, value, subtitle, image) { return `<div class="stat"><div class="stat-top">${esc(label)}${icon(image)}</div><strong>${value}</strong><span>${esc(subtitle)}</span></div>`; }
function clientRows(clients) {
  if (!clients.length) return empty('Your first client starts here', 'Add a client to begin documenting their environment.');
  return `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Assets</th><th>Documents</th><th>Needs review</th><th><span class="sr-only">Open client</span></th></tr></thead><tbody>${clients.map((c,i) => `<tr><td><a class="client-cell" href="${routeUrl('overview',c.id)}"><span class="avatar tone-${i % 4}">${esc(initials(c.name))}</span><span><strong>${esc(c.name)}</strong><small>${esc(c.industry)}</small></span></a></td><td>${c.assets}</td><td>${c.documents}</td><td>${state.records.filter(r => r.client_id === c.id && r.status === 'Needs review').length || '<span class="muted">—</span>'}</td><td><a class="row-arrow" href="${routeUrl('overview',c.id)}" aria-label="Open ${esc(c.name)}">${icon('arrow')}</a></td></tr>`).join('')}</tbody></table></div>`;
}
function recordRows(records) {
  if (!records.length) return empty('No records found', 'Try another filter, or create the first record.');
  return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>${state.client ? 'Type' : 'Client'}</th><th>Status</th><th>Review date</th><th><span class="sr-only">Open record</span></th></tr></thead><tbody>${records.map(r => `<tr><td><button class="record-cell" data-action="open" data-id="${esc(r.id)}"><span class="record-icon ${r.kind}">${icon(r.kind === 'asset' ? 'server' : 'book')}</span><span><strong>${esc(r.title)}</strong><small>${esc(r.category)}${r.address ? ` · ${esc(r.address)}` : ''}</small></span></button></td><td>${esc(state.client ? r.category : r.client_name)}</td><td>${pill(r.status)}</td><td class="date-cell">${date(r.review_date)}</td><td><button class="row-arrow" data-action="open" data-id="${esc(r.id)}" aria-label="Open ${esc(r.title)}">${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function sectionHeader(title, count, link = '') { return `<div class="section-heading"><h2>${title}${count !== undefined ? `<span class="count">${count}</span>` : ''}</h2>${link}</div>`; }
function clientTabs(company) {
  return `<nav class="client-tabs" aria-label="Client workspace navigation">${[['overview','Overview'],['assets','Assets'],['documents','Knowledge'],['bitlocker','BitLocker'],['activity','Activity']].map(([route,label]) => `<a href="${routeUrl(route,company.id)}" ${state.route === route ? 'aria-current="page"' : ''}>${label}</a>`).join('')}<a class="all-clients" href="#clients">All clients ${icon('arrow')}</a></nav>`;
}
function content(company) {
  const records = currentRecords(); const assets = records.filter(r => r.kind === 'asset'); const docs = records.filter(r => r.kind === 'document');
  const review = records.filter(r => r.status === 'Needs review');
  const activities = state.activity.filter(a => !state.client || a.client_id === state.client);
  if (state.route === 'overview') {
    return `${heading(company ? 'CLIENT WORKSPACE' : 'PORTFOLIO OVERVIEW', company?.name || 'Everything in context.', company ? `${company.industry} · ${company.contact || 'No primary contact'}` : 'Your clients, their infrastructure, and the knowledge that connects them.', company ? `${isEditor() ? '<button class="btn" data-action="export">'+icon('download')+'Export</button>' : ''}${addButton('asset','Add asset')}${addButton('document','New document')}` : addButton('client','Add client'))}<div class="stats">${company ? stat('Documented assets',assets.length,'Infrastructure in this workspace','server') : stat('Client workspaces',state.clients.length,'One connected portfolio','building')}${stat(company ? 'Knowledge articles' : 'Documented assets',company ? docs.length : assets.length,company ? 'Procedures and reference material' : 'Across your client environments',company ? 'book' : 'server')}${stat(company ? 'Current records' : 'Knowledge articles',company ? records.filter(r => r.status === 'Current').length : docs.length,company ? 'Records marked current' : 'Runbooks, checklists, and references',company ? 'link' : 'book')}${stat('Needs attention',review.length,'Records flagged for review','clock')}</div><div class="overview-grid"><section class="panel main-panel">${sectionHeader(company ? 'Client documentation' : 'Your clients', company ? records.length : state.clients.length, `<a class="text-link" href="${routeUrl(company ? 'documents' : 'clients',state.client)}">View all ${icon('arrow')}</a>`)}${company ? recordRows(records) : clientRows(state.clients)}<div class="panel-bottom">${icon('link')} ${company ? 'Open a record to see its documentation and related assets.' : 'Select a client to explore their connected workspace.'}</div></section><section class="panel attention-panel">${sectionHeader('Review queue',review.length)}<p class="section-caption">Keep useful knowledge up to date.</p>${review.length ? review.slice(0,4).map(r => `<button class="review-item" data-action="open" data-id="${esc(r.id)}"><span class="review-item-icon">${icon(r.kind === 'asset' ? 'server' : 'book')}</span><span><strong>${esc(r.title)}</strong><small>${esc(r.client_name)}</small><span class="review-date">Review ${date(r.review_date)}</span></span>${icon('chevron')}</button>`).join('') : '<div class="queue-clear">'+icon('check')+'<h3>You’re up to date</h3><p>No records are flagged for review.</p></div>'}<div class="review-tip">A little maintenance now.<br>A faster resolution later.</div></section></div><section class="panel activity-panel">${sectionHeader('Recent activity',undefined,`<a class="text-link" href="${routeUrl('activity',state.client)}">All activity ${icon('arrow')}</a>`)}${activityList(activities.slice(0,4))}</section>`;
  }
  if (state.route === 'clients') return `${heading('CLIENT DIRECTORY','Your client workspaces','Keep every environment organized and easy to navigate.',addButton('client','Add client'))}<section class="panel">${sectionHeader('All clients',state.clients.length)}${clientRows(state.clients)}</section>`;
  if (state.route === 'assets' || state.route === 'documents' || state.route === 'search') {
    const searching = state.route === 'search'; const isAsset = state.route === 'assets';
    let items = searching ? state.records.filter(r => `${r.title} ${r.content} ${r.category} ${r.client_name} ${r.address}`.toLowerCase().includes(state.query.toLowerCase())) : isAsset ? assets : docs;
    if (state.filter !== 'All') items = items.filter(r => r.status === state.filter);
    return `${heading(searching ? 'WORKSPACE SEARCH' : company?.name || 'ALL CLIENTS',searching ? `Results for “${state.query}”` : isAsset ? 'Infrastructure, documented.' : 'Knowledge that stays with you.',searching ? 'Results include only the client workspaces you can access.' : isAsset ? 'A shared source of context for every system you support.' : 'Runbooks, checklists, and answers your team can rely on.', searching ? '' : addButton(isAsset ? 'asset' : 'document',isAsset ? 'Add asset' : 'New document'))}<section class="panel"><div class="list-toolbar"><div class="filter-tabs" role="group" aria-label="Filter by status">${['All','Current','Needs review','Draft'].map(f => `<button class="filter-tab ${f === state.filter ? 'active' : ''}" data-action="filter" data-filter="${f}" aria-pressed="${f === state.filter}">${f}</button>`).join('')}</div><span class="result-count">${items.length} records</span></div>${recordRows(items)}</section>`;
  }
  if (state.route === 'activity') return `${heading(company?.name || 'ALL CLIENTS','Workspace activity','A record of documentation changes, links, and exports.')}<section class="panel">${sectionHeader('Latest events',activities.length)}${activityList(activities)}</section>`;
  if (state.route === 'bitlocker') return bitlockerPage();
  if (state.route === 'users') return usersPage();
  if (state.route === 'account') return accountPage();
  if (state.route === 'vault') return `${heading('PASSWORD VAULT','A secure foundation comes first.','Credentials will connect to the systems and procedures they belong to.')}<section class="vault-panel"><div class="vault-illustration">${icon('lock')}</div><div class="eyebrow">NOT AVAILABLE IN THIS RELEASE</div><h2>Your future client vault.</h2><p>Shared collections, linked credentials, and controlled access are part of the product plan. Password storage is disabled while encryption, recovery, and sharing are designed and reviewed.</p><div class="vault-capabilities"><span>${icon('shield')} Client-side encryption</span><span>${icon('building')} Client-scoped collections</span><span>${icon('link')} Linked to documentation</span></div><div class="vault-notice">Do not enter passwords or other secrets in documentation fields.</div><a class="btn" href="#documents">Explore the knowledge base ${icon('arrow')}</a></section>`;
}
function accessLabel(user) { return user.allClients ? 'All clients' : user.clientIds.map(id => state.clients.find(c => c.id === id)?.name || 'Unavailable client').join(', '); }
function usersPage() {
  const rows = state.users.map(u => `<tr><td><div class="client-cell"><span class="avatar tone-${u.role === 'admin' ? 0 : u.role === 'technician' ? 3 : 1}">${esc(initials(u.name))}</span><span><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></span></div></td><td>${esc(roleLabel(u.role))}</td><td class="access-cell">${esc(accessLabel(u))}</td><td>${u.disabled ? '<span class="pill draft">Disabled</span>' : u.locked ? '<span class="pill review">Locked</span>' : u.mustChangePassword ? '<span class="pill review">Password change pending</span>' : pill('Current').replace('Current','Active')}${u.mfa ? ' <span class="pill current">MFA</span>' : ''}</td><td class="date-cell">${u.lastLoginAt ? date(u.lastLoginAt) : 'Never'}</td><td><button class="btn small" data-action="edit-user" data-id="${esc(u.id)}">Manage</button></td></tr>`).join('');
  const events = state.events.slice(0, 25).map(e => `<div class="activity-row"><span class="activity-icon">${icon(e.action.includes('fail') || e.action.includes('lock') || e.action.includes('block') ? 'lock' : 'shield')}</span><div><strong>${esc(e.action)} <span class="normal">${esc(e.detail)}</span></strong><small>${esc(e.actor)}${e.ip ? ` <span>·</span> ${esc(e.ip)}` : ''}</small></div><time datetime="${esc(e.created_at)}">${new Date(e.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></div>`).join('');
  return `${heading('ADMINISTRATION','People and access.','Decide who can see each client, and who can change their documentation.',`<button class="btn primary" data-action="new-user">${icon('plus')}Add user</button>`)}<section class="panel">${sectionHeader('Users',state.users.length)}<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Client access</th><th>Status</th><th>Last sign-in</th><th><span class="sr-only">Manage</span></th></tr></thead><tbody>${rows}</tbody></table></div><div class="panel-bottom">${icon('shield')}Administrators and technicians must use an authenticator app. Access changes apply immediately.</div></section><section class="panel activity-panel users-events">${sectionHeader('Security events',state.events.length)}${events ? `<div class="activity-list">${events}</div>` : empty('No security events yet','Sign-ins and account changes will appear here.')}</section>`;
}
function accountPage() {
  const a = state.actor;
  return `${heading('YOUR ACCOUNT',a.name,`${roleLabel(a.role)} · ${a.email}`)}<div class="account-grid"><section class="panel account-panel">${sectionHeader('Sign-in')}<dl class="record-meta"><div><dt>Role</dt><dd>${esc(roleLabel(a.role))}</dd></div><div><dt>Client access</dt><dd>${a.clientIds ? esc(a.clientIds.map(id => state.clients.find(c => c.id === id)?.name).filter(Boolean).join(', ') || 'None') : 'All clients'}</dd></div><div><dt>Two-step verification</dt><dd>${a.mfa ? 'On · authenticator app' : 'Off'}</dd></div><div><dt>Permissions</dt><dd>${isAdmin() ? 'Manage users and all documentation' : isEditor() ? 'Create and edit documentation' : 'Read-only'}</dd></div></dl><div class="account-actions"><button class="btn" data-action="change-password">${icon('key')}Change password</button>${a.mfa ? '' : `<button class="btn" data-action="enable-mfa">${icon('shield')}Turn on two-step verification</button>`}</div><div class="panel-bottom">${icon('lock')}Changing your password signs out your other sessions. Ask an administrator if you lose your authenticator.</div></section></div>`;
}
function userForm(user = null) {
  const role = user?.role || 'technician';
  const clients = state.clients.map(c => `<label class="check"><input type="checkbox" name="clientIds" value="${esc(c.id)}" ${user?.clientIds.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('');
  showDialog(user ? `Manage ${esc(user.name)}` : 'Add a user', `${field('Name','name',user?.name,'required maxlength="120"')}${user ? `<p class="field-help user-email">${esc(user.email)}</p>` : field('Email','email','','type="email" required maxlength="254" autocomplete="off"')}<label>Role<select name="role" data-action-change="role">${['admin','technician','client'].map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select></label><p class="field-help role-help"></p><fieldset class="client-access"><legend>Client access</legend><label class="check all-clients-option"><input type="checkbox" name="allClients" ${user ? (user.allClients ? 'checked' : '') : 'checked'}>All current and future clients</label><div class="client-checks">${clients}</div></fieldset>${user ? `<label class="check"><input type="checkbox" name="disabled" ${user.disabled ? 'checked' : ''}>Disable this account and sign it out everywhere</label>${user.id !== state.actor.id ? '<button type="button" class="text-button" data-action="reset-user">'+icon('key')+'Issue a temporary password</button>' : ''}` : `${field('Temporary password','password','','type="text" required minlength="12" maxlength="256" autocomplete="off"')}<p class="field-help">Share this privately. The user must replace it at first sign-in, and staff must set up an authenticator app.</p>`}`, user ? 'Save changes' : 'Create user', 'user');
  state.managing = user; syncRoleFields();
}
function syncRoleFields() {
  const form = $('#edit-form'); const role = form?.elements.role?.value; if (!role) return;
  const all = form.elements.allClients; const help = $('.role-help', form);
  help.textContent = { admin: 'Full access to every client, plus user management and security events.', technician: 'Creates and edits documentation for the clients selected below.', client: 'Read-only access to the clients selected below. Cannot edit or export.' }[role];
  $('.all-clients-option', form).hidden = role !== 'technician'; $('.client-access', form).hidden = role === 'admin';
  if (role === 'client') all.checked = false;
  $('.client-checks', form).hidden = role === 'technician' && all.checked;
}
function bitlockerPage() {
  const rows = state.bitlocker.filter(r => !state.client || r.clientId === state.client);
  return `${heading('ENDPOINT RECOVERY','BitLocker, in context.','Recovery inventory belongs with the client and the device it protects.')}<div class="module-notice">${icon('shield')}<div><strong>Sample inventory · collection is disabled</strong><p>The Windows collector is part of Atlas’s integration source. RMM enrollment, uploads, recovery-key reveal, and sharing are not enabled yet.</p></div></div><div class="stats bitlocker-stats">${stat('Sample volumes',rows.length,'Linked to documented assets','server')}${stat('Enrolled agents',0,'RMM deployment planned','pulse')}${stat('Recovery keys stored',0,'Secret storage remains disabled','lock')}</div><section class="panel">${sectionHeader('Client recovery inventory',rows.length)}${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Device / asset</th><th>Client</th><th>Volume</th><th>Sample protection</th><th>Recovery key</th></tr></thead><tbody>${rows.map(row => `<tr><td><button class="record-cell" data-action="open" data-id="${esc(row.assetId)}"><span class="record-icon asset">${icon('server')}</span><span><strong>${esc(row.hostname)}</strong><small>${esc(row.encryption)}</small></span></button></td><td>${esc(row.clientName)}</td><td>${esc(row.volume)}</td><td><span class="pill ${row.protection === 'On' ? 'current' : 'draft'}">${esc(row.protection)}</span></td><td><span class="muted">Not collected</span></td></tr>`).join('')}</tbody></table></div>` : empty('No sample volumes in this workspace','Device enrollment will be available after the collection security work is complete.')}<div class="panel-bottom">${icon('link')}Open a device to view its asset record. Protection values above are synthetic examples.</div></section><section class="panel integration-plan">${sectionHeader('RMM collection plan')}<ol><li><strong>Enroll the device</strong><span>Issue a separate, revocable upload identity scoped to a client and asset.</span></li><li><strong>Collect through your RMM</strong><span>The read-only Windows collector encrypts recovery passwords before queueing or upload.</span></li><li><strong>Recover with controlled access</strong><span>Authorized technicians unlock keys in the browser with recorded access and tested recovery.</span></li></ol></section>`;
}
function activityList(items) {
  if (!items.length) return empty('No activity yet', 'Changes to this workspace will appear here.');
  return `<div class="activity-list">${items.map(a => `<div class="activity-row"><span class="activity-icon">${icon(a.action.startsWith('Export') ? 'download' : a.action.startsWith('Link') ? 'link' : 'book')}</span><div><strong>${esc(a.action)} <span class="normal">${esc(a.title)}</span></strong><small>${esc(a.actor)} <span>·</span> ${esc(a.client_name)}</small></div><time datetime="${esc(a.created_at)}">${date(a.created_at)}</time></div>`).join('')}</div>`;
}
function renderDocument(content) {
  return content.split('\n').map(line => line.startsWith('# ') ? `<h3>${esc(line.slice(2))}</h3>` : line.startsWith('## ') ? `<h4>${esc(line.slice(3))}</h4>` : line ? `<p>${esc(line)}</p>` : '<div class="paragraph-break"></div>').join('');
}
let detailRequest = 0;
async function openDetail(id) {
  const request = ++detailRequest;
  const record = await api(`/records/${encodeURIComponent(id)}`);
  if (request !== detailRequest) return;
  state.opened = record; detail.hidden = false;
  const company = state.clients.find(c => c.id === record.client_id);
  detail.innerHTML = `<div class="detail-top"><span class="eyebrow">${record.kind === 'asset' ? 'ASSET' : 'DOCUMENT'} DETAILS</span><button class="icon-button" data-action="close-detail" aria-label="Close details">${icon('close')}</button></div><div class="detail-title"><span class="record-icon ${record.kind}">${icon(record.kind === 'asset' ? 'server' : 'book')}</span><h2>${esc(record.title)}</h2><p>${esc(company?.name)} <span> / </span> ${esc(record.category)}</p><div class="detail-title-bottom">${pill(record.status)}${isEditor() ? '<button class="btn" data-action="edit">Edit record</button>' : '<span class="muted">Read-only access</span>'}</div></div><dl class="record-meta">${record.address ? `<div><dt>Address / hostname</dt><dd>${esc(record.address)}</dd></div>` : ''}<div><dt>Review date</dt><dd>${date(record.review_date)}</dd></div><div><dt>Last updated</dt><dd>${date(record.updated_at)}</dd></div><div><dt>Version</dt><dd>${record.version}</dd></div></dl><div class="document-body">${record.content ? renderDocument(record.content) : '<p class="muted">No notes yet.</p>'}</div><section class="related-section">${sectionHeader('Related records',record.linked.length,isEditor() ? '<button class="text-button" data-action="link-record">'+icon('plus')+'Add link</button>' : '')}${record.linked.length ? record.linked.map(r => `<button class="related-record" data-action="open" data-id="${esc(r.id)}">${icon(r.kind === 'asset' ? 'server' : 'book')}<span>${esc(r.title)}<small>${esc(r.category)}</small></span>${icon('arrow')}</button>`).join('') : '<p class="muted">Link a procedure or asset to give this record more context.</p>'}</section><section class="history-section">${sectionHeader('Version history',record.revisions.length)}${record.revisions.map(r => `<div class="history-row"><span>Version ${r.version}<small>${esc(r.actor)} · ${date(r.created_at)}</small></span>${r.version === record.version ? '<span class="pill current">Latest</span>' : isEditor() ? `<button class="text-button" data-action="restore" data-version="${r.version}">Restore</button>` : ''}</div>`).join('')}</section>`;
  $('.detail-top button',detail).focus();
}
function closeDetail(focus = true) { ++detailRequest; detail.hidden = true; state.opened = null; if (focus) $('#main')?.focus(); }
function showDialog(title, content, submitLabel = 'Save', type = '') {
  dialog.innerHTML = `<form id="edit-form" data-type="${type}"><div class="dialog-heading"><h2 id="editor-title">${title}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close editor">${icon('close')}</button></div><div class="dialog-body">${content}<p class="form-error" role="alert" hidden></p></div><div class="dialog-footer"><button type="button" class="btn" data-action="close-dialog">Cancel</button><button type="submit" class="btn primary">${submitLabel}</button></div></form>`;
  dialog.showModal();
}
function field(label,name,value = '',extra = '') { return `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`; }
function newClient() { showDialog('Add a client',`${field('Client name','name','','required maxlength="200" placeholder="e.g. Acme Industries"')}${field('Industry','industry','','maxlength="80" placeholder="e.g. Healthcare"')}<div class="form-grid">${field('Primary contact','contact','','maxlength="200"')}${field('Email','email','','type="email" maxlength="254"')}</div>`, 'Create workspace', 'client'); }
function editRecord(kind, existing = null) {
  if (!state.clients.length) { notify('Add a client first.'); return newClient(); }
  state.editing = existing;
  showDialog(existing ? 'Edit record' : kind === 'asset' ? 'Add an asset' : 'New document',`${!existing ? `<label>Client workspace<select name="client_id">${state.clients.map(c => `<option value="${esc(c.id)}" ${c.id === state.client ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}${field(kind === 'asset' ? 'Asset name' : 'Document title','title',existing?.title,'required maxlength="200"')}<div class="form-grid"><label>Category<input name="category" list="categories" maxlength="80" required value="${esc(existing?.category || (kind === 'asset' ? 'Server' : 'Runbook'))}"><datalist id="categories">${(kind === 'asset' ? ['Server','Firewall','Network switch','Storage','Cloud service','Workstation','Application'] : ['Runbook','Checklist','Reference','Policy']).map(c => `<option value="${c}"></option>`).join('')}</datalist></label><label>Status<select name="status">${['Current','Needs review','Draft'].map(s => `<option ${existing?.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>${kind === 'asset' ? field('Address / hostname','address',existing?.address,'maxlength="200"') : ''}${field('Review date','review_date',existing?.review_date,'type="date"')}<label>${kind === 'asset' ? 'Notes and configuration' : 'Document content'}<textarea name="content" rows="10" maxlength="30000" placeholder="Use # for headings. Keep credentials out of documentation.">${esc(existing?.content || '')}</textarea></label><p class="field-help">Use sample information only. Never store passwords or secrets here.</p>`,existing ? 'Save changes' : 'Create record',kind);
}
function linkRecord() {
  const record = state.opened;
  const candidates = state.records.filter(r => r.client_id === record.client_id && r.id !== record.id && !record.linked.some(l => l.id === r.id));
  if (!candidates.length) return notify('Create another record in this client workspace to link it.');
  showDialog('Link a related record', `<p class="field-help">Connect an asset or procedure within ${esc(state.clients.find(c => c.id === record.client_id)?.name)}.</p><label>Related record<select name="targetId">${candidates.map(r => `<option value="${esc(r.id)}">${esc(r.title)} · ${esc(r.category)}</option>`).join('')}</select></label>`, 'Add relationship','link');
}
document.addEventListener('click', async event => {
  if (event.target.closest('.skip-link')) { event.preventDefault(); $('#main')?.focus(); return; }
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  try {
    if (action === 'logout') { await api('/session',{method:'DELETE'}).catch(() => {}); signedOut(); }
    else if (action === 'copy-key') { await navigator.clipboard.writeText(state.enrollment.secret); notify('Setup key copied.'); }
    else if (action === 'new-user') userForm();
    else if (action === 'edit-user') userForm(state.users.find(u => u.id === button.dataset.id));
    else if (action === 'reset-user') { const user = state.managing; showDialog(`Reset ${esc(user.name)}`,`<p class="field-help">${esc(user.name)} will be signed out everywhere and must choose a new password at next sign-in.</p>${field('Temporary password','password','','type="text" required minlength="12" maxlength="256" autocomplete="off"')}<label class="check"><input type="checkbox" name="resetMfa">Also reset two-step verification (lost authenticator)</label>`,'Reset access','reset'); }
    else if (action === 'change-password') showDialog('Change password',`${field('Current password','current','','type="password" required autocomplete="current-password"')}${field('New password','next','','type="password" required minlength="12" autocomplete="new-password"')}<p class="field-help">Your other sessions will be signed out.</p>`,'Save password','password');
    else if (action === 'enable-mfa') { state.enrollment = await api('/account/mfa/setup',{method:'POST',body:'{}'}); showDialog('Turn on two-step verification',`<div class="mfa-key"><span class="eyebrow">SETUP KEY</span><code>${esc(state.enrollment.secret.match(/.{1,4}/g).join(' '))}</code><button type="button" class="text-button" data-action="copy-key">Copy key</button></div>${field('Code from your app','code','','required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"')}`,'Turn on MFA','mfa'); }
    else if (action === 'new-client') newClient();
    else if (action === 'new-asset') editRecord('asset');
    else if (action === 'new-document') editRecord('document');
    else if (action === 'edit') editRecord(state.opened.kind,state.opened);
    else if (action === 'close-dialog') dialog.close();
    else if (action === 'close-detail') closeDetail();
    else if (action === 'open') await openDetail(button.dataset.id);
    else if (action === 'filter') { state.filter = button.dataset.filter; render(); }
    else if (action === 'link-record') linkRecord();
    else if (action === 'restore') {
      const record = state.opened; button.disabled = true;
      await api(`/records/${record.id}/restore`,{method:'POST',body:JSON.stringify({version:Number(button.dataset.version),expectedVersion:record.version})});
      await refresh(); render(); await openDetail(record.id); notify('Previous content restored as a new version.');
    } else if (action === 'export') {
      button.disabled = true;
      const output = await api(`/clients/${state.client}/export`,{method:'POST'});
      const url = URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'}));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `atlas-client-${state.client}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
      await refresh(); render(); notify('Client documentation exported.');
    }
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'search-form') { event.preventDefault(); state.query = new FormData(event.target).get('q').trim(); if (state.query) go('search'); return; }
  if (event.target.id === 'auth-form') return submitAuth(event);
  if (event.target.id !== 'edit-form') return;
  event.preventDefault(); const form = event.target; const type = form.dataset.type; const values = Object.fromEntries(new FormData(form));
  const submit = $('button[type="submit"]',form); const errorBox = $('.form-error',form); submit.disabled = true; errorBox.hidden = true;
  try {
    let result;
    if (['user','reset','password','mfa'].includes(type)) return await submitAccount(form, type, values);
    if (type === 'client') result = await api('/clients',{method:'POST',body:JSON.stringify(values)});
    else if (type === 'link') result = await api(`/records/${state.opened.id}/links`,{method:'POST',body:JSON.stringify(values)});
    else {
      const clientId = values.client_id; delete values.client_id;
      if (state.editing) values.version = state.editing.version;
      result = await api(state.editing ? `/records/${state.editing.id}` : `/clients/${clientId}/${type}`,{method:state.editing ? 'PUT' : 'POST',body:JSON.stringify(values)});
    }
    const reopenId = type === 'link' ? state.opened.id : result.id;
    dialog.close(); await refresh(); render();
    if (type === 'client') go('overview',result.id); else await openDetail(reopenId);
    notify(type === 'client' ? 'Client workspace created.' : type === 'link' ? 'Records linked.' : 'Record saved.');
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { submit.disabled = false; }
});
async function submitAuth(event) {
  event.preventDefault(); const form = event.target; const values = Object.fromEntries(new FormData(form));
  const submit = $('button[type="submit"]',form); const errorBox = $('.form-error',form); submit.disabled = true; errorBox.hidden = true;
  const paths = { signin: '/session', setup: '/setup', mfa: '/session/mfa', password: '/account/password', 'mfa-setup': '/account/mfa/confirm' };
  try {
    const session = await api(paths[form.dataset.stage],{method:'POST',body:JSON.stringify(values)});
    if (form.dataset.stage === 'setup') state.setup = false;
    if (['signin','setup'].includes(form.dataset.stage)) history.replaceState(null,'','#overview');
    await applySession(session);
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; submit.disabled = false; $('input[name="code"], input[name="password"]',form)?.select(); }
}
async function submitAccount(form, type, values) {
  if (type === 'user') {
    const role = values.role; const body = { name: values.name, role, allClients: role === 'technician' && form.elements.allClients.checked, clientIds: role === 'admin' ? [] : [...form.querySelectorAll('input[name="clientIds"]:checked')].map(i => i.value) };
    if (state.managing) { body.disabled = form.elements.disabled.checked; await api(`/users/${state.managing.id}`,{method:'PATCH',body:JSON.stringify(body)}); }
    else await api('/users',{method:'POST',body:JSON.stringify({ ...body, email: values.email, password: values.password })});
  } else if (type === 'reset') await api(`/users/${state.managing.id}/reset`,{method:'POST',body:JSON.stringify({ password: values.password, resetMfa: form.elements.resetMfa.checked })});
  else if (type === 'password') await applyQuietly(await api('/account/password',{method:'POST',body:JSON.stringify(values)}));
  else if (type === 'mfa') await applyQuietly(await api('/account/mfa/confirm',{method:'POST',body:JSON.stringify(values)}));
  dialog.close(); await refresh(); render();
  notify({ user: state.managing ? 'User updated.' : 'User created. Share the temporary password privately.', reset: 'Temporary password issued. The user was signed out.', password: 'Password changed. Other sessions were signed out.', mfa: 'Two-step verification is on.' }[type]);
}
function applyQuietly(session) { state.actor = session.actor; state.csrf = session.csrf; state.stage = session.stage; state.enrollment = null; }
document.addEventListener('change', event => { if (event.target.closest('#edit-form') && ['role','allClients'].includes(event.target.name)) syncRoleFields(); });
window.addEventListener('hashchange',() => { if (state.actor && state.stage === 'active') { readRoute(); render(); } });
document.addEventListener('keydown',event => {
  if (event.key === 'Escape' && !dialog.open) closeDetail();
  if (event.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !dialog.open) { event.preventDefault(); $('#global-search')?.focus(); }
});
try {
  const response = await fetch('/api/session');
  if (response.ok) await applySession(await response.json());
  else { state.setup = (await (await fetch('/api/setup')).json()).needed; authScreen(); }
} catch (error) { authScreen(); notify(error.message || 'Could not connect to the local application. Check that it is running.'); }
