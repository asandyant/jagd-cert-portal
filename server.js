
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3001;
const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(__dirname, 'storage');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const LEGACY_STORE_PATH = path.join(__dirname, 'data', 'store.json');
const LEGACY_UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const TODAY = new Date('2026-04-17T00:00:00');

const CERT_CATALOG = [
  { name: 'Training Pack', aliases: ['Training Pack', 'Training Pack '] },
  { name: 'DOT Test', aliases: ['DOT Test', 'DOT          Test'] },
  { name: 'HAZCOM', aliases: ['HAZCOM'] },
  { name: 'HAZWOPER', aliases: ['HAZWOPER'] },
  { name: 'RCRA Hazardous Waste Gen Training', aliases: ['RCRA Hazardous Waste Gen Training', 'RCRA Haz.Wste.GenTraining'] },
  { name: 'Equipment Training', aliases: ['Equipment Training', 'Equipment Training '] },
  { name: 'Lead Awareness & Lead Standard', aliases: ['Lead Awareness & Lead Standard', 'Lead Awareness', 'Lead Awareness &  Lead Standard'] },
  { name: 'CAS Level 1', aliases: ['CAS Level 1'] },
  { name: 'CAS Level 2', aliases: ['CAS Level 2'] },
  { name: 'NJ Lead', aliases: ['NJ Lead'] },
  { name: 'TWIC', aliases: ['TWIC'] },
  { name: 'SWAC', aliases: ['SWAC'] },
  { name: 'OSHA 10/30', aliases: ['OSHA 10/30', 'OSHA 30'] },
  { name: 'C3/C5', aliases: ['C3/C5'] },
  { name: 'Coatings Inspection', aliases: ['Coatings Inspection'] },
  { name: 'NYC DOT Lead Super.', aliases: ['NYC DOT Lead Super.', 'NYC DOT Lead Super'] },
  { name: 'PFT Fit', aliases: ['PFT Fit', 'Fit Test'] },
  { name: 'CPR', aliases: ['CPR'] },
  { name: 'First Aid', aliases: ['First Aid'] },
  { name: 'Track Card', aliases: ['Track Card'] },
  { name: 'Alcohol Test', aliases: ['Alcohol Test'] },
  { name: 'Drug Test', aliases: ['Drug Test'] },
  { name: 'BLL / ZPP Current', aliases: ['BLL / ZPP Current'] }
];

