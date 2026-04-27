
const state = {
  user: null,
  view: 'dashboard',
  selectedWorkerId: null,
  selectedJobId: null,
  selectedBucket: 'qualified',
  workers: [],
  jobs: [],
  uploads: [],
  dashboard: null,
  bloodwork: [],
  admin: null,
  workerEmailPreview: null,
  certificationAlertRules: [],
  certs: [],
  certsSource: '',
  employeeFilter: 'all',
  employeeSearch: '',
  jobSearch: '',
  selectedCertName: null,
  selectedCertScope: 'active-good',
  alerts: [],
  selectedAlertKey: null,
  accessUsers: [],
  auditLog: [],
  pendingScrollTarget: null,
  workerPortal: null,
  modals: { worker: false, job: false, jobEdit: false, addCertDropdown: false }
};

async function api(path, options = {}) {
  const actorHeaders = state.user ? {
    'x-actor-username': state.user.username || '',
    'x-actor-role': state.user.role || '',
    'x-actor-name': state.user.name || state.user.username || ''
  } : {};
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...actorHeaders, ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Request failed');
  }
  return res.json();
}

function badge(status) {
  let cls = 'bg-gray';
  if (['Qualified', 'Current', 'Active', 'Imported'].includes(status)) cls = 'bg-green';
  if (['Expiring Soon', 'Due Soon'].includes(status)) cls = 'bg-yellow';
  if (['Needs Attention', 'Expired', 'Overdue', 'Needs Review', 'Ready for review', 'Needs date confirmation'].includes(status)) cls = 'bg-red';
  return `<span class="badge ${cls}">${status}</span>`;
}


function buildFallbackAlerts() {
  const counts = state.dashboard?.counts || {};
  const alerts = [];
  const expiringItems = state.workers.filter(w => (w.employmentStatus || 'Active') === 'Active' && String(w.status || '').includes('Expiring'));
  const attentionItems = state.workers.filter(w => (w.employmentStatus || 'Active') === 'Active' && String(w.status || '').includes('Attention'));
  const bloodworkItems = state.workers.filter(w => (w.employmentStatus || 'Active') === 'Active' && (w.bloodwork || []).some(b => {
    const s = String(b.status || '');
    return s.includes('Due') || s.includes('Overdue');
  }));
  const reviewJobs = state.jobs.filter(j => j.stage === 'Needs Review');
  const pendingUploads = state.uploads.filter(u => !['Imported','Attached','Complete'].includes(String(u.status || '')));

  if ((counts.expiring30 || expiringItems.length || 0) > 0) alerts.push({
    key: 'expiring-certs',
    type: 'warning',
    title: 'Expiring certifications',
    detail: `${counts.expiring30 || expiringItems.length} active worker(s) have certifications expiring soon.`,
    count: counts.expiring30 || expiringItems.length,
    scope: 'workers',
    items: expiringItems
  });
  if ((counts.needsAttention || attentionItems.length || 0) > 0) alerts.push({
    key: 'workers-attention',
    type: 'danger',
    title: 'Workers need attention',
    detail: `${counts.needsAttention || attentionItems.length} active worker(s) are missing, expired, or overdue on required items.`,
    count: counts.needsAttention || attentionItems.length,
    scope: 'workers',
    items: attentionItems
  });
  if ((counts.bloodworkDue || bloodworkItems.length || 0) > 0) alerts.push({
    key: 'bloodwork-due',
    type: 'warning',
    title: 'Bloodwork due',
    detail: `${counts.bloodworkDue || bloodworkItems.length} active worker(s) have BLL / ZPP due or overdue.`,
    count: counts.bloodworkDue || bloodworkItems.length,
    scope: 'workers',
    items: bloodworkItems
  });
  if (reviewJobs.length > 0) alerts.push({
    key: 'jobs-review',
    type: 'info',
    title: 'Jobs needing review',
    detail: `${reviewJobs.length} job(s) still need requirement review before they should be trusted for qualification.`,
    count: reviewJobs.length,
    scope: 'jobs',
    items: reviewJobs
  });
  if (pendingUploads.length > 0) alerts.push({
    key: 'uploads-review',
    type: 'info',
    title: 'Uploads waiting for review',
    detail: `${pendingUploads.length} upload record(s) still need office review or attachment.`,
    count: pendingUploads.length,
    scope: 'uploads',
    items: pendingUploads
  });
  return alerts;
}

function normalizeAlertFeed(alerts) {
  const fallback = buildFallbackAlerts();
  const byTitle = new Map(fallback.map(item => [String(item.title || '').toLowerCase(), item]));
  return (alerts || []).map((alert, index) => {
    const title = String(alert.title || '').trim();
    const match = byTitle.get(title.toLowerCase());
    if (match) {
      return {
        ...match,
        ...alert,
        key: alert.key || match.key || `alert-${index}`,
        scope: alert.scope || match.scope,
        items: Array.isArray(alert.items) && alert.items.length ? alert.items : (match.items || [])
      };
    }
    return {
      ...alert,
      key: alert.key || `alert-${index}`,
      scope: alert.scope || 'records',
      items: Array.isArray(alert.items) ? alert.items : []
    };
  });
}

function liveAlerts() {
  const normalized = normalizeAlertFeed(state.alerts || []);
  return normalized.length ? normalized : buildFallbackAlerts();
}

function layout(content) {
  const dashboardCounts = state.dashboard?.counts || {};
  const counts = {
    employees: dashboardCounts.employees ?? state.workers.length,
    activeWorkers: dashboardCounts.activeWorkers ?? state.workers.filter(w => (w.employmentStatus || 'Active') === 'Active').length,
    inactiveWorkers: dashboardCounts.inactiveWorkers ?? state.workers.filter(w => (w.employmentStatus || 'Active') === 'Inactive').length,
    terminatedWorkers: dashboardCounts.terminatedWorkers ?? state.workers.filter(w => w.employmentStatus === 'Terminated').length,
    archivedWorkers: dashboardCounts.archivedWorkers ?? state.workers.filter(w => w.employmentStatus === 'Archived').length,
    activeCerts: dashboardCounts.activeCerts ?? 0,
    expiring30: dashboardCounts.expiring30 ?? 0,
    needsAttention: dashboardCounts.needsAttention ?? 0,
    bloodworkDue: dashboardCounts.bloodworkDue ?? 0,
    totalJobs: dashboardCounts.totalJobs ?? state.jobs.length,
    activeJobs: dashboardCounts.activeJobs ?? state.jobs.filter(j => j.stage === 'Active').length,
    jobsNeedingReview: dashboardCounts.jobsNeedingReview ?? state.jobs.filter(j => j.stage === 'Needs Review').length
  };
  const navItems = [
    ['dashboard', 'Dashboard'],
    ['employees', 'Employees'],
    ['jobs', 'Jobs'],
    ['certs', 'Certs'],
    ['bloodwork', 'Bloodwork'],
    ['alerts', 'Alerts'],
    ['uploads', 'Uploads'],
    ['access', 'Portal Access'],
    ['history', 'History Log'],
    ['reports', 'Reports'],
    ['admin', 'Admin']
  ];
  const visibleNav = navItems.filter(([id]) => {
    if (state.user?.role === 'PM') return ['dashboard','employees','jobs','certs','alerts','uploads','history','reports'].includes(id);
    if (state.user?.role === 'Office') return ['dashboard','employees','jobs','certs','bloodwork','alerts','uploads','history','reports'].includes(id);
    if (state.user?.role === 'Admin') return true;
    return id !== 'access' && id !== 'admin';
  });
  return `
    <div class="container">
      <div class="hero">
        <div class="hero-top">
          <div>
                        <h1 style="margin:10px 0 0;font-size:34px;">JAGD Construction Cert Portal</h1>
            <div class="sub" style="color:#cbd5e1;">Private internal portal for worker certifications, bloodwork tracking, uploads, reports, and job readiness.</div>
          </div>
          <div class="right-note">
            <span class="pill">Role: ${state.user?.role || '-'}</span>
            <button class="btn light" id="logoutBtn">Log Out</button>
          </div>
        </div>
        <div class="snapshot">
          <div class="small" style="color:#cbd5e1;">Executive Snapshot</div>
          <div class="sub" style="color:#cbd5e1;">This version includes real imported worker names, 30 current jobs, job requirement editing, add worker/add job, and a working backend.</div>
        </div>
        <div class="nav">
          ${visibleNav.map(([id,label]) => `<button class="${state.view===id?'active':''}" data-nav="${id}">${label}</button>`).join('')}
        </div>
        <div class="stats">
          <div class="stat"><div class="label">Total Records</div><div class="value">${counts.employees}</div></div>
          <div class="stat"><div class="label">Active Workers</div><div class="value">${counts.activeWorkers}</div></div>
          <div class="stat"><div class="label">Inactive Workers</div><div class="value">${counts.inactiveWorkers}</div></div>
          <div class="stat"><div class="label">Terminated</div><div class="value">${counts.terminatedWorkers || 0}</div></div>
          <div class="stat"><div class="label">Archived</div><div class="value">${counts.archivedWorkers || 0}</div></div>
          <div class="stat"><div class="label">Expiring 30 Days</div><div class="value">${counts.expiring30}</div></div>
          <div class="stat"><div class="label">Needs Attention</div><div class="value">${counts.needsAttention}</div></div>
          <div class="stat"><div class="label">Total Jobs</div><div class="value">${counts.totalJobs}</div></div>
          <div class="stat"><div class="label">Active Jobs</div><div class="value">${counts.activeJobs}</div></div>
          <div class="stat"><div class="label">Jobs Needing Review</div><div class="value">${counts.jobsNeedingReview}</div></div>
        </div>
      </div>
      <div class="section" id="view-start">${content}</div>
    </div>
    ${renderWorkerModal()}
    ${renderJobModal()}
    ${renderJobEditModal()}
    ${renderAddCertDropdownModal()}
  `;
}

function loginView() {
  return `
  <div class="login-shell">
    <div class="login-card">
      <div class="hero">
        <div class="hero-top">
          <div>
            
            <h1 style="margin:10px 0 0;font-size:34px;">JAGD Construction Cert Portal</h1>
            <div class="sub" style="color:#cbd5e1;">Private internal portal for certifications, bloodwork, worker readiness, uploads, reports, and job qualification tracking.</div>
          </div>
          <div class="pill">portal.jagdconstruction.com/certs</div>
        </div>
        <div class="stats">
          ${(state.dashboard?.executiveSummary || []).map(item => `<div class="stat"><div class="label">${item.label}</div><div style="margin-top:6px;font-weight:700;">${item.value}</div></div>`).join('')}
        </div>
      </div>
      <div class="grid grid-2 section">
        <div class="card">
          <div class="card-header"><div><h2>Portal Login</h2><div class="sub">Use office/admin test logins below to open the portal. Worker logins stay tied to each worker profile.</div></div></div>
          <div class="section grid grid-2">
            <div><div class="small muted">Username</div><input id="loginUsername" value="admin" /></div>
            <div><div class="small muted">Password</div><input id="loginPassword" type="password" value="admin123" /></div>
          </div>
          <div class="section button-row">
            <button class="btn dark" id="loginBtn">Enter Portal</button>
            <div class="pill">admin/admin123 · office/office123 · pm/pm123</div>
          </div>
          <div id="loginError" class="small" style="color:#991b1b;margin-top:10px;"></div>
        </div>
        <div class="card">
          <h2>Why This Helps Ownership</h2>
          <div class="section">
            ${[
              'See who is ready for each active job in one click',
              'Reduce missed renewals and surprise expired certifications',
              'Track BLL / ZPP separately from normal training items',
              'Keep uploads, reports, and worker history in one protected portal'
            ].map(x => `<div class="tag">${x}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}



function canManageBloodwork() {
  return ['Admin', 'Office'].includes(String(state.user?.role || ''));
}

function canDeleteRecords() {
  return String(state.user?.role || '') === 'Admin';
}

function canManageJobs() {
  return String(state.user?.role || '') === 'Admin';
}

function canManageWorkers() {
  return String(state.user?.role || '') === 'Admin';
}

function canViewAdmin() {
  return String(state.user?.role || '') === 'Admin';
}

function currentJobDisplay(worker) {
  if ((worker.employmentStatus || 'Active') !== 'Active') return '-';
  return worker.currentJob || worker.assignedJob || (Array.isArray(worker.jobsReady) && worker.jobsReady.length ? worker.jobsReady[0] : worker.crew || '-');
}