function normalizeCertName(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getDynamicCertCatalog(store) {
  return (store.certCatalog || []).map(entry => ({
    name: normalizeCertName(entry.name),
    aliases: [...new Set([normalizeCertName(entry.name), ...((entry.aliases || []).map(normalizeCertName))].filter(Boolean))]
  })).filter(entry => entry.name);
}

function getCombinedCertCatalog(store) {
  const merged = new Map();
  [...CERT_CATALOG, ...getDynamicCertCatalog(store)].forEach(entry => {
    const name = normalizeCertName(entry.name);
    if (!name) return;
    const aliases = [...new Set([name, ...((entry.aliases || []).map(normalizeCertName))].filter(Boolean))];
    if (merged.has(name)) {
      const existing = merged.get(name);
      existing.aliases = [...new Set([...(existing.aliases || []), ...aliases])];
    } else {
      merged.set(name, { name, aliases });
    }
  });
  return Array.from(merged.values());
}




function makeWorkerPortalUsername(worker, used = new Set()) {
  const first = String(worker.firstName || '').trim().toLowerCase();
  const last = String(worker.lastName || '').trim().toLowerCase();
  const full = String(worker.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  let base = '';
  if (first && last) base = `${first[0]}${last}`.replace(/[^a-z0-9]+/g, '');
  else if (last) base = last.replace(/[^a-z0-9]+/g, '');
  else base = full || `worker${worker.id}`;
  let candidate = base || `worker${worker.id}`;
  let n = 1;
  while (used.has(candidate)) {
    candidate = `${base}${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function ensureWorkerPortalAccounts(store) {
  store.users = store.users || [];
  const used = new Set((store.users || []).map(u => String(u.username || '').trim().toLowerCase()));
  let changed = false
  for (const worker of (store.workers || [])) {
    if (!worker.portalUsername) {
      worker.portalUsername = makeWorkerPortalUsername(worker, used);
      changed = true;
    } else {
      used.add(String(worker.portalUsername).trim().toLowerCase());
    }
    if (!worker.portalPassword) {
      worker.portalPassword = 'worker123';
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return store;
}

function certNeedsAttentionFromStatus(status = '') {
  const s = String(status || '').toLowerCase();
  return s.includes('expired') || s.includes('overdue') || s.includes('needs attention') || s.includes('due today') || s.includes('ready for review');
}

function latestBloodworkStatus(worker) {
  const items = (worker.bloodwork || []).slice();
  if (!items.length) return null;
  items.sort((a, b) => String(b.testDate || '').localeCompare(String(a.testDate || '')));
  return items[0].status || '';
}

function certMatchState(worker, entry) {
  if (entry.name === 'BLL / ZPP Current') {
    const latestStatus = latestBloodworkStatus(worker);
    if (!latestStatus) return null;
    return certNeedsAttentionFromStatus(latestStatus) ? 'attention' : 'good';
  }
  const matched = (worker.certifications || []).find(item => entry.aliases.includes(item.name));
  if (!matched) return null;
  return certNeedsAttentionFromStatus(matched.status) ? 'attention' : 'good';
}

function certCatalogRow(store, entry) {
  const activeWorkers = (store.workers || []).filter(w => (w.employmentStatus || 'Active') === 'Active');
  const totalWorkers = store.workers || [];
  const jobsRequired = (store.jobs || []).filter(job => (job.requirements || []).some(req => entry.aliases.includes(req))).map(job => job.name);
  const uniqueAliases = [...new Set(entry.aliases.map(a => String(a).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const dynamicNames = new Set(getDynamicCertCatalog(store).map(item => normalizeCertName(item.name).toLowerCase()));

  const mapWorkers = (items, wantedState = null) => items
    .filter(worker => {
      const state = certMatchState(worker, entry);
      return wantedState ? state === wantedState : !!state;
    })
    .map(workerSummary);

  const activeGoodWorkerList = mapWorkers(activeWorkers, 'good');
  const activeNeedsAttentionWorkerList = mapWorkers(activeWorkers, 'attention');

  return {
    name: entry.name,
    aliases: uniqueAliases,
    jobsRequired,
    isDynamic: dynamicNames.has(normalizeCertName(entry.name).toLowerCase()),
    activeGood: activeGoodWorkerList.length,
    activeNeedsAttention: activeNeedsAttentionWorkerList.length,
    activeGoodWorkerList,
    activeNeedsAttentionWorkerList
  };
}


app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));



function ensureStorageSetup() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  if (!fs.existsSync(STORE_PATH) && fs.existsSync(LEGACY_STORE_PATH)) {
    fs.copyFileSync(LEGACY_STORE_PATH, STORE_PATH);
  }

  if (fs.existsSync(LEGACY_UPLOADS_DIR)) {
    for (const file of fs.readdirSync(LEGACY_UPLOADS_DIR)) {
      const oldPath = path.join(LEGACY_UPLOADS_DIR, file);
      const newPath = path.join(UPLOADS_DIR, file);
      if (fs.statSync(oldPath).isFile() && !fs.existsSync(newPath)) {
        fs.copyFileSync(oldPath, newPath);
      }
    }
  }
}

function ensureUploadsDir() {
  ensureStorageSetup();
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function safeFileName(name = '') {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned || `upload_${Date.now()}`;
}

function computeExpirationStatus(expirationDate = '') {
  if (!expirationDate) return 'Current';
  const exp = new Date(`${expirationDate}T00:00:00`);
  const diffDays = Math.floor((exp - TODAY) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'Expired';
  if (diffDays <= 30) return 'Expiring Soon';
  return 'Current';
}

function recomputeWorkerSummary(worker) {
  const certs = worker.certifications || [];
  const hasExpired = certs.some(c => String(c.status || '').includes('Expired') || String(c.status || '').includes('Needs Attention'));
  const hasExpiring = certs.some(c => String(c.status || '').includes('Expiring'));
  if (hasExpired) {
    worker.status = 'Needs Attention';
    const first = certs.find(c => String(c.status || '').includes('Expired') || String(c.status || '').includes('Needs Attention'));
    worker.nextIssue = `${first.name} requires attention`;
    return worker;
  }
  if (hasExpiring) {
    worker.status = 'Expiring Soon';
    const first = certs.find(c => String(c.status || '').includes('Expiring'));
    worker.nextIssue = `${first.name} expiring soon`;
    return worker;
  }
  worker.status = 'Qualified';
  worker.nextIssue = 'No urgent issue';
  return worker;
}

function readStore() {
  ensureStorageSetup();
  const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  if (!Array.isArray(store.certCatalog)) {
    store.certCatalog = [];
    writeStore(store);
  }
  if (store.workers) {
    let changed = false;
    store.workers = store.workers.map((worker, index) => {
      if (!worker.employmentStatus) {
        changed = true;
        return { ...worker, employmentStatus: 'Active' };
      }
      return worker;
    });
    if (changed) writeStore(store);
  }
  ensureWorkerPortalAccounts(store);
  return store;
}
function writeStore(store) {
  ensureStorageSetup();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
function deleteUploadedFile(publicPath = '') {
  const rel = String(publicPath || '').trim();
  if (!rel.startsWith('/uploads/')) return false;
  const fullPath = path.join(UPLOADS_DIR, path.basename(rel));
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    return true;
  }
  return false;
}
function daysBetween(a, b) {
  return Math.floor((a - b) / (1000 * 60 * 60 * 24));
}
function certMatches(worker, req) {
  if (req === 'BLL / ZPP Current') {
    if (!worker.bloodwork || worker.bloodwork.length === 0) return { ok: false, expiring: false };
    const sorted = [...worker.bloodwork].sort((a,b) => String(b.nextDue).localeCompare(String(a.nextDue)));
    const latest = sorted[0];
    if (!latest.nextDue || latest.nextDue === '-') return { ok: false, expiring: false };
    const nextDue = new Date(latest.nextDue + 'T00:00:00');
    const diff = daysBetween(nextDue, TODAY);
    if (diff < 0) return { ok: false, expiring: false };
    if (diff <= 7) return { ok: true, expiring: true };
    return { ok: true, expiring: false };
  }
  const cert = (worker.certifications || []).find(c => c.name === req);
  if (!cert) return { ok: false, expiring: false };
  if (cert.status === 'Expired' || cert.status === 'Needs Attention') return { ok: false, expiring: false };
  return { ok: true, expiring: cert.status === 'Expiring Soon' };
}
function classifyWorkerForJob(worker, job) {
  if ((worker.employmentStatus || 'Active') !== 'Active') return { bucket: 'inactive', missing: [] };
  let missing = [];
  let expiring = false;
  for (const req of job.requirements || []) {
    const result = certMatches(worker, req);
    if (!result.ok) missing.push(req);
    if (result.expiring) expiring = true;
  }
  if (missing.length > 0) return { bucket: 'notQualified', missing };
  if (expiring) return { bucket: 'expiring', missing: [] };
  return { bucket: 'qualified', missing: [] };
}
function workerSummary(worker) {
  return {
    id: worker.id,
    name: worker.name,
    crew: worker.crew,
    status: worker.status,
    employmentStatus: worker.employmentStatus || 'Active',
    nextIssue: worker.nextIssue
  };
}

function computeAlerts(store) {
  const workers = store.workers || [];
  const jobs = store.jobs || [];
  const uploads = store.uploads || [];
  const alerts = [];

  const activeWorkers = workers.filter(w => (w.employmentStatus || 'Active') === 'Active');
  const expiringWorkers = activeWorkers.filter(w => String(w.status || '').includes('Expiring'));
  const attentionWorkers = activeWorkers.filter(w => String(w.status || '').includes('Attention'));
  const bloodworkDue = activeWorkers.filter(w => (w.bloodwork || []).some(b => {
    const s = String(b.status || '');
    return s.includes('Due') || s.includes('Overdue');
  }));
  const reviewJobs = jobs.filter(j => (j.stage || '') === 'Needs Review');
  const pendingUploads = uploads.filter(u => !['Imported','Attached','Complete'].includes(String(u.status || '')));

  if (expiringWorkers.length) alerts.push({
    type: 'warning',
    title: 'Expiring certifications',
    detail: `${expiringWorkers.length} active worker(s) have certifications expiring soon.`,
    count: expiringWorkers.length
  });
  if (attentionWorkers.length) alerts.push({
    type: 'danger',
    title: 'Workers need attention',
    detail: `${attentionWorkers.length} active worker(s) are missing, expired, or overdue on required items.`,
    count: attentionWorkers.length
  });
  if (bloodworkDue.length) alerts.push({
    type: 'warning',
    title: 'Bloodwork due',
    detail: `${bloodworkDue.length} active worker(s) have BLL / ZPP due or overdue.`,
    count: bloodworkDue.length
  });
  if (reviewJobs.length) alerts.push({
    type: 'info',
    title: 'Jobs needing review',
    detail: `${reviewJobs.length} job(s) still need requirement review before they should be trusted for qualification.`,
    count: reviewJobs.length
  });
  if (pendingUploads.length) alerts.push({
    type: 'info',
    title: 'Uploads waiting for review',
    detail: `${pendingUploads.length} upload record(s) still need office review or attachment.`,
    count: pendingUploads.length
  });

  return alerts;
}

function dashboard(store) {
  const workers = store.workers || [];
  const activeWorkers = workers.filter(w => (w.employmentStatus || 'Active') === 'Active');
  const inactiveWorkers = workers.filter(w => (w.employmentStatus || 'Active') === 'Inactive');
  const terminatedWorkers = workers.filter(w => (w.employmentStatus || 'Active') === 'Terminated');
  const archivedWorkers = workers.filter(w => (w.employmentStatus || 'Active') === 'Archived');
  const jobs = store.jobs || [];
  const bloodworkDue = activeWorkers.filter(w => (w.bloodwork||[]).some(b => b.status === 'Due Soon' || b.status === 'Overdue')).length;
  const expiring30 = activeWorkers.filter(w => w.status === 'Expiring Soon').length;
  const attention = activeWorkers.filter(w => w.status === 'Needs Attention').length;
  const totalJobs = jobs.length;
  const activeJobs = jobs.filter(j => j.stage === 'Active').length;
  const jobsNeedingReview = jobs.filter(j => j.stage === 'Needs Review').length;
  const activeCerts = activeWorkers.reduce((sum,w)=> sum + (w.certifications||[]).length, 0);
  return {
    executiveSummary: [
      { label: 'Company baseline set', value: (store.meta?.baselineRequirements || []).join(', ') },
      { label: 'Lead-job health tracking', value: 'BLL / ZPP handled on recurring cycle' },
      { label: 'Job qualification model', value: 'Baseline + job-specific requirements' },
      { label: 'Notifications', value: 'Office digests, worker reminders, and bloodwork alerts' }
    ],
    counts: {
      employees: workers.length,
      activeWorkers: activeWorkers.length,
      inactiveWorkers: inactiveWorkers.length,
      terminatedWorkers: terminatedWorkers.length,
      archivedWorkers: archivedWorkers.length,
      activeCerts,
      expiring30,
      needsAttention: attention,
      bloodworkDue,
      activeJobs
    }
  };
}

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '').trim();
  const store = readStore();

  const fallbackUsers = [
    { username: 'admin', password: 'admin123', role: 'Admin', name: 'Admin User' },
    { username: 'office', password: 'office123', role: 'Office', name: 'Office User' },
    { username: 'pm', password: 'pm123', role: 'PM', name: 'Project Manager' }
  ];

  const storeUsers = (store.users || []).map(u => ({
    ...u,
    username: String(u.username || '').trim().toLowerCase(),
    password: String(u.password || '').trim()
  }));

  const workerUsers = (store.workers || []).map(w => ({
    username: String(w.portalUsername || '').trim().toLowerCase(),
    password: String(w.portalPassword || 'worker123').trim(),
    role: 'Worker',
    name: w.name,
    workerId: w.id
  })).filter(u => u.username);

  const allUsers = [...storeUsers, ...workerUsers, ...fallbackUsers];
  const user = allUsers.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ user: { username: user.username, role: user.role, name: user.name, workerId: user.workerId || null } });
});

app.get('/api/dashboard', (req, res) => {
  const store = readStore();
  const data = dashboard(store);
  data.auditLog = store.auditLog || [];
  data.uploads = store.uploads || [];
  data.alerts = computeAlerts(store);
  res.json(data);
});

app.get('/api/workers', (req, res) => {
  const store = readStore();
  const search = String(req.query.search || '').toLowerCase();
  const filter = String(req.query.filter || 'all');
  let workers = [...(store.workers || [])];
  if (search) {
    workers = workers.filter(w => `${w.name} ${w.crew}`.toLowerCase().includes(search));
  }
  if (filter === 'active') workers = workers.filter(w => (w.employmentStatus || 'Active') === 'Active');
  if (filter === 'inactive') workers = workers.filter(w => (w.employmentStatus || 'Active') === 'Inactive');
  if (filter === 'terminated') workers = workers.filter(w => (w.employmentStatus || 'Active') === 'Terminated');
  if (filter === 'archived') workers = workers.filter(w => (w.employmentStatus || 'Active') === 'Archived');
  if (filter === 'qualified') workers = workers.filter(w => w.status === 'Qualified');
  if (filter === 'expiring') workers = workers.filter(w => w.status === 'Expiring Soon');
  if (filter === 'attention') workers = workers.filter(w => w.status === 'Needs Attention');
  if (filter === 'bloodwork') workers = workers.filter(w => (w.bloodwork || []).length > 0);

  workers.sort((a, b) => {
    const aLast = String(a.lastName || '').trim().toLowerCase();
    const bLast = String(b.lastName || '').trim().toLowerCase();
    const aFirst = String(a.firstName || '').trim().toLowerCase();
    const bFirst = String(b.firstName || '').trim().toLowerCase();
    const aName = String(a.name || '').trim().toLowerCase();
    const bName = String(b.name || '').trim().toLowerCase();

    if (aLast && bLast) {
      if (aLast !== bLast) return aLast.localeCompare(bLast);
      return aFirst.localeCompare(bFirst);
    }

    return aName.localeCompare(bName);
  });

  res.json(workers);
});

app.get('/api/workers/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const jobsReady = (store.jobs || []).filter(j => classifyWorkerForJob(worker, j).bucket !== 'notQualified').map(j => j.name);
  res.json({ ...worker, jobsReady });
});

app.post('/api/workers', (req, res) => {
  const store = readStore();
  const body = req.body || {};
  const worker = {
    id: Date.now(),
    firstName: body.firstName || '',
    lastName: body.lastName || '',
    name: `${body.firstName || ''} ${body.lastName || ''}`.trim(),
    crew: body.crew || 'Bridge Painting',
    currentJob: body.currentJob || body.crew || '',
    status: body.status || 'Needs Attention',
    nextIssue: body.nextIssue || 'Review worker',
    employmentStatus: body.employmentStatus || 'Active',
    notes: body.notes || '',
    certifications: body.certifications || [],
    bloodwork: body.bloodwork || [],
    driverLicense: body.driverLicense || { class:'N/A', number:'-', state:'', expires:'-', status:'Needs Attention' }
  };
  store.workers.push(worker);
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action:'Added worker', detail: worker.name });
  writeStore(store);
  res.json(worker);
});

app.put('/api/workers/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const idx = store.workers.findIndex(w => w.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Worker not found' });
  const body = req.body || {};
  const existing = store.workers[idx];
  const allowedStatuses = ['Active','Inactive','Terminated','Archived'];
  store.workers[idx] = {
    ...existing,
    employmentStatus: allowedStatuses.includes(body.employmentStatus) ? body.employmentStatus : existing.employmentStatus,
    notes: body.notes ?? existing.notes,
    nextIssue: body.nextIssue ?? existing.nextIssue,
    crew: body.crew ?? existing.crew,
    currentJob: body.currentJob ?? existing.currentJob
  };
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action:'Updated worker', detail: `${store.workers[idx].name} → ${store.workers[idx].employmentStatus}` });
  writeStore(store);
  res.json(store.workers[idx]);
});

app.delete('/api/workers/:id/certifications', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });

  const body = req.body || {};
  const certName = String(body.certName || '').trim();
  if (!certName) return res.status(400).json({ error: 'Certification name is required' });

  const certIndex = (worker.certifications || []).findIndex(c => String(c.name || '').trim() === certName);
  if (certIndex === -1) return res.status(404).json({ error: 'Certification not found' });

  const cert = worker.certifications[certIndex];
  let fileDeleted = false;
  if (body.deleteFile) {
    fileDeleted = deleteUploadedFile(cert.document || '');
  }

  worker.certifications.splice(certIndex, 1);
  recomputeWorkerSummary(worker);

  store.uploads = (store.uploads || []).filter(u => !(Number(u.workerId) === id && String(u.certName || '').trim() === certName));
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action:'Deleted certification', detail: `${worker.name} · ${certName}` });
  writeStore(store);
  res.json({ ok: true, certName, fileDeleted });
});

app.post('/api/workers/:id/bloodwork', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });

  const body = req.body || {};
  const record = {
    testDate: String(body.testDate || '').trim(),
    nextDue: String(body.nextDue || '').trim(),
    bll: String(body.bll || '').trim(),
    zpp: String(body.zpp || '').trim(),
    status: String(body.status || 'Current').trim() || 'Current'
  };

  if (!record.testDate) {
    return res.status(400).json({ error: 'Test date is required' });
  }

  worker.bloodwork = Array.isArray(worker.bloodwork) ? worker.bloodwork : [];
  worker.bloodwork.unshift(record);
  recomputeWorkerSummary(worker);

  store.auditLog.unshift({
    time: new Date().toLocaleTimeString(),
    action: 'Added bloodwork',
    detail: `${worker.name} · ${record.testDate || 'Bloodwork record'}`
  });
  writeStore(store);
  res.json({ ok: true, rowIndex: 0, record });
});

app.put('/api/workers/:id/bloodwork/:rowIndex', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const rowIndex = Number(req.params.rowIndex);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  if (!Array.isArray(worker.bloodwork) || worker.bloodwork.length === 0) {
    return res.status(404).json({ error: 'Bloodwork record not found' });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= worker.bloodwork.length) {
    return res.status(404).json({ error: 'Bloodwork record not found' });
  }

  const body = req.body || {};
  const current = worker.bloodwork[rowIndex] || {};
  const updated = {
    ...current,
    testDate: body.testDate ?? current.testDate,
    nextDue: body.nextDue ?? current.nextDue,
    bll: body.bll ?? current.bll,
    zpp: body.zpp ?? current.zpp,
    status: body.status ?? current.status
  };

  worker.bloodwork[rowIndex] = updated;
  recomputeWorkerSummary(worker);

  store.auditLog.unshift({
    time: new Date().toLocaleTimeString(),
    action: 'Updated bloodwork',
    detail: `${worker.name} · ${updated.testDate || 'Bloodwork record'}`
  });
  writeStore(store);
  res.json({ ok: true, rowIndex, record: updated });
});

app.delete('/api/workers/:id/bloodwork/:rowIndex', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const rowIndex = Number(req.params.rowIndex);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  if (!Array.isArray(worker.bloodwork) || worker.bloodwork.length === 0) {
    return res.status(404).json({ error: 'Bloodwork record not found' });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= worker.bloodwork.length) {
    return res.status(404).json({ error: 'Bloodwork record not found' });
  }

  const removed = worker.bloodwork.splice(rowIndex, 1)[0];
  recomputeWorkerSummary(worker);

  store.auditLog.unshift({
    time: new Date().toLocaleTimeString(),
    action: 'Deleted bloodwork',
    detail: `${worker.name} · ${removed.testDate || 'Bloodwork record'}`
  });
  writeStore(store);
  res.json({ ok: true, rowIndex, removed });
});

app.get('/api/jobs', (req, res) => {
  const store = readStore();
  const search = String(req.query.search || '').toLowerCase();
  let jobs = [...(store.jobs || [])];
  if (search) jobs = jobs.filter(j => `${j.name} ${j.owner}`.toLowerCase().includes(search));
  const response = jobs.map(job => {
    let qualified=0, expiring=0, notQualified=0;
    for (const w of (store.workers || []).filter(w => (w.employmentStatus || 'Active') === 'Active')) {
      const result = classifyWorkerForJob(w, job).bucket;
      if (result === 'qualified') qualified++;
      else if (result === 'expiring') expiring++;
      else if (result === 'notQualified') notQualified++;
    }
    return { ...job, counts: { qualified, expiring, notQualified } };
  });
  res.json(response);
});

app.get('/api/jobs/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const job = (store.jobs || []).find(j => j.id === id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const qualified=[], expiring=[], notQualified=[];
  for (const worker of (store.workers || []).filter(w => (w.employmentStatus || 'Active') === 'Active')) {
    const result = classifyWorkerForJob(worker, job);
    const item = { ...workerSummary(worker), missing: result.missing };
    if (result.bucket === 'qualified') qualified.push(item);
    else if (result.bucket === 'expiring') expiring.push(item);
    else if (result.bucket === 'notQualified') notQualified.push(item);
  }
  res.json({ ...job, buckets: { qualified, expiring, notQualified } });
});

app.post('/api/jobs', (req, res) => {
  const store = readStore();
  const body = req.body || {};
  const job = {
    id: Date.now(),
    name: body.name || 'New Job',
    owner: body.owner || 'Review',
    stage: body.stage || 'Needs Review',
    notes: body.notes || '',
    requirements: Array.isArray(body.requirements) ? body.requirements : [],
    lastUpdated: 'Just now'
  };
  store.jobs.push(job);
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action:'Added job', detail: job.name });
  writeStore(store);
  res.json(job);
});

app.put('/api/jobs/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const idx = store.jobs.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Job not found' });
  const body = req.body || {};
  const existing = store.jobs[idx];
  store.jobs[idx] = {
    ...existing,
    name: body.name ?? existing.name,
    owner: body.owner ?? existing.owner,
    stage: body.stage ?? existing.stage,
    notes: body.notes ?? existing.notes,
    requirements: Array.isArray(body.requirements) ? body.requirements : existing.requirements,
    lastUpdated: 'Just now'
  };
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action:'Updated job', detail: store.jobs[idx].name });
  writeStore(store);
  res.json(store.jobs[idx]);
});

app.get('/api/bloodwork', (req, res) => {
  const store = readStore();
  const rows = [];
  for (const worker of store.workers || []) {
    (worker.bloodwork || []).forEach((row, rowIndex) => {
      rows.push({ workerId: worker.id, workerName: worker.name, rowIndex, ...row });
    });
  }
  rows.sort((a,b) => String(b.nextDue).localeCompare(String(a.nextDue)));
  res.json(rows);
});

app.get('/api/uploads', (req, res) => {
  const store = readStore();
  const workerId = req.query.workerId ? Number(req.query.workerId) : null;
  let uploads = store.uploads || [];
  if (workerId) uploads = uploads.filter(u => Number(u.workerId) === workerId);
  res.json(uploads);
});

app.post('/api/uploads', (req, res) => {
  const store = readStore();
  ensureUploadsDir();
  const body = req.body || {};

  let publicPath = '';
  if (body.fileData && body.originalFileName) {
    try {
      const match = String(body.fileData).match(/^data:(.+);base64,(.+)$/);
      if (match) {
        const ext = path.extname(body.originalFileName) || '';
        const fileName = `${Date.now()}_${safeFileName(path.basename(body.originalFileName, ext))}${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, fileName), Buffer.from(match[2], 'base64'));
        publicPath = `/uploads/${fileName}`;
      }
    } catch (err) {
      console.error('Failed to save upload file', err);
    }
  }

  const upload = {
    id: Date.now(),
    file: body.file || 'Untitled Upload',
    originalFileName: body.originalFileName || '',
    filePath: publicPath,
    worker: body.worker || 'Unassigned',
    workerId: body.workerId ? Number(body.workerId) : null,
    certName: body.certName || '',
    expirationDate: body.expirationDate || '',
    notes: body.notes || '',
    status: body.status || 'Needs Review',
    createdAt: new Date().toISOString()
  };

  if (upload.workerId && upload.certName) {
    const worker = (store.workers || []).find(w => w.id === upload.workerId);
    if (worker) {
      worker.certifications = worker.certifications || [];
      const status = computeExpirationStatus(upload.expirationDate);
      const existingIndex = worker.certifications.findIndex(c => c.name === upload.certName);
      const updatedCert = {
        name: upload.certName,
        status,
        date: upload.expirationDate || '',
        document: publicPath || upload.originalFileName || upload.file
      };
      if (existingIndex >= 0) {
        worker.certifications[existingIndex] = { ...worker.certifications[existingIndex], ...updatedCert };
      } else {
        worker.certifications.push(updatedCert);
      }
      recomputeWorkerSummary(worker);
      upload.status = 'Attached';
    }
  }

  store.uploads.unshift(upload);
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action: 'Added upload', detail: `${upload.file} → ${upload.worker}` });
  writeStore(store);
  res.json(upload);
});

app.delete('/api/uploads/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const idx = (store.uploads || []).findIndex(u => Number(u.id) === id);
  if (idx === -1) return res.status(404).json({ error: 'Upload not found' });

  const upload = store.uploads[idx];
  let fileDeleted = false;
  if (String(req.query.deleteFile || '') === '1') {
    fileDeleted = deleteUploadedFile(upload.filePath || '');
  }

  store.uploads.splice(idx, 1);
  store.auditLog.unshift({ time: new Date().toLocaleTimeString(), action: 'Deleted upload', detail: `${upload.file} → ${upload.worker}` });
  writeStore(store);
  res.json({ ok: true, id, fileDeleted });
});

app.get('/api/alerts', (req, res) => {
  const store = readStore();
  res.json(computeAlerts(store));
});

app.get('/api/certs', (req, res) => {
  const store = readStore();
  const catalog = getCombinedCertCatalog(store);
  const rows = catalog.map(entry => certCatalogRow(store, entry));
  res.json({
    certs: rows,
    workbookSource: 'Worker Summary Sheet 2026.xlsx',
    note: 'Certification catalog built from the worker summary sheet columns plus portal aliases.',
    dynamicCount: (store.certCatalog || []).length
  });
});

app.post('/api/certs/catalog', (req, res) => {
  const store = readStore();
  const name = normalizeCertName(req.body?.name);
  const aliasText = String(req.body?.alias || '').trim();
  if (!name) {
    return res.status(400).send('Certification name is required.');
  }

  const combined = getCombinedCertCatalog(store);
  const existing = combined.find(entry =>
    normalizeCertName(entry.name).toLowerCase() === name.toLowerCase() ||
    (entry.aliases || []).some(alias => normalizeCertName(alias).toLowerCase() === name.toLowerCase())
  );

  if (existing) {
    return res.json({ ok: true, added: false, name: existing.name, message: 'Certification already exists in the dropdown.' });
  }

  const aliases = [...new Set([name, ...aliasText.split(',').map(normalizeCertName).filter(Boolean)])];
  store.certCatalog = Array.isArray(store.certCatalog) ? store.certCatalog : [];
  store.certCatalog.push({ name, aliases });
  store.auditLog = store.auditLog || [];
  store.auditLog.unshift({
    time: new Date().toLocaleTimeString(),
    action: 'Added certification to dropdown',
    detail: aliasText ? `${name} (aliases: ${aliasText})` : name
  });
  writeStore(store);
  res.json({ ok: true, added: true, name, aliases });
});