function workerTable(items, options = {}) {
  if (!items.length) return `<div class="card">No workers found.</div>`;
  const showEmploymentToggle = !!options.showEmploymentToggle && canManageWorkers();
  const jobOptions = (state.jobs || []).map(job => `<option value="${escapeHtml(job.name)}">${job.name}</option>`).join('');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Worker</th><th>Current Job</th><th>Employment</th><th>Compliance</th><th>Next Issue</th><th>Action</th></tr></thead>
        <tbody>
          ${items.map(w => {
            const employment = w.employmentStatus || 'Active';
            const currentJob = currentJobDisplay(w);
            return `<tr>
              <td>${w.name}</td>
              <td>
                ${showEmploymentToggle ? `
                  <select data-set-current-job="${w.id}" ${employment !== 'Active' ? 'disabled' : ''}>
                    <option value="">Select Job</option>
                    ${(state.jobs || []).map(job => `<option value="${escapeHtml(job.name)}" ${currentJob === job.name ? 'selected' : ''}>${job.name}</option>`).join('')}
                  </select>
                ` : currentJob}
              </td>
              <td>
                <div>${badge(employment)}</div>
                ${showEmploymentToggle ? `
                  <select data-set-employment="${w.id}" style="margin-top:8px;min-width:140px;">
                    ${['Active','Inactive','Terminated','Archived'].map(status => `<option value="${status}" ${employment===status ? 'selected' : ''}>${status}</option>`).join('')}
                  </select>
                ` : ''}
              </td>
              <td>${badge(w.status)}</td>
              <td>${w.nextIssue || '-'}</td>
              <td><span class="link" data-open-worker="${w.id}">Open Profile</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}


function certWorkerTable(items) {
  if (!items || !items.length) return `<div class="card">No workers found for this certification.</div>`;
  return workerTable(items);
}


function alertItemsTable(alert) {
  if (!alert || !(alert.items || []).length) return `<div class="card">No records found for this alert.</div>`;
  if (alert.scope === 'workers') {
    return workerTable(alert.items);
  }
  if (alert.scope === 'jobs') {
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Job</th><th>Owner</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${alert.items.map(job => `<tr>
              <td>${job.name}</td>
              <td>${job.owner || '-'}</td>
              <td>${badge(job.stage || 'Needs Review')}</td>
              <td><span class="link" data-edit-job="${job.id}">Open Job</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  if (alert.scope === 'uploads') {
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>File</th><th>Worker</th><th>Certification</th><th>Status</th><th>Expires</th></tr></thead>
          <tbody>
            ${alert.items.map(u => `<tr>
              <td>${u.file}</td>
              <td>${u.worker || 'Unassigned'}</td>
              <td>${u.certName || '-'}</td>
              <td>${badge(u.status || 'Needs Review')}</td>
              <td>${u.expirationDate || '-'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  return `<div class="card">No records found for this alert.</div>`;
}

function dashboardView() {
  const job = state.jobs.find(j => j.id === state.selectedJobId) || state.jobs[0];
  const buckets = job?.buckets || { qualified: [], expiring: [], notQualified: [] };
  const selectedItems = buckets[state.selectedBucket] || [];
  return layout(`
    <div class="card section">
      <div class="card-header"><div><h2>Job Qualification Center</h2><div class="sub">Baseline plus job-specific requirements determine who is ready.</div></div></div>
      <div class="section">
        <select id="jobSelector">${state.jobs.map(j => `<option value="${j.id}" ${j.id===state.selectedJobId?'selected':''}>${j.name} · ${j.owner}</option>`).join('')}</select>
      </div>
      ${job ? `
        <div class="grid grid-2 section">
          <div class="card" style="background:#f8fafc;box-shadow:none;">
            <div class="flex space-between wrap"><strong>Selected Job</strong>${badge(job.stage)}</div>
            <div class="small muted" style="margin-top:8px;">${job.notes || ''}</div>
            <div class="section"><div class="small muted">Requirements</div>${job.requirements.map(r=>`<span class="tag dark">${r}</span>`).join('')}</div>
            <div class="section"><span class="link" id="editSelectedJob">Edit job requirements</span></div>
          </div>
          <div class="kpi-grid">
            <div class="kpi green"><h3>Qualified</h3><div class="big">${buckets.qualified.length}</div><div class="link" data-bucket="qualified">Open list</div></div>
            <div class="kpi yellow"><h3>Expiring Soon</h3><div class="big">${buckets.expiring.length}</div><div class="link" data-bucket="expiring">Open list</div></div>
            <div class="kpi red"><h3>Not Qualified</h3><div class="big">${buckets.notQualified.length}</div><div class="link" data-bucket="notQualified">Open list</div></div>
          </div>
        </div>
      ` : ''}
    </div>

    <div class="card section" id="job-workers-section">
      <div class="card-header"><div><h2>${state.selectedBucket === 'qualified' ? 'Qualified' : state.selectedBucket === 'expiring' ? 'Expiring Soon' : 'Not Qualified'} Workers</h2><div class="sub">Click a worker to open the full profile.</div></div></div>
      <div class="section">${workerTable(selectedItems)}</div>
    </div>

    <div class="grid grid-2 section">
      <div class="card">
        <div class="card-header"><div><h2>Executive Overview</h2><div class="sub">High-level snapshot before drilling into details.</div></div></div>
        <div class="kpi-grid section">
          ${(state.dashboard?.executiveSummary || []).map(item => `<div class="kpi" style="background:#f8fafc;"><div class="small muted">${item.label}</div><div style="margin-top:10px;font-weight:700;">${item.value}</div></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div><h2>Audit Log</h2><div class="sub">Recent actions inside the portal.</div></div></div>
        <div class="section">
          ${(state.auditLog || []).slice(0,8).map(row => `<div class="tag"><strong>${formatAuditTime(row.time)}</strong> — ${escapeHtml(row.action || '-')} · ${escapeHtml(row.actorName || row.actorUsername || 'System')}</div>`).join('')}
        </div>
      </div>
    </div>
  `);
}

function employeesView() {
  return layout(`
    <div class="card">
      <div class="card-header">
        <div><h2>Employees</h2><div class="sub">Search the full imported roster and open worker profiles.</div></div>
        ${canManageWorkers() ? '<button class="btn dark" id="addWorkerBtn">Add Worker</button>' : ''}
      </div>
      <div class="section filter-row">
        ${[['all','All Workers'],['active','Active'],['inactive','Inactive'],['terminated','Terminated'],['archived','Archived'],['qualified','Qualified'],['expiring','Expiring Soon'],['attention','Needs Attention'],['bloodwork','Has Bloodwork']].map(([id,label])=>`<button class="${state.employeeFilter===id?'active':''}" data-worker-filter="${id}">${label}</button>`).join('')}
      </div>
      <div class="section inline-input"><span>🔎</span><input id="employeeSearch" value="${escapeHtml(state.employeeSearch)}" placeholder="Search workers by name or current job..." /></div>
      <div class="section">${workerTable(state.workers, { showEmploymentToggle: true })}</div>
    </div>
    ${selectedWorkerSection()}
  `);
}

function selectedWorkerSection() {
  const worker = state.workers.find(w => w.id === state.selectedWorkerId) || state.workers[0];
  if (!worker) return '';
  return `
    <div class="grid grid-2 section" id="selected-worker-profile">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="small muted">Worker Profile</div>
            <div style="font-size:32px;font-weight:800;line-height:1.1;margin-top:6px;">${worker.name}</div>
          </div>
          <div>${badge(worker.status)}</div>
        </div>
        <div class="grid grid-3 section">
          <div class="card" style="background:#f8fafc;box-shadow:none;"><div class="small muted">Current Job</div>
          <div style="margin-top:6px;">
            <select id="profileCurrentJob" ${((worker.employmentStatus || 'Active') !== 'Active' || !canManageWorkers()) ? 'disabled' : ''}>
              <option value="">Select Job</option>
              ${state.jobs.map(job => `<option value="${escapeHtml(job.name)}" ${currentJobDisplay(worker) === job.name ? 'selected' : ''}>${job.name}</option>`).join('')}
            </select>
          </div></div>
          <div class="card" style="background:#f8fafc;box-shadow:none;"><div class="small muted">Employment</div><div style="margin-top:6px;">${badge(worker.employmentStatus || 'Active')}</div></div>
          <div class="card" style="background:#f8fafc;box-shadow:none;"><div class="small muted">Next Issue</div><div style="margin-top:6px;font-weight:700;">${worker.nextIssue}</div></div>
        </div>
        <div class="card section" style="background:#f8fafc;box-shadow:none;">
          <div class="small muted">Employment Status</div>
          <div style="margin-top:10px;">
            ${canManageWorkers() ? `
              <select data-set-employment="${worker.id}">
                ${['Active','Inactive','Terminated','Archived'].map(status => `<option value="${status}" ${(worker.employmentStatus || 'Active')===status ? 'selected' : ''}>${status}</option>`).join('')}
              </select>
            ` : '<span class="small muted">Admin only</span>'}
          </div>
          <div class="small muted" style="margin-top:14px;">Worker Portal Login</div>
          <div style="margin-top:6px;font-weight:700;">${worker.portalUsername || '-'} / ${worker.portalPassword || 'worker123'}</div>
          <div class="small muted" style="margin-top:14px;">Worker Email Alerts</div>
          <div class="grid grid-2" style="margin-top:8px;">
            <input id="profileWorkerEmail" value="${escapeHtml(worker.email || '')}" placeholder="worker@email.com" ${!canManageWorkers() ? 'disabled' : ''} />
            ${canManageWorkers() ? '<button class="btn dark" id="saveWorkerEmailBtn">Save Email</button>' : '<div class="small muted" style="display:flex;align-items:center;">Admin only</div>'}
          </div>
          <div class="small muted" style="margin-top:8px;">Only active workers with an email address can receive automatic worker alerts.</div>
        </div>
        <div class="section small muted">Use Add Certification to Dropdown when office receives a cert that is missing from the current certification list.</div>
        <div id="workerProfileActionStatus" class="small muted section"></div>
      <div class="section table-wrap">
          <table>
            <thead><tr><th>Certification</th><th>Status</th><th>Date</th><th>Document</th><th>Action</th></tr></thead>
            <tbody>
              ${worker.certifications.map(c=>`<tr><td>${c.name}</td><td>${badge(c.status)}</td><td>${c.date || '-'}</td><td>${String(c.document || '').startsWith('/uploads/') ? `<a href="${c.document}" target="_blank" class="link">Open File</a>` : (c.document || 'On file')}</td><td>${canDeleteRecords() ? `<button class="btn light" data-delete-cert="${worker.id}|${encodeURIComponent(c.name)}" style="padding:8px 12px;">Delete</button>` : '<span class="small muted">Admin only</span>'}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-header">
            <div>
              <h2>Upload Certification</h2>
              <div class="sub">Open the intake queue with this worker selected for the next upload.</div>
            </div>
          </div>
          <div class="section">
            <div class="tag"><strong>${worker.name}</strong> · ${worker.portalUsername || 'Worker portal active'}</div>
          </div>
          <div class="button-row section">
            <button class="btn dark" data-open-office-upload="${worker.id}">Open Upload Intake Queue</button>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <div><h2>Bloodwork</h2><div class="sub">Manage bloodwork records for this worker.</div></div>
            ${canManageBloodwork() ? `<button class="btn dark" data-open-bloodwork-add="${worker.id}">Add Bloodwork</button>` : ''}
          </div>
          <div class="section">${worker.bloodwork.length ? worker.bloodwork.map((b, idx)=>`<div class="tag" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;"><span>${b.testDate} · BLL ${b.bll} · ZPP ${b.zpp} · Next Due ${b.nextDue} · ${b.status}</span><span style="display:flex;gap:8px;flex-wrap:wrap;">${canManageBloodwork() ? `<button class="btn light" data-edit-bloodwork="${worker.id}|${idx}" style="padding:6px 10px;">Edit</button>` : ''}${canDeleteRecords() ? `<button class="btn light" data-delete-bloodwork="${worker.id}|${idx}" style="padding:6px 10px;">Delete</button>` : ''}${!canManageBloodwork() && !canDeleteRecords() ? '<span class="small muted">View only</span>' : ''}</span></div>`).join('') : '<div class="muted">No bloodwork records.</div>'}</div>
        </div>
        <div class="card">
          <h2>Driver License</h2>
          <div class="section small">Class: <strong>${worker.driverLicense.class}</strong><br/>State: <strong>${worker.driverLicense.state || '-'}</strong><br/>Number: <strong>${worker.driverLicense.number}</strong><br/>Expires: <strong>${worker.driverLicense.expires}</strong><br/>Status: ${badge(worker.driverLicense.status)}</div>
        </div>
      </div>
      <div class="section" style="display:flex;justify-content:center;">
        <button class="btn light" data-back-to-top="employees-top">Back to Top</button>
      </div>
    </div>`;
}


function workerPortalView() {
  const payload = state.workerPortal;
  const worker = payload?.worker;
  if (!worker) {
    return layout(`<div class="card"><h2>Worker Portal</h2><div class="muted">Loading your records...</div></div>`);
  }
  return `
    <div class="container">
      <div class="hero">
        <div class="hero-top">
          <div>
            <h1 style="margin:10px 0 0;font-size:34px;">JAGD Worker Portal</h1>
            <div class="sub" style="color:#cbd5e1;">View your own certifications, bloodwork, alerts, and uploads.</div>
          </div>
          <div class="right-note">
            <span class="pill">${worker.name}</span>
            <button class="btn light" id="logoutBtn">Log Out</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="grid grid-2">
          <div class="card">
            <div class="card-header"><div><h2>My Certifications</h2><div class="sub">Your current certification records.</div></div></div>
            <div class="section table-wrap">
              <table>
                <thead><tr><th>Certification</th><th>Status</th><th>Expiration</th><th>Document</th></tr></thead>
                <tbody>
                  ${(worker.certifications || []).map(c => `<tr><td>${c.name}</td><td>${badge(c.status)}</td><td>${c.date || '-'}</td><td>${String(c.document || '').startsWith('/uploads/') ? `<a href="${c.document}" target="_blank" class="link">Open File</a>` : (c.document || 'On file')}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div><h2>Upload My Certification</h2><div class="sub">Uploads go into the office review queue. Choose the certification and file before submitting.</div></div></div>
            <div class="section grid grid-2">
              <input id="workerUploadFileName" placeholder="Record name (example: Fit_Test.pdf)" />
              <input id="workerUploadFilePicker" type="file" accept=".pdf,image/*" />
              <div>
                <div class="small muted" style="margin-bottom:6px;">Certification</div>
                <select id="workerUploadCertName">
                  <option value="">Select certification</option>
                  ${((state.certs || [])).map(cert => `<option value="${escapeHtml(cert.name)}">${cert.name}</option>`).join('')}
                </select>
              </div>
              <div>
                <div class="small muted" style="margin-bottom:6px;">Expiration Date</div>
                <input id="workerUploadExpirationDate" type="date" />
              </div>
              <input id="workerUploadNotes" placeholder="Notes for office review (optional)" />
            </div>
            <div class="section button-row">
              <button class="btn dark" id="workerUploadBtn">Submit Certification Upload</button>
              <div id="workerUploadStatus" class="small muted"></div>
            </div>
          </div>
        </div>

        <div class="grid grid-2 section">
          <div class="card">
            <div class="card-header"><div><h2>My Bloodwork</h2><div class="sub">Your current bloodwork records.</div></div></div>
            <div class="section">${(worker.bloodwork || []).length ? worker.bloodwork.map(b => `<div class="tag">${b.testDate} · BLL ${b.bll} · ZPP ${b.zpp} · Next Due ${b.nextDue} · ${b.status}</div>`).join('') : '<div class="muted">No bloodwork records.</div>'}</div>
          </div>
          <div class="card">
            <div class="card-header"><div><h2>My Alerts</h2><div class="sub">Only your own records show here.</div></div></div>
            <div class="section">${(payload.alerts || []).length ? payload.alerts.map(a => `<div class="tag"><strong>${a.title}</strong>: ${a.detail}</div>`).join('') : '<div class="muted">No active alerts right now.</div>'}</div>
          </div>
        </div>

        <div class="card section">
          <div class="card-header"><div><h2>My Uploaded Records</h2><div class="sub">Files you submitted into the review queue.</div></div></div>
          <div class="section">${(payload.uploads || []).length ? payload.uploads.map(u => `<div class="tag"><strong>${u.file}</strong> · ${u.certName || '-'} · ${u.status}${u.expirationDate ? ` · Expires ${u.expirationDate}` : ''}</div>`).join('') : '<div class="muted">No uploads yet.</div>'}</div>
        </div>
      </div>
    </div>`;
}

function jobsView() {
  return layout(`
    <div class="card">
      <div class="card-header"><div><h2>Jobs</h2><div class="sub">Add jobs and define what certifications are required.</div></div>${canManageJobs() ? '<button class="btn dark" id="addJobBtn">Add Job</button>' : ''}</div>
      <div class="section inline-input"><span>🔎</span><input id="jobSearch" value="${escapeHtml(state.jobSearch)}" placeholder="Search jobs or owner..." /></div>
      <div class="section grid grid-3">
        ${state.jobs.map(job=>`<div class="card" style="background:${job.id===state.selectedJobId?'#0f172a':'#f8fafc'};color:${job.id===state.selectedJobId?'#fff':'#0f172a'};box-shadow:none;">
          <div class="flex space-between wrap"><strong>${job.name}</strong>${badge(job.stage)}</div>
          <div class="small ${job.id===state.selectedJobId?'':'muted'}" style="margin-top:8px;">${job.owner}</div>
          <div class="small ${job.id===state.selectedJobId?'':'muted'}" style="margin-top:8px;">${job.notes}</div>
          <div class="section">
            ${(job.requirements||[]).slice(0,5).map(r=>`<span class="tag ${job.id===state.selectedJobId?'dark':''}">${r}</span>`).join('')}
          </div>
          <div class="button-row section">
            <button class="btn ${job.id===state.selectedJobId?'light':'dark'}" data-select-job="${job.id}">Open</button>
            ${canManageJobs() ? `<button class="btn light" data-edit-job="${job.id}">Edit</button>` : ''}
          </div>
        </div>`).join('')}
      </div>
    </div>
    ${state.selectedJobId ? `
      <div class="card section">
        <div class="card-header"><div><h2>Selected Job Readiness</h2><div class="sub">Open the lists below to review active workers only.</div></div></div>
        <div class="section">
          <div class="button-row">
            <button class="btn ${state.selectedBucket==='qualified'?'dark':'light'}" data-bucket="qualified">Qualified (${(state.jobs.find(j => j.id === state.selectedJobId)?.buckets?.qualified || []).length})</button>
            <button class="btn ${state.selectedBucket==='expiring'?'dark':'light'}" data-bucket="expiring">Expiring (${(state.jobs.find(j => j.id === state.selectedJobId)?.buckets?.expiring || []).length})</button>
            <button class="btn ${state.selectedBucket==='notQualified'?'dark':'light'}" data-bucket="notQualified">Not Qualified (${(state.jobs.find(j => j.id === state.selectedJobId)?.buckets?.notQualified || []).length})</button>
            ${canManageJobs() ? '<button class="btn light" id="editSelectedJob">Edit Requirements</button>' : ''}
          </div>
        </div>
        <div class="section">${workerTable((state.jobs.find(j => j.id === state.selectedJobId)?.buckets?.[state.selectedBucket]) || [])}</div>
      </div>
    ` : ''}
  `);
}


function certsView() {
  const selectedCert = state.certs.find(cert => cert.name === state.selectedCertName) || state.certs[0] || null;
  const scopeMap = {
    'active-good': selectedCert?.activeGoodWorkerList || selectedCert?.activeReadyWorkerList || [],
    'active-attention': selectedCert?.activeNeedsAttentionWorkerList || selectedCert?.activeAttentionWorkerList || [],
    'total-ready': selectedCert?.totalReadyWorkerList || [],
    'total-attention': selectedCert?.totalAttentionWorkerList || []
  };
  const selectedItems = selectedCert ? (scopeMap[state.selectedCertScope] || []) : [];
  return layout(`
    <div class="card">
      <div class="card-header">
        <div><h2>Certs</h2><div class="sub">Built from the worker summary sheet so office can see every tracked certification in one place.</div></div>
        <div class="right-note">
          <button class="btn dark" data-open-cert-upload="">Add / Upload Employee Certification</button>
          ${String(state.user?.role || '') === 'Admin' ? '<button class="btn light" id="openAddCertDropdownBtn">Add New Cert to Dropdown</button>' : ''}
          <div class="pill">${escapeHtml(state.certsSource || 'Worker Summary Sheet 2026.xlsx')}</div>
        </div>
      </div>
      ${String(state.user?.role || '') === 'Admin' ? `<div class="section">${certificationRulesCard()}</div>` : ''}
      <div class="section table-wrap">
        <table>
          <thead><tr><th>Certification</th><th>Active Good</th><th>Active Needs Attention</th><th>Required By Jobs</th><th>Aliases / Source Names</th></tr></thead>
          <tbody>
            ${state.certs.map(cert => `
              <tr>
                <td><span class="link" data-cert-name="${escapeHtml(cert.name)}" data-cert-scope="active-good"><strong>${cert.name}</strong></span></td>
                <td><span class="link" data-cert-name="${escapeHtml(cert.name)}" data-cert-scope="active-good">${cert.activeGood ?? 0}</span></td>
                <td><span class="link" data-cert-name="${escapeHtml(cert.name)}" data-cert-scope="active-attention">${cert.activeNeedsAttention ?? 0}</span></td>
                <td>${cert.jobsRequired.length ? cert.jobsRequired.map(j => `<span class="tag">${j}</span>`).join('') : '<span class="muted">No jobs yet</span>'}</td>
                <td>${(cert.aliases || []).map(a => `<span class="tag">${a}</span>`).join('')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ${selectedCert ? `
      <div class="card section" id="cert-worker-list">
        <div class="card-header">
          <div><h2>${selectedCert.name}</h2><div class="sub">Click a worker to open the full profile.</div></div>
          <div class="right-note">
            <button class="btn dark" data-open-cert-upload="${escapeHtml(selectedCert.name)}">Upload This Certification</button>
            ${(selectedCert.isDynamic && String(state.user?.role || '') === 'Admin') ? `<button class="btn light" data-delete-dropdown-cert="${escapeHtml(selectedCert.name)}">Delete from Dropdown</button>` : ''}
            <div class="button-row cert-scope-grid">
            <button class="btn ${state.selectedCertScope==='active-good'?'dark':'light'}" data-cert-name="${escapeHtml(selectedCert.name)}" data-cert-scope="active-good">Active Good (${selectedCert.activeGood ?? 0})</button>
            <button class="btn ${state.selectedCertScope==='active-attention'?'dark':'light'}" data-cert-name="${escapeHtml(selectedCert.name)}" data-cert-scope="active-attention">Active Needs Attention (${selectedCert.activeNeedsAttention ?? 0})</button>
          </div>
          </div>
        </div>
        <div class="section">${certWorkerTable(selectedItems)}</div>
      </div>
    ` : ''}
  `);
}

function bloodworkView() {
  return layout(`
    <div class="card" id="bloodwork-add-form">
      <div class="card-header">
        <div><h2>Bloodwork Management</h2><div class="sub">Track BLL / ZPP cycles and identify who needs action.</div></div>
        ${canManageBloodwork() ? '<button class="btn dark" id="saveBloodworkBtn">Add Bloodwork</button>' : ''}
      </div>
      <div class="grid grid-3 section">
        <div>
          <div class="small muted" style="margin-bottom:6px;">Worker</div>
          <select id="bloodworkWorkerId">
            <option value="">Select worker</option>
            ${state.workers.map(worker => `<option value="${worker.id}" ${String(state.selectedWorkerId || '') === String(worker.id) ? 'selected' : ''}>${worker.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px;">Test Date</div>
          <input id="bloodworkTestDate" type="date" />
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px;">Next Due</div>
          <input id="bloodworkNextDue" type="date" />
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px;">BLL</div>
          <input id="bloodworkBLL" placeholder="BLL value" />
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px;">ZPP</div>
          <input id="bloodworkZPP" placeholder="ZPP value" />
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px;">Status</div>
          <select id="bloodworkStatus">
            ${['Current','Due Soon','Overdue','Needs Attention'].map(status => `<option value="${status}">${status}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="bloodworkAddStatus" class="small muted section">${!canManageBloodwork() ? 'PM can view bloodwork here but cannot add or edit it.' : ''}</div>
    </div>

    <div class="card section">
      <div class="card-header"><div><h2>Bloodwork Records</h2><div class="sub">Edit or delete existing bloodwork records below.</div></div></div>
      <div id="bloodworkActionStatus" class="small muted section"></div>
      <div class="section table-wrap">
        <table>
          <thead><tr><th>Worker</th><th>Test Date</th><th>Next Due</th><th>BLL</th><th>ZPP</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${state.bloodwork.map(row=>`<tr><td>${row.workerName}</td><td>${row.testDate}</td><td>${row.nextDue}</td><td>${row.bll}</td><td>${row.zpp}</td><td>${badge(row.status)}</td><td><div class="button-row">${canManageBloodwork() ? `<button class="btn light" data-edit-bloodwork="${row.workerId}|${row.rowIndex}" style="padding:8px 12px;">Edit</button>` : ''}${canDeleteRecords() ? `<button class="btn light" data-delete-bloodwork="${row.workerId}|${row.rowIndex}" style="padding:8px 12px;">Delete</button>` : ''}${!canManageBloodwork() && !canDeleteRecords() ? '<span class="small muted">View only</span>' : ''}</div></td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `);
}



function alertsView() {
  const alerts = liveAlerts();
  const selectedAlert = alerts.find(a => a.key === state.selectedAlertKey) || null;
  const selectedCount = selectedAlert ? (selectedAlert.count || (selectedAlert.items || []).length || 0) : 0;
  return layout(`
    <div class="card" id="alerts-top">
      <div class="card-header">
        <div>
          <h2>Alerts</h2>
          <div class="sub">Current portal reminders and action items. This is the main office action center.</div>
        </div>
        <div class="pill">${alerts.length} active</div>
      </div>
      <div class="section" style="display:flex;gap:10px;flex-wrap:wrap;">
        <div class="tag"><strong>Total Alerts</strong>: ${alerts.length}</div>
        <div class="tag"><strong>Selected Alert Items</strong>: ${selectedCount}</div>
      </div>
      <div class="section">
        ${alerts.length ? alerts.map(item => `
          <div class="card" style="background:${item.type==='danger' ? '#fff1f2' : item.type==='warning' ? '#fffbeb' : '#eff6ff'}; box-shadow:none; margin-bottom:12px; border:1px solid rgba(15,23,42,.06);">
            <div class="flex space-between wrap" style="align-items:flex-start;">
              <div>
                <div style="font-weight:700;font-size:16px;">${item.title}</div>
                <div class="small muted" style="margin-top:8px;">${item.detail}</div>
              </div>
              <div class="tag dark">${item.count || (item.items || []).length || 0} item(s)</div>
            </div>
            <div class="button-row" style="margin-top:12px;">
              <button class="btn ${selectedAlert && selectedAlert.key===item.key ? 'dark' : 'light'}" data-alert-open="${item.key}">View List</button>
              ${selectedAlert && selectedAlert.key===item.key ? `<span class="tag">Selected</span>` : ''}
            </div>
          </div>
        `).join('') : '<div class="muted">No active alerts right now.</div>'}
      </div>
    </div>

    <div class="card section" id="alert-detail-section">
      <div class="card-header">
        <div>
          <h2>${selectedAlert ? selectedAlert.title : 'Alert Detail'}</h2>
          <div class="sub">${selectedAlert ? 'Review the exact records behind this alert and use the actions below to move through the list.' : 'Click View List above to open the records for that alert.'}</div>
        </div>
        <button class="btn light" id="alertBackToTopBtn">Back to Top</button>
      </div>
      <div class="section" style="display:flex;gap:10px;flex-wrap:wrap;">
        ${selectedAlert ? `<div class="tag"><strong>Scope</strong>: ${selectedAlert.scope || 'records'}</div><div class="tag"><strong>Items</strong>: ${selectedCount}</div>` : ''}
      </div>
      <div class="section">${selectedAlert ? alertItemsTable(selectedAlert) : '<div class="muted">No alert selected.</div>'}</div>
      <div class="section">
        <h3 style="margin:0 0 10px;">Reminder Rules</h3>
        ${(state.admin?.reminderRules || []).length ? (state.admin?.reminderRules || []).map(r=>`<div class="tag"><strong>${r.label}</strong>: ${r.value}</div>`).join('') : '<div class="muted">No reminder rules configured.</div>'}
      </div>
    </div>
  `);
}

function uploadsView() {
  const certOptions = (state.certs || []).map(cert => `<option value="${escapeHtml(cert.name)}">${cert.name}</option>`).join('');
  return layout(`
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><div><h2>Upload Intake Queue</h2><div class="sub">Create upload records and attach them to the right worker.</div></div></div>
        <div class="section">
          <div class="grid grid-2">
            <input id="uploadFileName" placeholder="Record name (example: Anthony_FitTest.pdf)" />
            <input id="uploadFilePicker" type="file" accept=".pdf,image/*" />
            <select id="uploadWorkerId">
              <option value="">Select worker</option>
              ${state.workers.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
            </select>
            <div><div class="small muted" style="margin-bottom:6px;">Expiration Date</div><input id="uploadExpirationDate" type="date" /></div>
            <div>
              <div class="small muted" style="margin-bottom:6px;">Certification</div>
              <select id="uploadCertName">
                <option value="">Select certification</option>
                ${certOptions}
              </select>
            </div>
            <select id="uploadStatus">
              <option>Needs Review</option>
              <option>Imported</option>
              <option>Attached</option>
            </select>
            <input id="uploadNotes" placeholder="Notes" />
          </div>
          <div class="small muted" style="margin-top:10px;">Office note: use the date field for the certification expiration date. If the cert is missing from the dropdown, leave it blank and use Record Name as the certification name.</div>
          <div class="section"><button class="btn dark" id="saveUploadBtn">Add Upload Record</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div><h2>Current Upload Records</h2><div class="sub">This is the office intake queue.</div></div><div class="pill">${state.uploads.length} record(s)</div></div>
        <div id="uploadsActionStatus" class="small muted section"></div>
        <div class="section">
          ${state.uploads.length ? state.uploads.map(u=>`
            <div class="tag">
              <strong>${u.file}</strong> · ${u.worker || 'Unassigned'}${u.certName ? ` · ${u.certName}` : ''}${u.expirationDate ? ` · Expires ${u.expirationDate}` : ''} · ${u.status}${u.originalFileName ? ` · Selected File ${u.originalFileName}` : ''}
              <span style="display:inline-flex;gap:8px;align-items:center;margin-left:10px;">
                ${u.filePath ? `<a href="${u.filePath}" target="_blank" class="link">Open File</a>` : ''}
                ${canDeleteRecords() ? `<button class="btn light" data-delete-upload="${u.id}" style="padding:8px 12px;">Delete</button>` : ''}
              </span>
            </div>`).join('') : '<div class="muted">No uploads yet.</div>'}
        </div>
      </div>
    </div>
  `);
}


function expiringWorkersReport() {
  const rows = [];
  (state.workers || []).forEach(worker => {
    (worker.certifications || []).forEach(cert => {
      const status = String(cert.status || '');
      if (status.includes('Expiring')) {
        rows.push({
          workerName: worker.name,
          certName: cert.name,
          expirationDate: cert.date || '-',
          status: cert.status || 'Expiring Soon',
          currentJob: currentJobDisplay(worker)
        });
      }
    });
  });
  return rows.sort((a, b) => String(a.expirationDate).localeCompare(String(b.expirationDate)));
}

function bloodworkDueReport() {
  return (state.bloodwork || [])
    .filter(row => {
      const status = String(row.status || '');
      return status.includes('Due') || status.includes('Overdue') || status.includes('Attention');
    })
    .map(row => ({
      workerName: row.workerName,
      testDate: row.testDate || '-',
      nextDue: row.nextDue || '-',
      bll: row.bll || '-',
      zpp: row.zpp || '-',
      status: row.status || 'Due Soon',
      currentJob: currentJobDisplay((state.workers || []).find(w => String(w.id) === String(row.workerId)) || {})
    }))
    .sort((a, b) => String(a.nextDue).localeCompare(String(b.nextDue)));
}

function missingBaselineReport() {
  const baseline = state.admin?.baselineRequirements || ['OSHA 30','Training Pack','Lead Awareness','Fit Test'];
  return (state.workers || [])
    .filter(worker => (worker.employmentStatus || 'Active') === 'Active')
    .map(worker => {
      const certNames = new Set((worker.certifications || []).map(cert => String(cert.name || '').trim().toLowerCase()));
      const missing = baseline.filter(req => !certNames.has(String(req).trim().toLowerCase()));
      return {
        workerName: worker.name,
        missing,
        currentJob: currentJobDisplay(worker),
        status: worker.status || 'Needs Attention'
      };
    })
    .filter(row => row.missing.length);
}

function selectedJobReadyReport() {
  const job = state.jobs.find(j => j.id === state.selectedJobId) || state.jobs[0] || null;
  if (!job) return { job: null, workers: [] };
  return {
    job,
    workers: (job.buckets?.qualified || []).map(worker => ({
      workerName: worker.name,
      currentJob: currentJobDisplay(worker),
      status: worker.status || 'Qualified',
      nextIssue: worker.nextIssue || '-'
    }))
  };
}

function reportsView() {
  const expiringRows = expiringWorkersReport();
  const bloodworkRows = bloodworkDueReport();
  const baselineRows = missingBaselineReport();
  const readyReport = selectedJobReadyReport();

  return layout(`
    <div class="grid grid-2">
      <div class="card">
        <h2>Reports & Exports</h2>
        <div class="section kpi-grid">
          <div class="kpi" style="background:#f8fafc;">
            <div style="font-weight:700;">Expiring in 30 Days</div>
            <div class="small muted" style="margin-top:8px;">${expiringRows.length} worker certification record(s)</div>
          </div>
          <div class="kpi" style="background:#f8fafc;">
            <div style="font-weight:700;">Job Ready Crew List</div>
            <div class="small muted" style="margin-top:8px;">${readyReport.workers.length} qualified worker(s) for selected job</div>
          </div>
          <div class="kpi" style="background:#f8fafc;">
            <div style="font-weight:700;">Bloodwork Due List</div>
            <div class="small muted" style="margin-top:8px;">${bloodworkRows.length} due or overdue bloodwork record(s)</div>
          </div>
          <div class="kpi" style="background:#f8fafc;">
            <div style="font-weight:700;">Missing Baseline Items</div>
            <div class="small muted" style="margin-top:8px;">${baselineRows.length} active worker(s) missing baseline items</div>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>Notifications Center</h2>
        <div class="section">${(state.auditLog || []).slice(0,6).map(row=>`<div class="tag">${formatAuditTime(row.time)} — ${escapeHtml(row.action || '-')}</div>`).join('')}</div>
      </div>
    </div>

    <div class="card section">
      <div class="card-header">
        <div><h2>Expiring in 30 Days</h2><div class="sub">Workers with certification records marked expiring soon.</div></div>
        <div class="pill">${expiringRows.length} row(s)</div>
      </div>
      <div class="section">
        ${expiringRows.length ? `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Certification</th><th>Expiration</th><th>Status</th><th>Current Job</th></tr></thead><tbody>
          ${expiringRows.map(row => `<tr><td>${escapeHtml(row.workerName)}</td><td>${escapeHtml(row.certName)}</td><td>${escapeHtml(row.expirationDate)}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.currentJob)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">No expiring certification records right now.</div>'}
      </div>
    </div>

    <div class="card section">
      <div class="card-header">
        <div><h2>Bloodwork Due List</h2><div class="sub">Workers with bloodwork records that are due, overdue, or need attention.</div></div>
        <div class="pill">${bloodworkRows.length} row(s)</div>
      </div>
      <div class="section">
        ${bloodworkRows.length ? `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Test Date</th><th>Next Due</th><th>BLL</th><th>ZPP</th><th>Status</th><th>Current Job</th></tr></thead><tbody>
          ${bloodworkRows.map(row => `<tr><td>${escapeHtml(row.workerName)}</td><td>${escapeHtml(row.testDate)}</td><td>${escapeHtml(row.nextDue)}</td><td>${escapeHtml(row.bll)}</td><td>${escapeHtml(row.zpp)}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.currentJob)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">No bloodwork due records right now.</div>'}
      </div>
    </div>

    <div class="card section">
      <div class="card-header">
        <div><h2>Missing Baseline Items</h2><div class="sub">Active workers missing one or more required baseline certifications.</div></div>
        <div class="pill">${baselineRows.length} row(s)</div>
      </div>
      <div class="section">
        ${baselineRows.length ? `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Missing Items</th><th>Status</th><th>Current Job</th></tr></thead><tbody>
          ${baselineRows.map(row => `<tr><td>${escapeHtml(row.workerName)}</td><td>${row.missing.map(item => `<span class="tag">${escapeHtml(item)}</span>`).join('')}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.currentJob)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">No active workers are missing baseline items right now.</div>'}
      </div>
    </div>

    <div class="card section">
      <div class="card-header">
        <div><h2>Job Ready Crew List</h2><div class="sub">Qualified workers for the currently selected job.</div></div>
        <div class="pill">${readyReport.job ? escapeHtml(readyReport.job.name) : 'No Job Selected'}</div>
      </div>
      <div class="section">
        ${state.jobs?.length ? `<select id="reportJobSelector">${state.jobs.map(job => `<option value="${job.id}" ${readyReport.job && job.id===readyReport.job.id ? 'selected' : ''}>${escapeHtml(job.name)} · ${escapeHtml(job.owner || '-')}</option>`).join('')}</select>` : ''}
      </div>
      <div class="section">
        ${readyReport.workers.length ? `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Status</th><th>Current Job</th><th>Next Issue</th></tr></thead><tbody>
          ${readyReport.workers.map(row => `<tr><td>${escapeHtml(row.workerName)}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.currentJob)}</td><td>${escapeHtml(row.nextIssue)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">No qualified workers found for the selected job.</div>'}
      </div>
    </div>
  `);
}


function workerEmailPreviewText() {
  const preview = state.workerEmailPreview || state.admin?.workerEmailPreview || {};
  const rows = preview.rows || [];
  const settings = state.admin?.emailAlerts || preview.settings || {};
  const lines = [
    'JAGD Worker Email Alert Preview',
    '',
    `Status: ${settings.workerAlertsEnabled ? 'ON' : 'OFF'}`,
    `Workers with alerts: ${preview.totalWorkersWithAlerts || 0}`,
    `Workers with valid email: ${preview.workersWithValidEmail || 0}`,
    `Ready to email now: ${preview.readyWorkerEmails || 0}`,
    `Already sent items: ${preview.alreadySentCertItems || 0}`,
    `Workers missing email: ${preview.workersMissingEmail || 0}`,
    '',
    ...(rows.length ? rows.slice(0, 20).map(row => `- ${row.workerName}: ${row.hasValidEmail ? row.email : 'MISSING EMAIL'} · ${row.summary}`) : ['- No worker email alerts right now.'])
  ];
  return lines.join('\n');
}

function workerEmailPreviewTable() {
  const preview = state.workerEmailPreview || state.admin?.workerEmailPreview || {};
  const rows = preview.rows || [];
  if (!rows.length) return '<div class="muted">No worker email alerts are currently ready.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Email</th><th>Items</th><th>Email Status</th><th>Summary</th><th>Action</th></tr></thead><tbody>
    ${rows.slice(0, 50).map(row => `<tr>
      <td>${escapeHtml(row.workerName || '-')}</td>
      <td>${row.hasValidEmail ? `<span class="badge bg-green">${escapeHtml(row.email)}</span>` : '<span class="badge bg-red">Missing Email</span>'}</td>
      <td>${row.itemCount || 0}</td>
      <td>${row.readyToSend ? '<span class="badge bg-yellow">Ready to Send</span>' : '<span class="badge bg-gray">Already Sent / Waiting</span>'}</td>
      <td>${escapeHtml(row.summary || '-')}</td>
      <td>${row.workerId ? `<span class="link" data-open-worker="${row.workerId}">Open Profile</span>` : '-'}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}


function certificationRulesTable() {
  const rules = state.certificationAlertRules || state.admin?.certificationAlertRules || [];
  if (!rules.length) return '<div class="muted">No certification alert rules are configured yet.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Certification</th><th>Enabled</th><th>Expires Every</th><th>Reminder Window</th><th>Notes</th><th>Action</th></tr></thead><tbody>
    ${rules.map((rule, index) => `<tr>
      <td>
        <strong>${escapeHtml(rule.certName || '-')}</strong>
        <div class="small muted">${(rule.aliases || []).map(alias => escapeHtml(alias)).join(', ')}</div>
      </td>
      <td>
        <select data-cert-rule-enabled="${index}">
          <option value="true" ${rule.enabled === false ? '' : 'selected'}>ON</option>
          <option value="false" ${rule.enabled === false ? 'selected' : ''}>OFF</option>
        </select>
      </td>
      <td><input data-cert-rule-expiration="${index}" type="number" min="0" max="3650" value="${Number(rule.expirationDays || 0)}" /></td>
      <td><input data-cert-rule-reminder="${index}" type="number" min="0" max="365" value="${Number(rule.reminderDays || 30)}" /></td>
      <td><input data-cert-rule-note="${index}" value="${escapeHtml(rule.note || '')}" /></td>
      <td>
        <div class="button-row">
          <button class="btn light" data-edit-cert-rule="${index}" style="padding:8px 12px;">Edit</button>
          <button class="btn light" data-delete-cert-rule="${index}" style="padding:8px 12px;">Delete</button>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function certificationRuleAddOptions() {
  const rules = state.certificationAlertRules || state.admin?.certificationAlertRules || [];
  const existing = new Set(rules.map(rule => normalizeCertName(rule.certName || '').toLowerCase()).filter(Boolean));
  const options = (state.certs || [])
    .filter(cert => cert?.name && !existing.has(normalizeCertName(cert.name).toLowerCase()))
    .map(cert => `<option value="${escapeHtml(cert.name)}">${escapeHtml(cert.name)}</option>`)
    .join('');
  return options || '<option value="">All dropdown certifications already have rules</option>';
}

function certificationRulesCard() {
  return `
    <div class="card">
      <div class="card-header">
        <div><h2>Certification Alert Rules</h2><div class="sub">Master rules for how often key certifications should be renewed. These rules feed the worker email preview and reminders without changing existing worker records.</div></div>
      </div>
      <div class="section">
        <div class="tag"><strong>Training Pack:</strong> yearly</div>
        <div class="tag"><strong>Fit Test:</strong> yearly</div>
        <div class="tag"><strong>OSHA 30:</strong> 5 years</div>
        <div class="tag"><strong>Bloodwork:</strong> typical 30-day cycle</div>
      </div>
      <div class="card section" style="background:#f8fafc;box-shadow:none;">
        <div class="card-header">
          <div><strong>Add Rule From Certification Dropdown</strong><div class="small muted">Use this for other certs already in the dropdown, including certs Admin adds later.</div></div>
        </div>
        <div class="grid grid-3 section">
          <div>
            <div class="small muted" style="margin-bottom:6px;">Certification</div>
            <select id="addCertificationRuleName">${certificationRuleAddOptions()}</select>
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">Expires Every (days)</div>
            <input id="addCertificationRuleExpiration" type="number" min="0" max="3650" value="365" />
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">Reminder Window (days)</div>
            <input id="addCertificationRuleReminder" type="number" min="0" max="365" value="30" />
          </div>
        </div>
        <div class="section button-row">
          <input id="addCertificationRuleNote" placeholder="Optional note" />
          <button class="btn dark" id="addCertificationRuleBtn">Add Rule</button>
        </div>
      </div>
      <div class="small muted section">Expiration and reminder numbers are in days. Add and Delete auto-save after confirmation. If you edit an existing row, click Save Edited Rules.</div>
      <div class="section">${certificationRulesTable()}</div>
      <div class="section button-row">
        <button class="btn dark" id="saveCertificationRulesBtn">Save Edited Rules</button>
        <div id="certRuleSaveStatus" class="small muted" style="align-self:center;"></div>
      </div>
    </div>`;
}

function officeDigestPreviewText() {
  const alerts = liveAlerts();
  const lines = [
    'JAGD Cert Portal Daily Office Digest',
    '',
    ...(alerts.length
      ? alerts.map(item => `- ${item.title}: ${item.detail}`)
      : ['- No active alerts right now.']),
    '',
    'Suggested recipients: office / admin',
    'Suggested send time: 6:00 AM'
  ];
  return lines.join('\n');
}

function adminView() {
  return layout(`
    <div class="grid grid-2">
      <div class="card">
        <h2>Admin Settings</h2>
        <div class="section">${(state.admin?.baselineRequirements || []).map(r=>`<span class="tag dark">${r}</span>`).join('')}</div>
        <div class="section">${(state.admin?.importStatus || []).map(row=>`<div class="tag"><strong>${row.label}</strong>: ${row.value}</div>`).join('')}</div>
      </div>
      <div class="card">
        <h2>Audit Log</h2>
        <div class="section">${(state.auditLog || []).slice(0,12).map(row=>`<div class="tag">${formatAuditTime(row.time)} — ${escapeHtml(row.action || '-')}: ${escapeHtml(row.detail || '-')}</div>`).join('')}</div>
      </div>
    </div>

    <div class="grid grid-2 section">
      <div class="card">
        <h2>Email Alert Settings</h2>
        <div class="section">
          <div class="tag"><strong>Office Daily Digest:</strong> Test button available</div>
          <div class="tag"><strong>Worker Email Alerts:</strong> ${state.admin?.emailAlerts?.workerAlertsEnabled ? 'ON' : 'OFF'}</div>
          <div class="tag"><strong>Worker Schedule:</strong> Daily around ${(state.admin?.emailAlerts?.sendHour ?? 6)}:00 AM ET when enabled</div>
          <div class="tag"><strong>Smart Timing:</strong> ${(state.admin?.emailAlerts?.reminderDays || [30,14,7,0]).join(', ')} day(s) before / due / expired</div>
        </div>
        <div class="section grid grid-2">
          <div>
            <div class="small muted" style="margin-bottom:6px;">Test Recipient</div>
            <input id="workerAlertTestRecipient" value="${escapeHtml(state.admin?.emailAlerts?.testRecipient || '')}" placeholder="test@email.com" />
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">Worker Alerts Master Toggle</div>
            <select id="workerAlertsEnabled">
              <option value="false" ${state.admin?.emailAlerts?.workerAlertsEnabled ? '' : 'selected'}>OFF - Safe Mode</option>
              <option value="true" ${state.admin?.emailAlerts?.workerAlertsEnabled ? 'selected' : ''}>ON - Send Automatically</option>
            </select>
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">Smart Reminder Days</div>
            <input id="workerReminderDays" value="${escapeHtml((state.admin?.emailAlerts?.reminderDays || [30,14,7,0]).join(', '))}" placeholder="30, 14, 7, 0" />
          </div>
        </div>
        <div class="small muted section">Safe testing: Send Test Worker Alert emails only the test recipient. Smart timing sends each worker/cert once per reminder stage (30, 14, 7, due today, expired) so workers do not get spammed daily.</div>
        <div class="section button-row">
          <button class="btn dark" id="saveWorkerAlertSettingsBtn">Save Email Settings</button>
          <button class="btn light" id="sendTestWorkerAlertBtn">Send Test Worker Alert</button>
          <button class="btn light" id="sendWorkerEmailsNowBtn">Send Worker Emails Now</button>
          <button class="btn light" id="sendTestDigestBtn">Send Office Test Digest</button>
          <div id="sendTestDigestStatus" class="small muted"></div>
        </div>
      </div>
      <div class="card">
        <h2>Worker Alert Preview</h2>
        <div class="small muted">Shows who would receive worker email reminders. Missing email workers are skipped until an email is added to their profile.</div>
        <div class="section">
          <div class="tag"><strong>Workers With Alerts:</strong> ${state.workerEmailPreview?.totalWorkersWithAlerts || state.admin?.workerEmailPreview?.totalWorkersWithAlerts || 0}</div>
          <div class="tag"><strong>Ready to Email Now:</strong> ${state.workerEmailPreview?.readyWorkerEmails || state.admin?.workerEmailPreview?.readyWorkerEmails || 0}</div>
          <div class="tag"><strong>Already Sent Items:</strong> ${state.workerEmailPreview?.alreadySentCertItems || state.admin?.workerEmailPreview?.alreadySentCertItems || 0}</div>
          <div class="tag"><strong>Valid Emails:</strong> ${state.workerEmailPreview?.workersWithValidEmail || state.admin?.workerEmailPreview?.workersWithValidEmail || 0}</div>
          <div class="tag"><strong>Missing Emails:</strong> ${state.workerEmailPreview?.workersMissingEmail || state.admin?.workerEmailPreview?.workersMissingEmail || 0}</div>
        </div>
        <textarea rows="10" style="width:100%; margin-top:12px;">${escapeHtml(workerEmailPreviewText())}</textarea>
      </div>
    </div>

    <div class="card section">
      <div class="card-header"><div><h2>Worker Email Alert Preview List</h2><div class="sub">Review real worker alert rows before turning on automatic worker emails.</div></div></div>
      <div class="section">${workerEmailPreviewTable()}</div>
    </div>
  `);
}

function renderWorkerModal() {
  if (!state.modals.worker) return '';
  return `
    <div class="modal"><div class="modal-box">
      <div class="flex space-between"><h2>Add Worker</h2><button class="btn light" id="closeWorkerModal">Close</button></div>
      <div class="grid grid-2 section">
        <input id="newWorkerFirst" placeholder="First name" />
        <input id="newWorkerLast" placeholder="Last name" />
        <input id="newWorkerCrew" placeholder="Crew" value="Bridge Painting" />
        <input id="newWorkerEmail" placeholder="Worker email address (optional)" />
        <select id="newWorkerStatus"><option>Qualified</option><option>Expiring Soon</option><option>Needs Attention</option></select>
        <select id="newWorkerEmploymentStatus"><option>Active</option><option>Inactive</option><option>Terminated</option><option>Archived</option></select>
        <input id="newWorkerIssue" placeholder="Next issue" />
        <textarea id="newWorkerNotes" placeholder="Notes"></textarea>
      </div>
      <div class="button-row section"><button class="btn dark" id="saveWorkerBtn">Save Worker</button></div>
    </div></div>`;
}

function renderJobModal() {
  if (!state.modals.job) return '';
  return `
    <div class="modal"><div class="modal-box">
      <div class="flex space-between"><h2>Add Job</h2><button class="btn light" id="closeJobModal">Close</button></div>
      <div class="grid grid-2 section">
        <input id="newJobName" placeholder="Job name" />
        <input id="newJobOwner" placeholder="Owner" />
        <select id="newJobStage"><option>Active</option><option>Needs Review</option></select>
        <input id="newJobRequirements" placeholder="Requirements comma-separated" value="OSHA 30, Training Pack, Lead Awareness, Fit Test" />
        <textarea id="newJobNotes" placeholder="Notes"></textarea>
      </div>
      <div class="button-row section"><button class="btn dark" id="saveJobBtn">Save Job</button></div>
    </div></div>`;
}

function renderJobEditModal() {
  if (!state.modals.jobEdit) return '';
  const job = state.jobs.find(j => j.id === state.selectedJobId);
  if (!job) return '';
  return `
    <div class="modal"><div class="modal-box">
      <div class="flex space-between"><h2>Edit Job Requirements</h2><button class="btn light" id="closeJobEditModal">Close</button></div>
      <div class="grid grid-2 section">
        <input id="editJobName" value="${escapeHtml(job.name)}" />
        <input id="editJobOwner" value="${escapeHtml(job.owner)}" />
        <select id="editJobStage"><option ${job.stage==='Active'?'selected':''}>Active</option><option ${job.stage==='Needs Review'?'selected':''}>Needs Review</option></select>
        <input id="editJobRequirements" value="${escapeHtml(job.requirements.join(', '))}" />
        <textarea id="editJobNotes">${escapeHtml(job.notes || '')}</textarea>
      </div>
      <div class="button-row section"><button class="btn dark" id="updateJobBtn">Save Changes</button></div>
    </div></div>`;
}


function renderAddCertDropdownModal() {
  if (!state.modals.addCertDropdown) return '';
  return `
    <div class="modal"><div class="modal-box">
      <div class="flex space-between">
        <div>
          <h2>Add New Cert to Dropdown</h2>
          <div class="sub">Use this when a certification is missing from the dropdown. This does not change existing worker records.</div>
        </div>
        <button class="btn light" id="closeAddCertDropdownModal">Close</button>
      </div>
      <div class="grid grid-2 section">
        <div>
          <div class="small muted" style="margin-bottom:6px;">Certification Name</div>
          <input id="newDropdownCertName" placeholder="Example: Forklift Training" />
        </div>
        <div>
          <div class="small muted" style="margin-bottom:6px;">Aliases / Source Names (optional)</div>
          <input id="newDropdownCertAlias" placeholder="Comma separated, optional" />
        </div>
      </div>
      <div class="small muted section">After saving, this cert will be available in certification upload dropdowns and can be added to Certification Alert Rules.</div>
      <div class="button-row section">
        <button class="btn dark" id="saveAddCertDropdownBtn">Save New Cert</button>
        <button class="btn light" id="cancelAddCertDropdownBtn">Cancel</button>
      </div>
      <div id="addCertDropdownStatus" class="small muted section"></div>
    </div></div>`;
}

function mobileConfirm(message, title = 'Please Confirm') {
  return new Promise(resolve => {
    const existing = document.getElementById('mobileConfirmModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'mobileConfirmModal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:560px;">
        <h2>${escapeHtml(title)}</h2>
        <div class="section" style="white-space:pre-wrap;line-height:1.45;">${escapeHtml(message)}</div>
        <div class="button-row section" style="justify-content:flex-end;">
          <button class="btn light" id="mobileConfirmCancel">Cancel</button>
          <button class="btn dark" id="mobileConfirmOk">OK</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const cleanup = value => {
      modal.remove();
      resolve(value);
    };
    modal.querySelector('#mobileConfirmCancel')?.addEventListener('click', () => cleanup(false));
    modal.querySelector('#mobileConfirmOk')?.addEventListener('click', () => cleanup(true));
  });
}


function setBloodworkActionStatus(message, isError = false) {
  const status = document.getElementById('bloodworkActionStatus') || document.getElementById('bloodworkAddStatus') || document.getElementById('workerProfileActionStatus');
  if (status) {
    status.textContent = message || '';
    status.style.color = isError ? '#991b1b' : '#166534';
  }
}

function openBloodworkEditModal(workerId, rowIndex, bloodworkRow) {
  return new Promise(resolve => {
    const existing = document.getElementById('bloodworkEditModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'bloodworkEditModal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:760px;">
        <div class="flex space-between wrap">
          <div>
            <h2>Edit Bloodwork</h2>
            <div class="sub">Update the bloodwork record below. This form replaces phone-unfriendly popups.</div>
          </div>
          <button class="btn light" id="closeBloodworkEditModal">Close</button>
        </div>
        <div class="grid grid-2 section">
          <div>
            <div class="small muted" style="margin-bottom:6px;">Test Date</div>
            <input id="editBloodworkTestDate" type="date" value="${escapeHtml(bloodworkRow.testDate || '')}" />
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">Next Due</div>
            <input id="editBloodworkNextDue" type="date" value="${escapeHtml(bloodworkRow.nextDue || '')}" />
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">BLL</div>
            <input id="editBloodworkBLL" value="${escapeHtml(bloodworkRow.bll ?? '')}" placeholder="BLL value" />
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">ZPP</div>
            <input id="editBloodworkZPP" value="${escapeHtml(bloodworkRow.zpp ?? '')}" placeholder="ZPP value" />
          </div>
          <div>
            <div class="small muted" style="margin-bottom:6px;">Status</div>
            <select id="editBloodworkStatus">
              ${['Current','Due Soon','Overdue','Needs Attention'].map(status => `<option value="${status}" ${String(bloodworkRow.status || 'Current') === status ? 'selected' : ''}>${status}</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="editBloodworkStatusText" class="small muted section"></div>
        <div class="button-row section" style="justify-content:flex-end;">
          <button class="btn light" id="cancelBloodworkEditBtn">Cancel</button>
          <button class="btn dark" id="saveBloodworkEditBtn">Save Bloodwork</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const cleanup = value => {
      modal.remove();
      resolve(value);
    };

    modal.querySelector('#closeBloodworkEditModal')?.addEventListener('click', () => cleanup(null));
    modal.querySelector('#cancelBloodworkEditBtn')?.addEventListener('click', () => cleanup(null));
    modal.querySelector('#saveBloodworkEditBtn')?.addEventListener('click', () => {
      cleanup({
        workerId,
        rowIndex,
        testDate: String(modal.querySelector('#editBloodworkTestDate')?.value || '').trim(),
        nextDue: String(modal.querySelector('#editBloodworkNextDue')?.value || '').trim(),
        bll: String(modal.querySelector('#editBloodworkBLL')?.value || '').trim(),
        zpp: String(modal.querySelector('#editBloodworkZPP')?.value || '').trim(),
        status: String(modal.querySelector('#editBloodworkStatus')?.value || 'Current').trim()
      });
    });
  });
}

function normalizeCertName(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(str) {
  return String(str || '').replaceAll('&', '&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
}

function formatAuditTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function displayAuditRole(row) {
  const directRole = String(row?.actorRole || row?.role || '').trim();
  if (directRole && directRole !== '-') return directRole;

  const username = String(row?.actorUsername || '').trim().toLowerCase();
  if (!username || username === 'system') return '-';
  if (username === 'admin') return 'Admin';
  if (username === 'office') return 'Office';
  if (username === 'pm') return 'PM';
  return 'Worker';
}


function portalAccessView() {
  const rows = state.accessUsers || [];
  return layout(`
    <div class="card">
      <div class="card-header">
        <div>
          <h2>Portal Access</h2>
          <div class="sub">Add and manage Admin, Office, and PM accounts separately from the worker roster.</div>
        </div>
        <div class="pill">${rows.length} account(s)</div>
      </div>
      <div class="section grid grid-2">
        <div class="card" style="background:#f8fafc;box-shadow:none;">
          <div class="card-header"><div><h2>Add Access Person</h2><div class="sub">Use this for office staff, PMs, or extra admins who are not on the worker sheet.</div></div></div>
          <div class="grid grid-2 section">
            <input id="accessName" placeholder="Full name" />
            <input id="accessUsername" placeholder="Username (lowercase)" />
            <div>
              <div class="small muted" style="margin-bottom:6px;">Role</div>
              <select id="accessRole">
                <option value="Office">Office</option>
                <option value="PM">PM</option>
                <option value="Admin">Admin</option>
              </select>
            </div>
            <div class="small muted" style="display:flex;align-items:center;">New accounts start with temporary password <strong style="margin-left:6px;">changeme123</strong></div>
          </div>
          <div class="button-row section">
            <button class="btn dark" id="saveAccessUserBtn">Add Access Person</button>
            <div id="accessUserStatus" class="small muted"></div>
          </div>
        </div>
        <div class="card" style="background:#f8fafc;box-shadow:none;">
          <h2>Access Rules</h2>
          <div class="section">
            <div class="tag">Workers stay on the worker roster and keep their own worker portal access.</div>
            <div class="tag">Portal Access is for Admin, Office, and PM accounts not tied to the worker sheet.</div>
            <div class="tag">Custom Admin accounts are manual-only for password reset.</div>
            <div class="tag">Office and PM accounts can be reset back to a temporary password by Admin.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card section">
      <div class="card-header">
        <div><h2>Current Portal Access</h2><div class="sub">Activate, deactivate, or reset accounts without adding them to worker compliance tracking.</div></div>
      </div>
      <div class="section">
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Source</th><th>Status</th><th>Password</th><th>Action</th></tr></thead><tbody>
          ${rows.map(row => `<tr>
            <td>${escapeHtml(row.name || '-')}</td>
            <td>${escapeHtml(row.username || '-')}</td>
            <td>${escapeHtml(row.role || '-')}</td>
            <td>${escapeHtml(row.source || '-')}</td>
            <td>${row.active === false ? '<span class="badge bg-red">Inactive</span>' : '<span class="badge bg-green">Active</span>'}</td>
            <td>${escapeHtml(row.tempPassword || 'Hidden')}<div class="small muted">${escapeHtml(row.passwordStatus || '-')}</div></td>
            <td>
              <div class="button-row">
                ${row.source === 'Portal Access' ? `<button class="btn light" data-toggle-access-user="${escapeHtml(row.username)}|${row.active === false ? 'activate' : 'deactivate'}">${row.active === false ? 'Activate' : 'Deactivate'}</button>` : ''}
                ${(row.resettable && row.role !== 'Admin') ? `<button class="btn light" data-reset-access-user="${escapeHtml(row.username)}">Reset Password</button>` : `<span class="small muted">Manual only</span>`}
              </div>
            </td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">No portal access accounts yet.</div>'}
      </div>
    </div>
  `);
}


function historyView() {
  const rows = state.auditLog || [];
  return layout(`
    <div class="card">
      <div class="card-header">
        <div>
          <h2>History Log</h2>
          <div class="sub">Recent admin and office actions across certifications, uploads, bloodwork, dropdown management, and digest testing.</div>
        </div>
        <div class="pill">${rows.length} event(s)</div>
      </div>
      <div class="section">
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Role</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows.map(row => `<tr><td>${formatAuditTime(row.time)}</td><td>${escapeHtml(row.actorName || row.actorUsername || 'System')}</td><td>${escapeHtml(displayAuditRole(row))}</td><td>${escapeHtml(row.action || '-')}</td><td>${escapeHtml(row.detail || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">No history events yet.</div>'}
      </div>
    </div>
  `);
}

function render() {
  const app = document.getElementById('app');
  if (!state.user) {
    app.innerHTML = loginView();
  } else if (state.user.role === 'Worker') {
    app.innerHTML = workerPortalView();
  } else {
    let view = dashboardView();
    if (state.view === 'employees') view = employeesView();
    if (state.view === 'jobs') view = jobsView();
    if (state.view === 'certs') view = certsView();
    if (state.view === 'bloodwork') view = bloodworkView();
    if (state.view === 'alerts') view = alertsView();
    if (state.view === 'uploads') view = uploadsView();
    if (state.view === 'access') view = canViewAdmin() ? portalAccessView() : dashboardView();
    if (state.view === 'history') view = historyView();
    if (state.view === 'reports') view = reportsView();
    if (state.view === 'admin') view = canViewAdmin() ? adminView() : dashboardView();
    app.innerHTML = view;
  }
  bindEvents();
  requestAnimationFrame(() => scrollToPendingTarget());
}

async function refreshData() {
  if (state.user?.role === 'Worker' && state.user?.workerId) {
    const payload = await api('/api/worker-portal/' + state.user.workerId);
    state.workerPortal = payload;
    state.selectedWorkerId = state.user.workerId;
    state.workers = [payload.worker];
    state.jobs = [];
    state.uploads = payload.uploads || [];
    state.dashboard = { executiveSummary: [], counts: {} };
    state.bloodwork = payload.worker?.bloodwork || [];
    state.alerts = (payload.alerts || []).map((a, i) => ({ ...a, key: `worker-alert-${i}`, items: [] }));
    state.admin = null;
    state.accessUsers = [];
    state.auditLog = [];
    const certPayload = await api('/api/certs');
    state.certs = certPayload.certs || [];
    state.certsSource = certPayload.workbookSource || '';
    return;
  }

  state.dashboard = await api('/api/dashboard');
  const workerQuery = new URLSearchParams({ search: state.employeeSearch, filter: state.employeeFilter });
  state.workers = await api('/api/workers?' + workerQuery.toString());
  state.jobs = await api('/api/jobs?search=' + encodeURIComponent(state.jobSearch));
  state.bloodwork = await api('/api/bloodwork');
  state.uploads = await api('/api/uploads');
  state.alerts = normalizeAlertFeed(await api('/api/alerts'));
  state.accessUsers = canViewAdmin() ? await api('/api/access-users') : [];
  state.auditLog = await api('/api/audit-log?limit=150');
  state.admin = canViewAdmin() ? await api('/api/admin') : null;
  state.workerEmailPreview = state.admin?.workerEmailPreview || null;
  state.certificationAlertRules = state.admin?.certificationAlertRules || [];
  const certPayload = await api('/api/certs');
  state.certs = certPayload.certs || [];
  state.certsSource = certPayload.workbookSource || '';

  if (!state.selectedWorkerId && state.workers[0]) state.selectedWorkerId = state.workers[0].id;
  if (!state.selectedJobId && state.jobs[0]) state.selectedJobId = state.jobs[0].id;
  if (state.selectedAlertKey && !normalizeAlertFeed(state.alerts).find(a => a.key === state.selectedAlertKey)) state.selectedAlertKey = null;
  if (state.selectedJobId) {
    const selected = await api('/api/jobs/' + state.selectedJobId);
    const idx = state.jobs.findIndex(j => j.id === selected.id);
    if (idx >= 0) state.jobs[idx] = selected;
  }
  if (state.selectedWorkerId) {
    const worker = await api('/api/workers/' + state.selectedWorkerId);
    const idx = state.workers.findIndex(w => w.id === worker.id);
    if (idx >= 0) state.workers[idx] = worker;
  }
}


function scrollToPendingTarget() {
  const targetId = state.pendingScrollTarget;
  if (!targetId) return;
  const el = document.getElementById(targetId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  state.pendingScrollTarget = null;
}

function bindEvents() {
  document.getElementById('loginBtn')?.addEventListener('click', async () => {
    const username = String(document.getElementById('loginUsername').value || '').trim().toLowerCase();
    const password = String(document.getElementById('loginPassword').value || '').trim();
    const fallbackUsers = {
      admin: { password: 'admin123', role: 'Admin', name: 'Admin User' },
      office: { password: 'office123', role: 'Office', name: 'Office User' },
      pm: { password: 'pm123', role: 'PM', name: 'Project Manager' }
    };
    try {
      const result = await api('/api/login', { method: 'POST', body: { username, password } });
      state.user = result.user;
      await refreshData();
      render();
      return;
    } catch (e) {
      if (fallbackUsers[username] && fallbackUsers[username].password === password) {
        state.user = { username, role: fallbackUsers[username].role, name: fallbackUsers[username].name };
        await refreshData();
        render();
        return;
      }
      document.getElementById('loginError').textContent = 'Login failed. Use admin/admin123, office/office123, or pm/pm123';
    }
  });

  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    state.user = null;
    render();
  });

  document.getElementById('reportJobSelector')?.addEventListener('change', async (e) => {
    state.selectedJobId = e.target.value;
    await refreshData();
    state.view = 'reports';
    render();
  });


  document.getElementById('sendTestDigestBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('sendTestDigestStatus');
    if (status) status.textContent = 'Sending...';
    try {
      const result = await api('/api/send-test-digest', { method: 'POST' });
      if (status) status.textContent = result.message || 'Test digest sent.';
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to send test digest.';
    }
  });


  document.getElementById('saveWorkerAlertSettingsBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('sendTestDigestStatus');
    if (status) status.textContent = 'Saving email settings...';
    try {
      const enabled = document.getElementById('workerAlertsEnabled')?.value === 'true';
      const testRecipient = document.getElementById('workerAlertTestRecipient')?.value || '';
      const reminderDaysText = document.getElementById('workerReminderDays')?.value || '30,14,7,0';
      const reminderDays = reminderDaysText.split(',').map(x => Number(String(x).trim())).filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
      const result = await api('/api/email-alerts/settings', {
        method: 'PUT',
        body: { workerAlertsEnabled: enabled, testRecipient, reminderDays }
      });
      state.workerEmailPreview = result.preview || null;
      if (status) status.textContent = 'Email settings saved.';
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to save email settings.';
    }
  });

  document.getElementById('sendTestWorkerAlertBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('sendTestDigestStatus');
    if (status) status.textContent = 'Sending safe test worker alert...';
    try {
      const testRecipient = document.getElementById('workerAlertTestRecipient')?.value || '';
      const result = await api('/api/email-alerts/send-test-worker', {
        method: 'POST',
        body: { testRecipient }
      });
      if (status) status.textContent = result.message || 'Test worker alert sent.';
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to send test worker alert.';
    }
  });

  document.getElementById('sendWorkerEmailsNowBtn')?.addEventListener('click', async () => {
    const preview = state.workerEmailPreview || state.admin?.workerEmailPreview || {};
    const sendCount = preview.readyWorkerEmails || 0;
    const proceed = await mobileConfirm(`Send real worker alert email(s) now to ${sendCount} worker(s) ready under the smart timing rules?\n\nWorkers already emailed for the same cert/timing stage will be skipped.`, 'Send Worker Emails Now');
    if (!proceed) return;
    const status = document.getElementById('sendTestDigestStatus');
    if (status) status.textContent = 'Sending worker emails...';
    try {
      const result = await api('/api/email-alerts/send-worker-now', { method: 'POST' });
      if (status) status.textContent = result.message || 'Worker emails sent.';
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to send worker emails.';
    }
  });


  document.getElementById('addCertificationRuleBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('certRuleSaveStatus');
    const certName = document.getElementById('addCertificationRuleName')?.value || '';
    if (!certName) {
      alert('Please select a certification before adding a rule.');
      if (status) status.textContent = 'Select a certification before adding a rule.';
      return;
    }
    const rules = [...(state.certificationAlertRules || state.admin?.certificationAlertRules || [])];
    const exists = rules.some(rule => normalizeCertName(rule.certName || '').toLowerCase() === normalizeCertName(certName).toLowerCase());
    if (exists) {
      alert(`${certName} already has a certification alert rule.`);
      if (status) status.textContent = 'That certification already has a rule.';
      return;
    }

    const expirationDays = Number(document.getElementById('addCertificationRuleExpiration')?.value || 365);
    const reminderDays = Number(document.getElementById('addCertificationRuleReminder')?.value || 30);
    const note = document.getElementById('addCertificationRuleNote')?.value || '';

    if (!Number.isFinite(expirationDays) || expirationDays < 0) {
      alert('Please enter a valid Expires Every number.');
      return;
    }
    if (!Number.isFinite(reminderDays) || reminderDays < 0) {
      alert('Please enter a valid Reminder Window number.');
      return;
    }

    const ok = await mobileConfirm(`Add certification alert rule for ${certName}?

Expires Every: ${expirationDays} day(s)
Reminder Window: ${reminderDays} day(s)

If you click OK, this rule will be added and saved automatically.`, 'Add Certification Alert Rule');
    if (!ok) return;

    const cert = (state.certs || []).find(item => normalizeCertName(item.name || '').toLowerCase() === normalizeCertName(certName).toLowerCase());
    rules.push({
      certName,
      aliases: cert?.aliases?.length ? cert.aliases : [certName],
      enabled: true,
      expirationDays,
      reminderDays,
      note
    });

    if (status) status.textContent = `Saving ${certName} rule...`;
    try {
      const result = await api('/api/certification-alert-rules', {
        method: 'PUT',
        body: { rules }
      });
      state.certificationAlertRules = result.certificationAlertRules || [];
      state.workerEmailPreview = result.preview || null;
      if (status) status.textContent = `${certName} rule added and saved.`;
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to save certification alert rule.';
      alert(e.message || 'Failed to save certification alert rule.');
    }
  });

  document.querySelectorAll('[data-edit-cert-rule]').forEach(btn => btn.addEventListener('click', () => {
    const index = Number(btn.dataset.editCertRule);
    const rules = state.certificationAlertRules || state.admin?.certificationAlertRules || [];
    const rule = rules[index];
    const status = document.getElementById('certRuleSaveStatus');
    const input = document.querySelector(`[data-cert-rule-expiration="${index}"]`);
    if (input) input.focus();
    if (status) status.textContent = `Editing ${rule?.certName || 'certification rule'}. Change the row values, then click Save Edited Rules.`;
  }));

  document.querySelectorAll('[data-delete-cert-rule]').forEach(btn => btn.addEventListener('click', async () => {
    const index = Number(btn.dataset.deleteCertRule);
    const rules = [...(state.certificationAlertRules || state.admin?.certificationAlertRules || [])];
    const rule = rules[index];
    const status = document.getElementById('certRuleSaveStatus');
    if (!rule) return;
    const ok = await mobileConfirm(`Delete certification alert rule for ${rule.certName || 'this certification'}?

If you click OK, this rule will be removed and saved automatically.`, 'Delete Certification Alert Rule');
    if (!ok) return;
    rules.splice(index, 1);
    if (status) status.textContent = `Deleting ${rule.certName || 'certification'} rule...`;
    try {
      const result = await api('/api/certification-alert-rules', {
        method: 'PUT',
        body: { rules }
      });
      state.certificationAlertRules = result.certificationAlertRules || [];
      state.workerEmailPreview = result.preview || null;
      if (status) status.textContent = `${rule.certName || 'Certification'} rule deleted and saved.`;
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to delete certification alert rule.';
      alert(e.message || 'Failed to delete certification alert rule.');
    }
  }));

  document.getElementById('saveCertificationRulesBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('certRuleSaveStatus') || document.getElementById('sendTestDigestStatus');
    if (status) status.textContent = 'Saving certification alert rules...';
    try {
      const currentRules = state.certificationAlertRules || state.admin?.certificationAlertRules || [];
      const rules = currentRules.map((rule, index) => ({
        ...rule,
        enabled: document.querySelector(`[data-cert-rule-enabled="${index}"]`)?.value !== 'false',
        expirationDays: Number(document.querySelector(`[data-cert-rule-expiration="${index}"]`)?.value || rule.expirationDays || 0),
        reminderDays: Number(document.querySelector(`[data-cert-rule-reminder="${index}"]`)?.value || rule.reminderDays || 30),
        note: document.querySelector(`[data-cert-rule-note="${index}"]`)?.value || ''
      }));
      const result = await api('/api/certification-alert-rules', {
        method: 'PUT',
        body: { rules }
      });
      state.certificationAlertRules = result.certificationAlertRules || [];
      state.workerEmailPreview = result.preview || null;
      if (status) status.textContent = 'Certification alert rules saved.';
      await refreshData();
      render();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed to save certification alert rules.';
    }
  });

  document.getElementById('workerUploadBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('workerUploadStatus');
    if (status) {
      status.textContent = 'Submitting certification upload...';
      status.className = 'small muted';
    }
    try {
      const pickedFile = document.getElementById('workerUploadFilePicker')?.files?.[0];
      const selectedCertName = String(document.getElementById('workerUploadCertName').value || '').trim();
      const recordName = String(document.getElementById('workerUploadFileName').value || pickedFile?.name || 'Untitled Upload').trim();
      const certName = selectedCertName || recordName;
      if (!certName) throw new Error('Please select a certification or enter a record name.');
      if (!pickedFile) throw new Error('Please choose a PDF or image file before submitting.');
      let fileData = '';
      fileData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || '');
        reader.onerror = () => reject(new Error('We could not read that file. Please try again.'));
        reader.readAsDataURL(pickedFile);
      });
      await api('/api/uploads', {
        method: 'POST',
        body: {
          file: recordName,
          originalFileName: pickedFile?.name || '',
          fileData,
          workerId: state.user.workerId,
          worker: state.workerPortal?.worker?.name || state.user.name,
          certName,
          expirationDate: document.getElementById('workerUploadExpirationDate').value,
          status: 'Needs Review',
          notes: document.getElementById('workerUploadNotes').value
        }
      });
      if (status) {
        status.textContent = 'Upload submitted to office review queue.';
        status.className = 'small';
        status.style.color = '#166534';
      }
      await refreshData();
      render();
    } catch (e) {
      if (status) {
        status.textContent = e.message || 'Upload failed. Please try again.';
        status.className = 'small';
        status.style.color = '#991b1b';
      }
    }
  });



  document.getElementById('saveAccessUserBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('accessUserStatus');
    if (status) {
      status.textContent = 'Saving access account...';
      status.style.color = '';
    }
    try {
      const name = String(document.getElementById('accessName')?.value || '').trim();
      const username = String(document.getElementById('accessUsername')?.value || '').trim().toLowerCase();
      const role = String(document.getElementById('accessRole')?.value || 'Office').trim();
      await api('/api/access-users', { method: 'POST', body: { name, username, role, active: true } });
      await refreshData();
      state.view = 'access';
      render();
      const updatedStatus = document.getElementById('accessUserStatus');
      if (updatedStatus) {
        updatedStatus.textContent = 'Portal access account added.';
        updatedStatus.style.color = '#166534';
      }
    } catch (err) {
      if (status) {
        status.textContent = err.message || 'Failed to add access account.';
        status.style.color = '#991b1b';
      }
    }
  });

  document.querySelectorAll('[data-toggle-access-user]').forEach(btn => btn.addEventListener('click', async () => {
    const [username, action] = String(btn.dataset.toggleAccessUser || '').split('|');
    const active = action === 'activate';
    const confirmed = await mobileConfirm((active ? 'Activate' : 'Deactivate') + ' this portal access account?', (active ? 'Activate' : 'Deactivate') + ' Portal Access');
    if (!confirmed) return;
    const status = document.getElementById('accessUserStatus');
    if (status) {
      status.textContent = (active ? 'Activating' : 'Deactivating') + ' portal access account...';
      status.style.color = '';
    }
    try {
      await api(`/api/access-users/${encodeURIComponent(username)}`, { method: 'PUT', body: { active } });
      await refreshData();
      state.view = 'access';
      render();
      const updatedStatus = document.getElementById('accessUserStatus');
      if (updatedStatus) {
        updatedStatus.textContent = 'Portal access account ' + (active ? 'activated' : 'deactivated') + '.';
        updatedStatus.style.color = '#166534';
      }
    } catch (err) {
      const updatedStatus = document.getElementById('accessUserStatus') || status;
      if (updatedStatus) {
        updatedStatus.textContent = err.message || 'Failed to update portal access account.';
        updatedStatus.style.color = '#991b1b';
      }
    }
  }));

  document.querySelectorAll('[data-reset-access-user]').forEach(btn => btn.addEventListener('click', async () => {
    const username = String(btn.dataset.resetAccessUser || '').trim().toLowerCase();
    const confirmed = await mobileConfirm('Reset this portal access account back to its temporary password? This action cannot be undone.', 'Reset Portal Access Password');
    if (!confirmed) return;
    const status = document.getElementById('accessUserStatus');
    if (status) {
      status.textContent = 'Resetting portal access password...';
      status.style.color = '';
    }
    try {
      const result = await api(`/api/access-users/${encodeURIComponent(username)}/reset-password`, { method: 'POST' });
      await refreshData();
      state.view = 'access';
      render();
      const updatedStatus = document.getElementById('accessUserStatus');
      if (updatedStatus) {
        updatedStatus.textContent = 'Password reset. Temporary password: ' + result.tempPassword;
        updatedStatus.style.color = '#166534';
      }
    } catch (err) {
      const updatedStatus = document.getElementById('accessUserStatus') || status;
      if (updatedStatus) {
        updatedStatus.textContent = err.message || 'Failed to reset portal access password.';
        updatedStatus.style.color = '#991b1b';
      }
    }
  }));

  document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', async () => {
    state.view = btn.dataset.nav;
    state.pendingScrollTarget = 'view-start';
    if (state.view === 'certs' && !state.selectedCertName && state.certs[0]) {
      state.selectedCertName = state.certs[0].name;
    }
    if (state.view === 'jobs' && state.selectedJobId) {
      const selected = await api('/api/jobs/' + state.selectedJobId);
      const idx = state.jobs.findIndex(j => j.id === selected.id);
      if (idx >= 0) state.jobs[idx] = selected;
    }
    render();
  }));

  document.querySelectorAll('[data-alert-open]').forEach(btn => btn.addEventListener('click', () => {
    state.selectedAlertKey = btn.dataset.alertOpen;
    state.view = 'alerts';
    state.pendingScrollTarget = 'alert-detail-section';
    render();
  }));

  document.getElementById('alertBackToTopBtn')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });


  document.getElementById('jobSelector')?.addEventListener('change', async (e) => {
    state.selectedJobId = Number(e.target.value);
    const selected = await api('/api/jobs/' + state.selectedJobId);
    const idx = state.jobs.findIndex(j => j.id === selected.id);
    if (idx >= 0) state.jobs[idx] = selected;
    render();
  });

  document.querySelectorAll('[data-bucket]').forEach(el => el.addEventListener('click', () => {
    state.selectedBucket = el.dataset.bucket;
    state.pendingScrollTarget = 'job-workers-section';
    render();
  }));

  document.querySelectorAll('[data-cert-name]').forEach(el => el.addEventListener('click', () => {
    state.selectedCertName = el.dataset.certName;
    state.selectedCertScope = el.dataset.certScope || 'active-good';
    state.pendingScrollTarget = 'cert-worker-list';
    render();
  }));

  document.querySelectorAll('[data-open-worker]').forEach(el => el.addEventListener('click', async () => {
    state.selectedWorkerId = Number(el.dataset.openWorker);
    if (state.view !== 'employees') state.view = 'employees';
    state.pendingScrollTarget = 'selected-worker-profile';
    const worker = await api('/api/workers/' + state.selectedWorkerId);
    const idx = state.workers.findIndex(w => w.id === worker.id);
    if (idx >= 0) state.workers[idx] = worker;
    render();
  }));

  document.querySelectorAll('[data-worker-filter]').forEach(el => el.addEventListener('click', async () => {
    state.employeeFilter = el.dataset.workerFilter;
    await refreshData();
    render();
  }));

  document.querySelectorAll('[data-set-employment]').forEach(el => {
    const handler = async () => {
      let id = el.dataset.setEmployment;
      let employmentStatus = el.value;
      if (String(id || '').includes('|')) {
        const parts = String(id).split('|');
        id = parts[0];
        employmentStatus = parts[1];
      }
      await api('/api/workers/' + id, { method: 'PUT', body: { employmentStatus } });
      await refreshData();
      render();
    };
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'click', handler);
  });

  document.querySelectorAll('[data-set-current-job]').forEach(el => el.addEventListener('change', async () => {
    const id = el.dataset.setCurrentJob;
    const currentJob = el.value;
    await api('/api/workers/' + id, { method: 'PUT', body: { currentJob } });
    await refreshData();
    render();
  }));

  document.getElementById('profileCurrentJob')?.addEventListener('change', async (e) => {
    if (!state.selectedWorkerId) return;
    await api('/api/workers/' + state.selectedWorkerId, { method: 'PUT', body: { currentJob: e.target.value } });
    await refreshData();
    render();
  });

  document.getElementById('saveWorkerEmailBtn')?.addEventListener('click', async () => {
    const worker = state.workers.find(w => w.id === state.selectedWorkerId);
    if (!worker) return;
    await api('/api/workers/' + worker.id, {
      method: 'PUT',
      body: { email: document.getElementById('profileWorkerEmail')?.value || '' }
    });
    await refreshData();
    render();
  });

  document.querySelectorAll('[data-open-office-upload]').forEach(btn => btn.addEventListener('click', () => {
    state.view = 'uploads';
    state.pendingScrollTarget = 'view-start';
    render();
    requestAnimationFrame(() => {
      const workerSelect = document.getElementById('uploadWorkerId');
      if (workerSelect) workerSelect.value = btn.dataset.openOfficeUpload || '';
    });
  }));

  
  document.getElementById('openAddCertDropdownBtn')?.addEventListener('click', () => {
    if (state.user?.role !== 'Admin') {
      alert('Only admin can add certifications to the dropdown.');
      return;
    }
    state.modals.addCertDropdown = true;
    render();
  });

  document.getElementById('closeAddCertDropdownModal')?.addEventListener('click', () => {
    state.modals.addCertDropdown = false;
    render();
  });

  document.getElementById('cancelAddCertDropdownBtn')?.addEventListener('click', () => {
    state.modals.addCertDropdown = false;
    render();
  });

  document.getElementById('saveAddCertDropdownBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('addCertDropdownStatus');
    const name = String(document.getElementById('newDropdownCertName')?.value || '').trim();
    const alias = String(document.getElementById('newDropdownCertAlias')?.value || '').trim();
    if (!name) {
      if (status) status.textContent = 'Certification name is required.';
      return;
    }
    if (status) status.textContent = 'Saving new certification dropdown item...';
    try {
      const result = await api('/api/certs/catalog', { method: 'POST', body: { name, alias } });
      await refreshData();
      if (!state.selectedCertName || state.selectedCertName === name || !state.certs.some(c => c.name === state.selectedCertName)) {
        state.selectedCertName = result.name || name;
      }
      state.modals.addCertDropdown = false;
      state.view = 'certs';
      render();
    } catch (err) {
      if (status) status.textContent = err.message || 'Failed to add certification to dropdown.';
    }
  });

  document.querySelectorAll('[data-delete-dropdown-cert]').forEach(btn => btn.addEventListener('click', async () => {
    if (state.user?.role !== 'Admin') {
      window.alert('Only admin can delete certifications from the dropdown.');
      return;
    }
    const certName = String(btn.dataset.deleteDropdownCert || '').trim();
    if (!certName) return;
    const confirmed = await mobileConfirm(`Delete "${certName}" from the dropdown? This action cannot be undone. Existing worker records and upload history will not be changed.`, 'Delete Cert From Dropdown');
    if (!confirmed) return;
    try {
      const result = await api('/api/certs/catalog', { method: 'DELETE', body: { name: certName } });
      await refreshData();
      if (state.selectedCertName === certName) {
        state.selectedCertName = state.certs[0]?.name || null;
      }
      state.view = 'certs';
      const message = result.message || 'Certification removed from the dropdown. Existing worker records and upload history were not changed.';
      render();
      requestAnimationFrame(() => {
        const status = document.getElementById('certRuleSaveStatus');
        if (status) status.textContent = message;
      });
    } catch (err) {
      const status = document.getElementById('certRuleSaveStatus');
      if (status) status.textContent = err.message || 'Failed to delete certification from the dropdown.';
    }
  }));

document.querySelectorAll('[data-open-cert-upload]').forEach(btn => btn.addEventListener('click', () => {
    state.view = 'uploads';
    state.pendingScrollTarget = 'view-start';
    const certName = btn.dataset.openCertUpload || '';
    render();
    requestAnimationFrame(() => {
      const certSelect = document.getElementById('uploadCertName');
      if (certSelect && certName) certSelect.value = certName;
    });
  }));

  document.querySelectorAll('[data-back-to-top]').forEach(btn => btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));

  document.querySelectorAll('[data-open-bloodwork-add]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.openBloodworkAdd) state.selectedWorkerId = Number(btn.dataset.openBloodworkAdd);
    state.view = 'bloodwork';
    state.pendingScrollTarget = 'bloodwork-add-form';
    render();
  }));

  document.getElementById('saveBloodworkBtn')?.addEventListener('click', async () => {
    if (state.user?.role !== 'Admin') {
      window.alert('Only admin can add bloodwork records.');
      return;
    }
    const statusEl = document.getElementById('bloodworkAddStatus');
    if (statusEl) {
      statusEl.textContent = 'Saving bloodwork record...';
      statusEl.style.color = '';
    }
    const workerId = document.getElementById('bloodworkWorkerId')?.value;
    const testDate = String(document.getElementById('bloodworkTestDate')?.value || '').trim();
    const nextDue = String(document.getElementById('bloodworkNextDue')?.value || '').trim();
    const bll = String(document.getElementById('bloodworkBLL')?.value || '').trim();
    const zpp = String(document.getElementById('bloodworkZPP')?.value || '').trim();
    const status = String(document.getElementById('bloodworkStatus')?.value || 'Current').trim();

    if (!workerId) {
      if (statusEl) { statusEl.textContent = 'Please select a worker.'; statusEl.style.color = '#991b1b'; }
      return;
    }
    if (!testDate) {
      if (statusEl) { statusEl.textContent = 'Please enter the test date.'; statusEl.style.color = '#991b1b'; }
      return;
    }

    try {
      await api(`/api/workers/${workerId}/bloodwork`, {
        method: 'POST',
        body: { testDate, nextDue, bll, zpp, status }
      });
      state.selectedWorkerId = Number(workerId);
      await refreshData();
      render();
      window.alert('Bloodwork record added.');
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message || 'Failed to add bloodwork record.';
        statusEl.style.color = '#991b1b';
      }
    }
  });


  document.querySelectorAll('[data-delete-upload]').forEach(btn => btn.addEventListener('click', async () => {
    if (state.user?.role !== 'Admin') {
      const status = document.getElementById('uploadsActionStatus');
      if (status) status.textContent = 'Only admin can delete upload records.';
      return;
    }
    const uploadId = btn.dataset.deleteUpload;
    const confirmed = await mobileConfirm('Delete this upload record? This also removes the uploaded file from storage when one exists.', 'Delete Upload Record');
    if (!confirmed) return;
    try {
      await api(`/api/uploads/${uploadId}?deleteFile=1`, { method: 'DELETE' });
      await refreshData();
      state.view = 'uploads';
      render();
      requestAnimationFrame(() => {
        const status = document.getElementById('uploadsActionStatus');
        if (status) status.textContent = 'Upload record deleted.';
      });
    } catch (err) {
      const status = document.getElementById('uploadsActionStatus');
      if (status) status.textContent = err.message || 'Failed to delete upload record.';
    }
  }));

  document.querySelectorAll('[data-delete-cert]').forEach(btn => btn.addEventListener('click', async () => {
    if (state.user?.role !== 'Admin') {
      const status = document.getElementById('workerProfileActionStatus');
      if (status) status.textContent = 'Only admin can delete certifications.';
      return;
    }
    const [workerId, encodedName] = String(btn.dataset.deleteCert || '').split('|');
    const certName = decodeURIComponent(encodedName || '');
    const confirmed = await mobileConfirm(`Delete the certification "${certName}" from this worker? If the cert file lives in portal uploads, that file will also be removed.`, 'Delete Worker Certification');
    if (!confirmed) return;
    try {
      await api(`/api/workers/${workerId}/certifications`, { method: 'DELETE', body: { certName, deleteFile: true } });
      state.selectedWorkerId = Number(workerId);
      await refreshData();
      state.view = 'employees';
      render();
      requestAnimationFrame(() => {
        const status = document.getElementById('workerProfileActionStatus');
        if (status) status.textContent = 'Certification deleted from worker profile.';
      });
    } catch (err) {
      const status = document.getElementById('workerProfileActionStatus');
      if (status) status.textContent = err.message || 'Failed to delete certification.';
    }
  }));

  document.querySelectorAll('[data-edit-bloodwork]').forEach(btn => btn.addEventListener('click', async () => {
    if (!canManageBloodwork()) {
      setBloodworkActionStatus('Only Admin or Office can edit bloodwork records.', true);
      return;
    }
    const [workerId, rowIndex] = String(btn.dataset.editBloodwork || '').split('|');
    const worker = state.workers.find(w => String(w.id) === String(workerId));
    const bloodworkRow = worker?.bloodwork?.[Number(rowIndex)] || state.bloodwork.find(r => String(r.workerId) === String(workerId) && String(r.rowIndex) === String(rowIndex));
    if (!bloodworkRow) {
      setBloodworkActionStatus('Bloodwork record not found.', true);
      return;
    }

    const updated = await openBloodworkEditModal(workerId, rowIndex, bloodworkRow);
    if (!updated) return;

    try {
      setBloodworkActionStatus('Saving bloodwork record...');
      await api(`/api/workers/${workerId}/bloodwork/${rowIndex}`, {
        method: 'PUT',
        body: {
          testDate: updated.testDate,
          nextDue: updated.nextDue,
          bll: updated.bll,
          zpp: updated.zpp,
          status: updated.status
        }
      });
      await refreshData();
      render();
      setBloodworkActionStatus('Bloodwork record updated.');
    } catch (err) {
      setBloodworkActionStatus(err.message || 'Failed to update bloodwork record.', true);
    }
  }));

  document.querySelectorAll('[data-delete-bloodwork]').forEach(btn => btn.addEventListener('click', async () => {
    if (!canDeleteRecords()) {
      setBloodworkActionStatus('Only Admin can delete bloodwork records.', true);
      return;
    }
    const [workerId, rowIndex] = String(btn.dataset.deleteBloodwork || '').split('|');
    const confirmed = await mobileConfirm('Delete this bloodwork record? This cannot be undone.', 'Delete Bloodwork Record');
    if (!confirmed) return;
    try {
      setBloodworkActionStatus('Deleting bloodwork record...');
      await api(`/api/workers/${workerId}/bloodwork/${rowIndex}`, { method: 'DELETE' });
      await refreshData();
      render();
      setBloodworkActionStatus('Bloodwork record deleted.');
    } catch (err) {
      setBloodworkActionStatus(err.message || 'Failed to delete bloodwork record.', true);
    }
  }));

  document.getElementById('employeeSearch')?.addEventListener('input', async (e) => {
    state.employeeSearch = e.target.value;
    await refreshData();
    render();
  });

  document.getElementById('jobSearch')?.addEventListener('input', async (e) => {
    state.jobSearch = e.target.value;
    await refreshData();
    render();
  });

  document.getElementById('addWorkerBtn')?.addEventListener('click', () => {
    state.modals.worker = true; render();
  });
  document.getElementById('closeWorkerModal')?.addEventListener('click', () => {
    state.modals.worker = false; render();
  });
  document.getElementById('saveWorkerBtn')?.addEventListener('click', async () => {
    await api('/api/workers', {
      method: 'POST',
      body: {
        firstName: document.getElementById('newWorkerFirst').value,
        lastName: document.getElementById('newWorkerLast').value,
        crew: document.getElementById('newWorkerCrew').value,
        email: document.getElementById('newWorkerEmail').value,
        status: document.getElementById('newWorkerStatus').value,
        employmentStatus: document.getElementById('newWorkerEmploymentStatus').value,
        nextIssue: document.getElementById('newWorkerIssue').value,
        notes: document.getElementById('newWorkerNotes').value,
      }
    });
    state.modals.worker = false;
    await refreshData();
    render();
  });

  document.getElementById('addJobBtn')?.addEventListener('click', () => { state.modals.job = true; render(); });
  document.getElementById('closeJobModal')?.addEventListener('click', () => { state.modals.job = false; render(); });
  document.getElementById('saveJobBtn')?.addEventListener('click', async () => {
    await api('/api/jobs', {
      method: 'POST',
      body: {
        name: document.getElementById('newJobName').value,
        owner: document.getElementById('newJobOwner').value,
        stage: document.getElementById('newJobStage').value,
        notes: document.getElementById('newJobNotes').value,
        requirements: document.getElementById('newJobRequirements').value.split(',').map(x => x.trim()).filter(Boolean),
      }
    });
    state.modals.job = false;
    await refreshData();
    render();
  });

  document.getElementById('saveUploadBtn')?.addEventListener('click', async () => {
    const workerId = document.getElementById('uploadWorkerId').value;
    const worker = state.workers.find(w => String(w.id) === String(workerId));
    const selectedCertName = String(document.getElementById('uploadCertName').value || '').trim();
    const pickedFile = document.getElementById('uploadFilePicker')?.files?.[0];
    const recordName = String(document.getElementById('uploadFileName').value || pickedFile?.name || 'Untitled Upload').trim();
    const certName = selectedCertName || recordName;

    if (!workerId) {
      const proceed = window.confirm('No worker is assigned to this upload. Are you sure you want to continue?');
      if (!proceed) return;
    }

    if (!certName) {
      window.alert('Please select a certification or enter a record name.');
      return;
    }

    let fileData = '';
    if (pickedFile) {
      fileData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || '');
        reader.onerror = () => reject(new Error('File read failed'));
        reader.readAsDataURL(pickedFile);
      });
    }

    await api('/api/uploads', {
      method: 'POST',
      body: {
        file: recordName,
        originalFileName: pickedFile?.name || '',
        fileData,
        workerId: workerId || null,
        worker: worker ? worker.name : '',
        certName,
        expirationDate: document.getElementById('uploadExpirationDate').value,
        status: document.getElementById('uploadStatus').value,
        notes: document.getElementById('uploadNotes').value
      }
    });
    await refreshData();
    render();
    if (!selectedCertName && recordName) {
      window.alert(`Certification not found in dropdown. Saved using custom certification name: ${recordName}`);
    }
  });


  document.getElementById('editSelectedJob')?.addEventListener('click', () => { state.modals.jobEdit = true; render(); });
  document.querySelectorAll('[data-edit-job]').forEach(el => el.addEventListener('click', () => {
    state.selectedJobId = Number(el.dataset.editJob);
    state.modals.jobEdit = true;
    render();
  }));
  document.getElementById('closeJobEditModal')?.addEventListener('click', () => { state.modals.jobEdit = false; render(); });
  document.getElementById('updateJobBtn')?.addEventListener('click', async () => {
    await api('/api/jobs/' + state.selectedJobId, {
      method: 'PUT',
      body: {
        name: document.getElementById('editJobName').value,
        owner: document.getElementById('editJobOwner').value,
        stage: document.getElementById('editJobStage').value,
        notes: document.getElementById('editJobNotes').value,
        requirements: document.getElementById('editJobRequirements').value.split(',').map(x => x.trim()).filter(Boolean),
      }
    });
    state.modals.jobEdit = false;
    await refreshData();
    render();
  });

  document.querySelectorAll('[data-select-job]').forEach(el => el.addEventListener('click', async () => {
    state.selectedJobId = Number(el.dataset.selectJob);
    state.view = 'dashboard';
    const selected = await api('/api/jobs/' + state.selectedJobId);
    const idx = state.jobs.findIndex(j => j.id === selected.id);
    if (idx >= 0) state.jobs[idx] = selected;
    render();
  }));
}

(async function init() {
  state.dashboard = await api('/api/dashboard');
  render();
})();