app.delete('/api/certs/catalog', (req, res) => {
  const store = readStore();
  const name = normalizeCertName(req.body?.name);
  if (!name) {
    return res.status(400).send('Certification name is required.');
  }

  store.certCatalog = Array.isArray(store.certCatalog) ? store.certCatalog : [];
  const before = store.certCatalog.length;
  store.certCatalog = store.certCatalog.filter(entry => normalizeCertName(entry.name).toLowerCase() !== name.toLowerCase());

  if (store.certCatalog.length === before) {
    return res.status(404).send('Certification was not found in the dropdown-only list. Built-in certifications cannot be deleted here.');
  }

  store.auditLog = store.auditLog || [];
  store.auditLog.unshift({
    time: new Date().toLocaleTimeString(),
    action: 'Deleted certification from dropdown',
    detail: name
  });
  writeStore(store);
  res.json({ ok: true, deleted: true, name, message: 'Certification removed from the dropdown. Existing worker records and upload history were not changed.' });
});



function currentDateLabel() {
  return TODAY.toLocaleDateString('en-US');
}

function formatDigestBody(store) {
  const alerts = computeAlerts(store);
  const counts = dashboard(store).counts || {};
  const lines = [
    `JAGD Cert Portal Daily Digest - ${currentDateLabel()}`,
    '',
    'Summary',
    `- Active workers: ${counts.activeWorkers || 0}`,
    `- Expiring 30 days: ${counts.expiring30 || 0}`,
    `- Needs attention: ${counts.needsAttention || 0}`,
    `- Jobs needing review: ${counts.jobsNeedingReview || 0}`,
    '',
    'Action Items',
    ...(alerts.length ? alerts.map(a => `- ${a.title}: ${a.detail}`) : ['- No active alerts right now.']),
    '',
    'Sent automatically by the JAGD Cert Portal.'
  ];
  return lines.join('\n');
}

let digestSchedulerStarted = false;

function startDigestScheduler() {
  if (digestSchedulerStarted) return;
  digestSchedulerStarted = true;
  try {
    const cron = require('node-cron');
    cron.schedule('0 6 * * *', async () => {
      try {
        await sendDigestEmail(readStore());
      } catch (err) {
        console.error('Daily digest send failed', err);
      }
    }, { timezone: 'America/New_York' });
    console.log('Daily digest scheduler started for 6:00 AM America/New_York');
  } catch (err) {
    console.error('Failed to start digest scheduler', err);
  }
}

function buildOfficeDigest(store) {
  const recipients = process.env.ALERTS_TO || process.env.SMTP_USER || '';
  return {
    subject: `JAGD Cert Portal Daily Digest - ${currentDateLabel()}`,
    body: formatDigestBody(store),
    recipients
  };
}

function buildOfficeDigestText(store) {
  return buildOfficeDigest(store).body;
}

async function sendTestDigestEmail(store) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.ALERTS_FROM || user;
  const to = process.env.ALERTS_TO || user;

  if (!host || !user || !pass || !from || !to) {
    throw new Error('Missing SMTP environment variables.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: { user, pass },
    tls: { minVersion: 'TLSv1.2' }
  });

  const subject = `JAGD Test Digest — ${new Date().toLocaleString()}`;
  const text = buildOfficeDigestText(store);

  await transporter.sendMail({
    from,
    to,
    subject,
    text
  });

  return { to, from, subject };
}


async function sendDigestEmail(store) {
  const nodemailer = require('nodemailer');
  const digest = buildOfficeDigest(store);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const info = await transporter.sendMail({
    from: process.env.ALERTS_FROM || process.env.SMTP_USER,
    to: digest.recipients || process.env.ALERTS_TO,
    subject: digest.subject,
    text: digest.body
  });

  return info;
}

app.post('/api/send-test-digest', async (req, res) => {
  try {
    const store = readStore();
    await sendDigestEmail(store);
    store.auditLog = store.auditLog || [];
    store.auditLog.unshift({
      time: new Date().toLocaleTimeString(),
      action: 'Sent test digest',
      detail: process.env.ALERTS_TO || 'Digest recipient not set'
    });
    writeStore(store);
    res.json({ ok: true, message: 'Test digest sent successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send test digest.' });
  }
});


app.get('/api/worker-portal/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const uploads = (store.uploads || []).filter(u => Number(u.workerId) === id);
  const alerts = [];
  const certAttention = (worker.certifications || []).filter(c => ['Expiring Soon','Expired','Needs Attention'].includes(String(c.status || '')));
  const bloodworkAttention = (worker.bloodwork || []).filter(b => ['Due Soon','Overdue','Needs Attention'].includes(String(b.status || '')));
  if (certAttention.length) alerts.push({ title: 'Certification alerts', detail: `${certAttention.length} certification item(s) need attention.` });
  if (bloodworkAttention.length) alerts.push({ title: 'Bloodwork alerts', detail: `${bloodworkAttention.length} bloodwork item(s) need attention.` });
  const jobsReady = (store.jobs || []).filter(j => classifyWorkerForJob(worker, j).bucket !== 'notQualified').map(j => j.name);
  res.json({
    worker: { ...worker, jobsReady },
    uploads,
    alerts
  });
});

app.get('/api/admin', (req, res) => {
  const store = readStore();
  res.json({
    baselineRequirements: store.meta?.baselineRequirements || [],
    reminderRules: store.meta?.reminderRules || [],
    importStatus: [
      { label: 'Workers imported', value: `${store.workers.length} worker records loaded` },
      { label: 'Active workers', value: `${store.workers.filter(w => (w.employmentStatus || 'Active') === 'Active').length} active workers currently counted in job readiness` },
      { label: 'Inactive workers', value: `${store.workers.filter(w => (w.employmentStatus || 'Active') === 'Inactive').length} inactive workers kept off current job counts` },
      { label: 'Terminated workers', value: `${store.workers.filter(w => (w.employmentStatus || 'Active') === 'Terminated').length} terminated records kept for history` },
      { label: 'Archived workers', value: `${store.workers.filter(w => (w.employmentStatus || 'Active') === 'Archived').length} archived records hidden from active planning` },
      { label: 'Jobs imported', value: `${store.jobs.length} current jobs loaded` },
      { label: 'Driver license records', value: `${store.workers.filter(w => w.driverLicense && w.driverLicense.number !== '-').length} workers with DL records` },
      { label: 'Storage mode', value: 'JSON file store for launchable demo' }
    ],
    auditLog: store.auditLog || []
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

startDigestScheduler();

app.listen(PORT, () => {
  console.log(`JAGD portal running on http://localhost:${PORT}`);
});
