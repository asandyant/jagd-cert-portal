
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



function auditTimestamp() {
  return new Date().toISOString();
}

function getAuditActor(req) {
  const username = String(req.headers['x-actor-username'] || '').trim();
  const role = String(req.headers['x-actor-role'] || '').trim();
  const name = String(req.headers['x-actor-name'] || '').trim();
  return {
    username: username || 'system',
    role: role || (username ? 'User' : 'System'),
    name: name || username || 'System'
  };
}


function requireAdmin(req, res) {
  const role = String(getAuditActor(req).role || '').trim();
  if (role !== 'Admin') {
    res.status(403).send('Admin access required.');
    return false;
  }
  return true;
}

function requireAdminOrOffice(req, res) {
  const role = String(getAuditActor(req).role || '').trim();
  if (!['Admin', 'Office'].includes(role)) {
    res.status(403).send('Admin or Office access required.');
    return false;
  }
  return true;
}

function appendAuditLog(store, req, action, detail, extra = {}) {
  store.auditLog = Array.isArray(store.auditLog) ? store.auditLog : [];
  const actor = getAuditActor(req);
  store.auditLog.unshift({
    time: auditTimestamp(),
    action,
    detail,
    actorName: actor.name,
    actorRole: actor.role,
    actorUsername: actor.username,
    ...extra
  });
  if (store.auditLog.length > 500) store.auditLog = store.auditLog.slice(0, 500);
}

function cleanReminderDays(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const cleaned = source
    .map(item => Number(String(item).trim()))
    .filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
  const unique = [...new Set(cleaned)];
  return unique.length ? unique.sort((a, b) => b - a) : [30, 14, 7, 0];
}

function getEmailAlertSettings(store) {
  store.meta = store.meta || {};
  const existing = store.meta.emailAlerts || {};
  const settings = {
    workerAlertsEnabled: existing.workerAlertsEnabled === true,
    officeDigestEnabled: existing.officeDigestEnabled !== false,
    reminderDays: cleanReminderDays(existing.reminderDays || [30, 14, 7, 0]),
    sendHour: Number.isFinite(Number(existing.sendHour)) ? Number(existing.sendHour) : 6,
    testRecipient: existing.testRecipient || process.env.ALERTS_TO || process.env.SMTP_USER || '',
    lastWorkerAutoRunDate: existing.lastWorkerAutoRunDate || '',
    lastWorkerManualRunAt: existing.lastWorkerManualRunAt || '',
    lastWorkerTestAt: existing.lastWorkerTestAt || '',
    lastWorkerEmailSends: existing.lastWorkerEmailSends && typeof existing.lastWorkerEmailSends === 'object' ? existing.lastWorkerEmailSends : {}
  };
  store.meta.emailAlerts = settings;
  return settings;
}

function defaultCertificationAlertRules() {
  return [
    { certName: 'Training Pack', aliases: ['Training Pack'], enabled: true, expirationDays: 365, reminderDays: 30, note: 'Annual training pack renewal.' },
    { certName: 'PFT Fit', aliases: ['PFT Fit', 'Fit Test'], enabled: true, expirationDays: 365, reminderDays: 30, note: 'Annual fit test reminder.' },
    { certName: 'OSHA 10/30', aliases: ['OSHA 10/30', 'OSHA 30'], enabled: true, expirationDays: 1825, reminderDays: 30, note: 'Flag OSHA 30 older than 5 years when jobs require recent OSHA.' },
    { certName: 'BLL / ZPP Current', aliases: ['BLL / ZPP Current', 'Bloodwork'], enabled: true, expirationDays: 30, reminderDays: 7, note: 'Typical 30-day bloodwork cycle for lead work.' }
  ];
}

function sanitizeCertificationAlertRule(rule = {}) {
  const certName = normalizeCertName(rule.certName || rule.name || '');
  if (!certName) return null;
  const aliases = Array.isArray(rule.aliases) ? rule.aliases.map(normalizeCertName).filter(Boolean) : [];
  const expirationDays = Number(rule.expirationDays ?? rule.days ?? 365);
  const reminderDays = Number(rule.reminderDays ?? 30);
  return {
    certName,
    aliases: [...new Set([certName, ...aliases].filter(Boolean))],
    enabled: rule.enabled !== false,
    expirationDays: Number.isFinite(expirationDays) && expirationDays >= 0 && expirationDays <= 3650 ? expirationDays : 365,
    reminderDays: Number.isFinite(reminderDays) && reminderDays >= 0 && reminderDays <= 365 ? reminderDays : 30,
    note: String(rule.note || '').trim()
  };
}

function getCertificationAlertRules(store) {
  store.meta = store.meta || {};
  const existing = Array.isArray(store.meta.certificationAlertRules) ? store.meta.certificationAlertRules : null;
  const source = existing && existing.length ? existing : defaultCertificationAlertRules();
  const rules = source.map(sanitizeCertificationAlertRule).filter(Boolean);
  store.meta.certificationAlertRules = rules;
  return rules;
}

function findCertificationAlertRule(store, certName = '') {
  const normalized = normalizeCertName(certName).toLowerCase();
  if (!normalized) return null;
  return getCertificationAlertRules(store).find(rule => {
    if (rule.enabled === false) return false;
    return (rule.aliases || []).some(alias => normalizeCertName(alias).toLowerCase() === normalized);
  }) || null;
}

function isIsoDate(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function addDaysToIsoDate(value = '', days = 0) {
  if (!isIsoDate(value)) return '';
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function firstIsoDate(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (isIsoDate(text)) return text;
  }
  return '';
}

function resolveCertificationAlertDate(store, cert = {}) {
  const certName = normalizeCertName(cert.name || cert.certName || 'Certification');
  const rule = findCertificationAlertRule(store, certName);

  // Option 1 safety rule: keep existing expiration dates exactly as entered.
  // Certification rules only help when no usable expiration date exists.
  const enteredExpiration = firstIsoDate(
    cert.expirationDate,
    cert.expires,
    cert.expiry,
    cert.expiration,
    cert.date
  );

  if (enteredExpiration) {
    return {
      expirationDate: enteredExpiration,
      rule,
      ruleApplied: false,
      missingExpiration: false,
      reasonPrefix: ''
    };
  }

  if (!rule) {
    return {
      expirationDate: '',
      rule: null,
      ruleApplied: false,
      missingExpiration: true,
      reasonPrefix: ''
    };
  }

  const sourceDate = firstIsoDate(
    cert.issueDate,
    cert.issuedDate,
    cert.completedDate,
    cert.completionDate,
    cert.trainingDate,
    cert.uploadedAt,
    cert.createdAt
  );

  if (sourceDate && Number(rule.expirationDays || 0) > 0) {
    return {
      expirationDate: addDaysToIsoDate(sourceDate, Number(rule.expirationDays || 0)),
      rule,
      ruleApplied: true,
      missingExpiration: false,
      reasonPrefix: `Rule-based from ${sourceDate}; `
    };
  }

  return {
    expirationDate: '',
    rule,
    ruleApplied: true,
    missingExpiration: true,
    reasonPrefix: `Missing expiration date; ${rule.certName} rule requires renewal every ${rule.expirationDays} day(s).`
  };
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function dateKeyNY(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function hourNY(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false
  }).format(date));
}

function createMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Missing SMTP environment variables.');
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: { user, pass },
    tls: { minVersion: 'TLSv1.2' }
  });
}

function workerReminderThreshold(daysUntil, settings, maxWindow = 30) {
  if (daysUntil === null || daysUntil === undefined || !Number.isFinite(Number(daysUntil))) return null;
  const value = Number(daysUntil);
  if (value < 0) return { key: 'expired', label: 'Expired' };
  if (value === 0) return { key: 'due-today', label: 'Due today' };
  const schedule = cleanReminderDays(settings.reminderDays || [30, 14, 7, 0])
    .filter(day => day > 0 && day <= Number(maxWindow || 30))
    .sort((a, b) => a - b);
  const threshold = schedule.find(day => value <= day);
  return threshold === undefined ? null : { key: `${threshold}-days`, label: `${threshold}-day reminder` };
}

function workerReminderSendKey(item = {}) {
  return [
    item.workerId || 'worker',
    normalizeCertName(item.certName || 'cert').toLowerCase(),
    item.expirationDate || '-',
    item.timingKey || item.thresholdKey || 'attention'
  ].join('|');
}

function wasWorkerReminderAlreadySent(settings, item = {}) {
  const key = workerReminderSendKey(item);
  return !!(settings.lastWorkerEmailSends || {})[key];
}

function markWorkerReminderSent(settings, item = {}) {
  settings.lastWorkerEmailSends = settings.lastWorkerEmailSends && typeof settings.lastWorkerEmailSends === 'object' ? settings.lastWorkerEmailSends : {};
  settings.lastWorkerEmailSends[workerReminderSendKey(item)] = auditTimestamp();
}

function workerCertReminderItems(store, options = {}) {
  const settings = getEmailAlertSettings(store);
  getCertificationAlertRules(store);
  const includeAlreadySent = options.includeAlreadySent !== false;
  const activeWorkers = (store.workers || []).filter(worker => (worker.employmentStatus || 'Active') === 'Active');
  const rows = [];

  activeWorkers.forEach(worker => {
    const email = normalizeEmail(worker.email || worker.workerEmail || '');
    (worker.certifications || []).forEach(cert => {
      const certName = normalizeCertName(cert.name || 'Certification');
      const resolved = resolveCertificationAlertDate(store, cert);
      const expirationDate = resolved.expirationDate;
      let status = String(cert.status || '').trim();
      let daysUntil = null;

      if (expirationDate && isIsoDate(expirationDate)) {
        status = status || computeExpirationStatus(expirationDate);
        const exp = new Date(`${expirationDate}T00:00:00`);
        daysUntil = Math.floor((exp - TODAY) / (1000 * 60 * 60 * 24));
      }

      if (resolved.missingExpiration && resolved.rule) {
        status = 'Needs Attention';
      }

      status = status || 'Current';
      const ruleReminderDays = resolved.rule ? Number(resolved.rule.reminderDays || 30) : Math.max(...cleanReminderDays(settings.reminderDays || [30, 14, 7, 0]));
      const reminderWindow = Number.isFinite(ruleReminderDays) ? ruleReminderDays : 30;
      let timing = workerReminderThreshold(daysUntil, settings, reminderWindow);

      if (!timing && resolved.missingExpiration && resolved.rule) {
        timing = { key: 'missing-expiration', label: 'Missing expiration' };
      }
      if (!timing && (status.includes('Expired') || status.includes('Needs Attention'))) {
        timing = { key: status.includes('Expired') ? 'expired-status' : 'needs-attention', label: status.includes('Expired') ? 'Expired' : 'Needs attention' };
      }
      if (!timing && status.includes('Expiring')) {
        timing = { key: 'expiring-status', label: 'Expiring soon' };
      }

      const shouldInclude = !!timing;
      if (!shouldInclude) return;

      const reason = resolved.missingExpiration && resolved.rule
        ? resolved.reasonPrefix
        : daysUntil !== null && daysUntil < 0
          ? `${resolved.reasonPrefix}Expired`
          : daysUntil !== null
            ? `${resolved.reasonPrefix}${daysUntil} day(s) until expiration`
            : status;

      const row = {
        workerId: worker.id,
        workerName: worker.name,
        email,
        hasValidEmail: isValidEmail(email),
        certName,
        expirationDate: expirationDate || '-',
        status,
        daysUntil,
        currentJob: worker.currentJob || worker.crew || '-',
        reason,
        ruleApplied: !!resolved.ruleApplied,
        ruleName: resolved.rule?.certName || '',
        timingKey: timing.key,
        timingLabel: timing.label,
        alreadySent: false,
        readyToSend: false
      };
      row.alreadySent = wasWorkerReminderAlreadySent(settings, row);
      row.readyToSend = !row.alreadySent;
      if (!includeAlreadySent && row.alreadySent) return;
      rows.push(row);
    });
  });

  return rows.sort((a, b) => {
    if (a.alreadySent !== b.alreadySent) return a.alreadySent ? 1 : -1;
    const da = a.daysUntil === null ? 9999 : a.daysUntil;
    const db = b.daysUntil === null ? 9999 : b.daysUntil;
    if (da !== db) return da - db;
    return String(a.workerName || '').localeCompare(String(b.workerName || ''));
  });
}

function groupWorkerReminderItems(items) {
  const grouped = new Map();
  items.forEach(item => {
    const key = String(item.workerId || item.workerName || item.email);
    if (!grouped.has(key)) {
      grouped.set(key, {
        workerId: item.workerId,
        workerName: item.workerName,
        email: item.email,
        hasValidEmail: item.hasValidEmail,
        items: []
      });
    }
    const group = grouped.get(key);
    group.items.push(item);
    group.readyToSend = group.items.some(row => row.readyToSend);
    group.alreadySentCount = group.items.filter(row => row.alreadySent).length;
  });
  return Array.from(grouped.values());
}

function buildWorkerReminderBody(workerGroup, testMode = false) {
  const workerName = workerGroup.workerName || 'Worker';
  const lines = [
    'JAGD Certification Alert',
    '',
    `Hello ${workerName},`,
    '',
    'Our records show the following certification item(s) are expired, missing an expiration date, or are coming up for renewal:',
    '',
    ...workerGroup.items.map(item => {
      const certName = item.certName || 'Certification';
      const status = item.status || 'Needs Attention';
      const expirationDate = item.expirationDate && item.expirationDate !== '-' ? item.expirationDate : 'No expiration date on file';
      const reason = item.reason || item.timingLabel || '';
      const note = reason ? ` — ${reason}` : '';
      return `- ${certName}: ${status}; expires ${expirationDate}${note}`;
    }),
    '',
    'Please upload the updated certification in the JAGD Worker Portal or send it to the office for review.',
    '',
    'If you believe any certification listed above is no longer required for your current work, please contact an administrator to have it reviewed and removed from your profile.',
    '',
    'Thank you,',
    'JAGD Construction',
    '',
    'This message was sent automatically by the JAGD Cert Portal.'
  ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
  return lines.join('\n');
}

function workerReminderPreview(store) {
  const settings = getEmailAlertSettings(store);
  const items = workerCertReminderItems(store, { includeAlreadySent: true });
  const grouped = groupWorkerReminderItems(items);
  const readyGroups = grouped.filter(group => group.hasValidEmail && group.readyToSend);
  return {
    settings,
    totalWorkersWithAlerts: grouped.length,
    totalCertItems: items.length,
    readyWorkerEmails: readyGroups.length,
    readyCertItems: items.filter(item => item.readyToSend).length,
    alreadySentCertItems: items.filter(item => item.alreadySent).length,
    workersWithValidEmail: grouped.filter(group => group.hasValidEmail).length,
    workersMissingEmail: grouped.filter(group => !group.hasValidEmail).length,
    rows: grouped.map(group => ({
      workerId: group.workerId,
      workerName: group.workerName,
      email: group.email || '',
      hasValidEmail: group.hasValidEmail,
      readyToSend: !!group.readyToSend,
      alreadySentCount: group.alreadySentCount || 0,
      itemCount: group.items.length,
      summary: group.items.map(item => `${item.certName} (${item.status}, ${item.expirationDate}, ${item.timingLabel}${item.alreadySent ? ', already sent' : ''})`).join('; '),
      items: group.items
    }))
  };
}

async function sendWorkerReminderEmails(store, options = {}) {
  const settings = getEmailAlertSettings(store);
  const testMode = options.testMode === true;
  const force = options.force === true;
  const testRecipient = normalizeEmail(options.testRecipient || settings.testRecipient || process.env.ALERTS_TO || process.env.SMTP_USER || '');

  if (!testMode && !settings.workerAlertsEnabled && !force) {
    return { sent: 0, skipped: 0, message: 'Worker email alerts are turned off.' };
  }

  const preview = workerReminderPreview(store);
  const groups = preview.rows
    .map(group => ({ ...group, items: (group.items || []).filter(item => item.readyToSend !== false) }))
    .filter(group => (group.items || []).length > 0);
  const transporter = createMailTransporter();
  const from = process.env.ALERTS_FROM || process.env.SMTP_USER;
  const sent = [];
  const skipped = [];

  if (testMode) {
    if (!isValidEmail(testRecipient)) throw new Error('A valid test recipient email is required.');
    const sample = groups[0] || {
      workerName: 'Sample Worker',
      email: testRecipient,
      hasValidEmail: true,
      items: [{ certName: 'Sample Certification', status: 'Expiring Soon', expirationDate: 'YYYY-MM-DD', reason: '30 day(s) until expiration' }]
    };
    const body = buildWorkerReminderBody(sample, true);
    const subject = 'JAGD Certification Alert — Your certifications are set to expire or need attention';
    await transporter.sendMail({ from, to: testRecipient, subject, text: body });
    settings.lastWorkerTestAt = auditTimestamp();
    store.meta.emailAlerts = settings;
    return { sent: 1, skipped: 0, to: testRecipient, subject, message: `Test worker alert sent to ${testRecipient}.` };
  }

  for (const group of groups) {
    if (!group.hasValidEmail) {
      skipped.push({ workerName: group.workerName, reason: 'Missing worker email' });
      continue;
    }
    const itemCount = (group.items || []).length;
    const subject = 'JAGD Certification Alert — Your certifications are set to expire or need attention';
    const body = buildWorkerReminderBody(group, false);
    await transporter.sendMail({ from, to: group.email, subject, text: body });
    (group.items || []).forEach(item => markWorkerReminderSent(settings, item));
    sent.push({ workerName: group.workerName, email: group.email, itemCount });
  }

  settings.lastWorkerManualRunAt = auditTimestamp();
  store.meta.emailAlerts = settings;
  return { sent: sent.length, skipped: skipped.length, sentRows: sent, skippedRows: skipped };
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
  let n = 2;
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
    if (typeof worker.portalMustChangePassword !== 'boolean') {
      worker.portalMustChangePassword = true;
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return store;
}


function managedPortalAccounts(store) {
  const fallbackUsers = [
    { username: 'admin', password: 'admin123', role: 'Admin', name: 'Admin User', resettable: false },
    { username: 'office', password: 'office123', role: 'Office', name: 'Office User', resettable: true },
    { username: 'pm', password: 'pm123', role: 'PM', name: 'Project Manager', resettable: true }
  ];
  const storeUsers = Array.isArray(store.users) ? store.users : [];
  return fallbackUsers.map(base => {
    const saved = storeUsers.find(u => String(u.username || '').trim().toLowerCase() === base.username);
    const activePassword = String(saved?.password || base.password || '').trim();
    const defaultActive = activePassword === base.password;
    return {
      username: base.username,
      role: base.role,
      name: saved?.name || base.name,
      resettable: base.resettable,
      defaultPassword: base.password,
      passwordStatus: defaultActive ? 'Default Password Active' : 'Password Changed'
    };
  });
}


function getPortalAccessAccounts(store) {
  const baseAccounts = managedPortalAccounts(store).map(item => ({
    name: item.name,
    username: item.username,
    role: item.role,
    email: '',
    active: true,
    passwordStatus: item.passwordStatus,
    tempPassword: item.passwordStatus === 'Default Password Active' ? item.defaultPassword : 'Hidden',
    resettable: item.resettable,
    source: 'System Default',
    mustChangePassword: false
  }));

  const baseMap = new Map(baseAccounts.map(item => [String(item.username || '').toLowerCase(), item]));
  const customUsers = (store.users || [])
    .filter(user => !baseMap.has(String(user.username || '').trim().toLowerCase()))
    .map(user => ({
      name: user.name || user.username,
      username: String(user.username || '').trim().toLowerCase(),
      role: user.role || 'Office',
      email: normalizeEmail(user.email || ''),
      active: user.active !== false,
      passwordStatus: user.password && user.tempPassword && user.password === user.tempPassword ? 'Temp Password Active' : 'Password Changed',
      tempPassword: user.password && user.tempPassword && user.password === user.tempPassword ? user.tempPassword : 'Hidden',
      resettable: String(user.role || '').trim() !== 'Admin',
      source: 'Portal Access',
      mustChangePassword: !!user.mustChangePassword
    }));

  return [...baseAccounts, ...customUsers].sort((a, b) => {
    const roleCmp = String(a.role || '').localeCompare(String(b.role || ''));
    if (roleCmp !== 0) return roleCmp;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
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


app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
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
  if (!Array.isArray(store.auditLog)) {
    store.auditLog = [];
    writeStore(store);
  }
  getEmailAlertSettings(store);
  getCertificationAlertRules(store);
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

function sanitizeWorkerForResponse(req, worker) {
  const actorRole = String(getAuditActor(req).role || '').trim();
  const safeWorker = { ...worker };
  // Worker passwords should not be exposed to Office, PM, or Worker views.
  // Admin can reset passwords when needed, but routine pages should not reveal them.
  if (actorRole !== 'Admin') {
    safeWorker.portalPassword = '';
  }
  return safeWorker;
}

function sanitizeWorkersForResponse(req, workers = []) {
  return workers.map(worker => sanitizeWorkerForResponse(req, worker));
}

function computeAlerts(store) {
  const workers = store.workers || [];
  const jobs = store.jobs || [];
  const uploads = store.uploads || [];
  const alerts = [];

  const activeWorkers = workers.filter(w => (w.employmentStatus || 'Active') === 'Active');
  const certReminderRows = workerCertReminderItems(store);
  const certAttentionIds = new Set(certReminderRows
    .filter(row => String(row.status || '').includes('Expired') || String(row.status || '').includes('Needs Attention'))
    .map(row => String(row.workerId)));
  const certExpiringIds = new Set(certReminderRows
    .filter(row => String(row.status || '').includes('Expiring') || (row.daysUntil !== null && row.daysUntil >= 0))
    .map(row => String(row.workerId)));

  const expiringWorkers = activeWorkers.filter(w =>
    String(w.status || '').includes('Expiring') || certExpiringIds.has(String(w.id))
  );
  const attentionWorkers = activeWorkers.filter(w =>
    String(w.status || '').includes('Attention') || certAttentionIds.has(String(w.id))
  );
  const bloodworkDue = activeWorkers.filter(w => (w.bloodwork || []).some(b => {
    const s = String(b.status || '');
    return s.includes('Due') || s.includes('Overdue');
  }));
  const reviewJobs = jobs.filter(j => (j.stage || '') === 'Needs Review');
  const pendingUploads = uploads.filter(u => !['Imported','Attached','Complete'].includes(String(u.status || '')));

  if (expiringWorkers.length) alerts.push({
    type: 'warning',
    title: 'Expiring certifications',
    detail: `${expiringWorkers.length} active worker(s) have certifications expiring soon or within rule reminder windows.`,
    count: expiringWorkers.length
  });
  if (attentionWorkers.length) alerts.push({
    type: 'danger',
    title: 'Workers need attention',
    detail: `${attentionWorkers.length} active worker(s) are missing, expired, overdue, or missing required expiration information.`,
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

  // Emergency built-in access path so the portal can always be recovered.
  if (username === 'admin' && password === 'admin123') {
    return res.json({ user: { username: 'admin', role: 'Admin', name: 'Admin User', workerId: null, email: '', mustChangePassword: false, mustCompleteSetup: false } });
  }
  if (username === 'office' && password === 'office123') {
    return res.json({ user: { username: 'office', role: 'Office', name: 'Office User', workerId: null, email: '', mustChangePassword: false, mustCompleteSetup: false } });
  }
  if (username === 'pm' && password === 'pm123') {
    return res.json({ user: { username: 'pm', role: 'PM', name: 'Project Manager', workerId: null, email: '', mustChangePassword: false, mustCompleteSetup: false } });
  }

  const fallbackUsers = [
    { username: 'admin', password: 'admin123', role: 'Admin', name: 'Admin User' },
    { username: 'office', password: 'office123', role: 'Office', name: 'Office User' },
    { username: 'pm', password: 'pm123', role: 'PM', name: 'Project Manager' }
  ];

  const storeUsers = (store.users || []).map(u => ({
    ...u,
    username: String(u.username || '').trim().toLowerCase(),
    password: String(u.password || '').trim(),
    email: normalizeEmail(u.email || ''),
    mustChangePassword: !!u.mustChangePassword,
    active: u.active !== false,
    source: 'Portal Access'
  })).filter(u => u.active !== false);

  const workerUsers = (store.workers || []).map(w => ({
    username: String(w.portalUsername || '').trim().toLowerCase(),
    password: String(w.portalPassword || 'worker123').trim(),
    role: 'Worker',
    name: w.name,
    workerId: w.id,
    email: normalizeEmail(w.email || w.workerEmail || ''),
    mustChangePassword: !!w.portalMustChangePassword
  })).filter(u => u.username);

  const allUsers = [...storeUsers, ...workerUsers, ...fallbackUsers];
  const user = allUsers.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const email = normalizeEmail(user.email || '');
  const builtInDefault = ['admin', 'office', 'pm'].includes(user.username) && !user.source;
  const mustCompleteSetup = !builtInDefault && (!!user.mustChangePassword || !isValidEmail(email));
  res.json({ user: { username: user.username, role: user.role, name: user.name, workerId: user.workerId || null, email, mustChangePassword: !!user.mustChangePassword, mustCompleteSetup } });
});


app.post('/api/account-password-change', (req, res) => {
  const store = readStore();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const currentPassword = String(req.body?.currentPassword || '').trim();
  const newPassword = String(req.body?.newPassword || '').trim();
  const email = normalizeEmail(req.body?.email || '');

  if (!username) return res.status(400).send('Username is required.');
  if (!currentPassword) return res.status(400).send('Current password is required.');
  if (!isValidEmail(email)) return res.status(400).send('A valid email address is required.');
  if (newPassword.length < 6) return res.status(400).send('New password must be at least 6 characters.');
  if (newPassword === currentPassword) return res.status(400).send('New password must be different from the current password.');

  const fallbackUsers = [
    { username: 'admin', password: 'admin123', role: 'Admin', name: 'Admin User' },
    { username: 'office', password: 'office123', role: 'Office', name: 'Office User' },
    { username: 'pm', password: 'pm123', role: 'PM', name: 'Project Manager' }
  ];

  let storeUser = (store.users || []).find(u => String(u.username || '').trim().toLowerCase() === username);
  const fallbackUser = fallbackUsers.find(u => u.username === username);

  if (!storeUser && !fallbackUser) return res.status(404).send('Account not found.');

  const existingPassword = String(storeUser?.password || fallbackUser?.password || '').trim();
  if (existingPassword !== currentPassword) return res.status(401).send('Current password is incorrect.');

  if (!store.users) store.users = [];

  if (storeUser) {
    storeUser.password = newPassword;
    storeUser.email = email;
    storeUser.mustChangePassword = false;
  } else {
    storeUser = { username, password: newPassword, role: fallbackUser.role, name: fallbackUser.name, email, mustChangePassword: false };
    store.users.push(storeUser);
  }

  appendAuditLog(
    store,
    req,
    'Changed office password',
    `${storeUser.name || storeUser.username} updated account password`,
    { username: storeUser.username, role: storeUser.role, name: storeUser.name }
  );
  writeStore(store);
  res.json({ ok: true, username: storeUser.username, role: storeUser.role, email: storeUser.email || '', mustChangePassword: false, mustCompleteSetup: false });
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

  res.json(sanitizeWorkersForResponse(req, workers));
});

app.get('/api/workers/:id', (req, res) => {
  const store = readStore();
  const id = Number(req.params.id);
  const worker = (store.workers || []).find(w => w.id === id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const jobsReady = (store.jobs || []).filter(j => classifyWorkerForJob(worker, j).bucket !== 'notQualified').map(j => j.name);
  res.json({ ...sanitizeWorkerForResponse(req, worker), jobsReady });
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
    email: normalizeEmail(body.email || body.workerEmail || ''),
    notes: body.notes || '',
    certifications: body.certifications || [],
    bloodwork: body.bloodwork || [],
    driverLicense: body.driverLicense || { class:'N/A', number:'-', state:'', expires:'-', status:'Needs Attention' }
  };
  store.workers.push(worker);
  appendAuditLog(store, req, 'Added worker', worker.name, { workerId: worker.id, workerName: worker.name });
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
    currentJob: body.currentJob ?? existing.currentJob,
    email: body.email !== undefined ? normalizeEmail(body.email) : (existing.email || '')
  };
  appendAuditLog(store, req, 'Updated worker', `${store.workers[idx].name} → ${store.workers[idx].employmentStatus}`, { workerId: store.workers[idx].id, workerName: store.workers[idx].name });
  writeStore(store);
  res.json(store.workers[idx]);
});

app.delete('/api/workers/:id/certifications', (req, res) => {
  if (!requireAdmin(req, res)) return;
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
  appendAuditLog(store, req, 'Deleted certification', `${worker.name} · ${certName}`, { workerId: worker.id, workerName: worker.name, certName });
  writeStore(store);
  res.json({ ok: true, certName, fileDeleted });
});


app.post('/api/workers/:id/reset-password', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const store = readStore();
  const worker = (store.workers || []).find(w => String(w.id) === String(req.params.id));
  if (!worker) return res.status(404).send('Worker not found');

  worker.portalPassword = 'worker123';
  worker.portalMustChangePassword = true;
  appendAuditLog(store, req, 'Reset worker password', `${worker.name} → worker123 (must change)`, { workerId: worker.id, workerName: worker.name });
  writeStore(store);
  res.json({ ok: true, username: worker.portalUsername, tempPassword: 'worker123', mustChangePassword: true });
});

app.post('/api/worker-password-change', (req, res) => {
  const store = readStore();
  const workerId = String(req.body?.workerId || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const currentPassword = String(req.body?.currentPassword || '').trim();
  const newPassword = String(req.body?.newPassword || '').trim();
  const email = normalizeEmail(req.body?.email || '');

  const worker = (store.workers || []).find(w => String(w.id) === workerId && String(w.portalUsername || '').trim().toLowerCase() === username);
  if (!worker) return res.status(404).send('Worker account not found.');
  if (String(worker.portalPassword || 'worker123').trim() !== currentPassword) return res.status(401).send('Current password is incorrect.');
  if (!isValidEmail(email)) return res.status(400).send('A valid email address is required.');

  if (worker.portalMustChangePassword || newPassword) {
    if (newPassword.length < 6) return res.status(400).send('New password must be at least 6 characters.');
    if (newPassword === currentPassword) return res.status(400).send('New password must be different from the current password.');
    worker.portalPassword = newPassword;
    worker.portalMustChangePassword = false;
  }
  worker.email = email;
  appendAuditLog(store, req, 'Completed worker portal setup', `${worker.name} updated password/email setup`, { workerId: worker.id, workerName: worker.name });
  writeStore(store);
  res.json({ ok: true, workerId: worker.id, username: worker.portalUsername, email: worker.email || '', mustChangePassword: false, mustCompleteSetup: false });
});

app.post('/api/workers/:id/bloodwork', (req, res) => {
  if (!requireAdminOrOffice(req, res)) return;
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

  appendAuditLog(store, req, 'Added bloodwork', `${worker.name} · ${record.testDate || 'Bloodwork record'}`, { workerId: worker.id, workerName: worker.name });
  writeStore(store);
  res.json({ ok: true, rowIndex: 0, record });
});

app.put('/api/workers/:id/bloodwork/:rowIndex', (req, res) => {
  if (!requireAdminOrOffice(req, res)) return;
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

  appendAuditLog(store, req, 'Updated bloodwork', `${worker.name} · ${updated.testDate || 'Bloodwork record'}`, { workerId: worker.id, workerName: worker.name });
  writeStore(store);
  res.json({ ok: true, rowIndex, record: updated });
});

app.delete('/api/workers/:id/bloodwork/:rowIndex', (req, res) => {
  if (!requireAdmin(req, res)) return;
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

  appendAuditLog(store, req, 'Deleted bloodwork', `${worker.name} · ${removed.testDate || 'Bloodwork record'}`, { workerId: worker.id, workerName: worker.name });
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
  appendAuditLog(store, req, 'Added job', job.name, { jobId: job.id, jobName: job.name });
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
  appendAuditLog(store, req, 'Updated job', store.jobs[idx].name, { jobId: store.jobs[idx].id, jobName: store.jobs[idx].name });
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
  appendAuditLog(store, req, upload.workerId && upload.certName ? 'Added certification' : 'Added upload', upload.workerId && upload.certName ? `${upload.worker} · ${upload.certName}` : `${upload.file} → ${upload.worker}`, { workerId: upload.workerId || null, workerName: upload.worker || '', certName: upload.certName || '' });
  writeStore(store);
  res.json(upload);
});

app.delete('/api/uploads/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
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
  appendAuditLog(store, req, 'Deleted upload', `${upload.file} → ${upload.worker}`, { workerId: upload.workerId || null, workerName: upload.worker || '', certName: upload.certName || '' });
  writeStore(store);
  res.json({ ok: true, id, fileDeleted });
});

app.get('/api/audit-log', (req, res) => {
  const store = readStore();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 150));
  const rows = (store.auditLog || []).slice(0, limit).map(row => {
    const username = String(row.actorUsername || '').trim().toLowerCase();
    const inferredRole =
      row.actorRole ||
      row.role ||
      (username === 'admin' ? 'Admin' :
       username === 'office' ? 'Office' :
       username === 'pm' ? 'PM' :
       username.startsWith('worker') ? 'Worker' : '');
    return {
      ...row,
      actorRole: inferredRole || '-'
    };
  });
  res.json(rows);
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
  if (!requireAdmin(req, res)) return;
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
  appendAuditLog(store, req, 'Added certification to dropdown', aliasText ? `${name} (aliases: ${aliasText})` : name, { certName: name });
  writeStore(store);
  res.json({ ok: true, added: true, name, aliases });
});

app.delete('/api/certs/catalog', (req, res) => {
  if (!requireAdmin(req, res)) return;
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

  appendAuditLog(store, req, 'Deleted certification from dropdown', name, { certName: name });
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

let workerAlertSchedulerStarted = false;

function startWorkerAlertScheduler() {
  if (workerAlertSchedulerStarted) return;
  workerAlertSchedulerStarted = true;
  setInterval(async () => {
    try {
      const store = readStore();
      const settings = getEmailAlertSettings(store);
      if (!settings.workerAlertsEnabled) return;
      if (hourNY() !== settings.sendHour) return;
      const todayKey = dateKeyNY();
      if (settings.lastWorkerAutoRunDate === todayKey) return;
      const result = await sendWorkerReminderEmails(store, { force: false });
      settings.lastWorkerAutoRunDate = todayKey;
      store.meta.emailAlerts = settings;
      appendAuditLog(store, { headers: { 'x-actor-username': 'system', 'x-actor-role': 'System', 'x-actor-name': 'System' } }, 'Auto-sent worker alert emails', `${result.sent || 0} sent, ${result.skipped || 0} skipped`);
      writeStore(store);
    } catch (err) {
      console.error('Worker alert scheduler failed', err);
    }
  }, 60 * 60 * 1000);
  console.log('Worker alert scheduler started. Worker emails only send when Admin toggle is ON.');
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

  const transporter = createMailTransporter();

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
  if (!requireAdmin(req, res)) return;
  try {
    const store = readStore();
    await sendDigestEmail(store);
    appendAuditLog(store, req, 'Sent test digest', process.env.ALERTS_TO || 'Digest recipient not set');
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
    worker: { ...sanitizeWorkerForResponse(req, worker), portalPassword: '', jobsReady },
    uploads,
    alerts
  });
});


app.post('/api/accounts/:username/reset-password', (req, res) => {
  const store = readStore();
  const actor = getAuditActor(req);
  if (String(actor.role || '').trim() !== 'Admin') {
    return res.status(403).send('Only admin can reset office or PM passwords.');
  }

  const username = String(req.params.username || '').trim().toLowerCase();
  const managed = managedPortalAccounts(store).find(item => item.username === username);
  if (!managed) return res.status(404).send('Account not found.');
  if (!managed.resettable) return res.status(403).send('Admin accounts must be reset manually.');

  const defaults = {
    office: { password: 'office123', role: 'Office', name: 'Office User' },
    pm: { password: 'pm123', role: 'PM', name: 'Project Manager' }
  };
  const fallback = defaults[username];
  if (!fallback) return res.status(400).send('Unsupported account.');

  store.users = Array.isArray(store.users) ? store.users : [];
  let storeUser = store.users.find(u => String(u.username || '').trim().toLowerCase() === username);
  if (storeUser) {
    storeUser.password = fallback.password;
    storeUser.role = storeUser.role || fallback.role;
    storeUser.name = storeUser.name || fallback.name;
  } else {
    storeUser = {
      username,
      password: fallback.password,
      role: fallback.role,
      name: fallback.name
    };
    store.users.push(storeUser);
  }

  appendAuditLog(
    store,
    req,
    'Reset office account password',
    `${storeUser.name || storeUser.username} → ${fallback.password}`,
    { username: storeUser.username, role: storeUser.role, name: storeUser.name }
  );
  writeStore(store);
  res.json({ ok: true, username: storeUser.username, role: storeUser.role, tempPassword: fallback.password });
});


app.get('/api/access-users', (req, res) => {
  const store = readStore();
  res.json(getPortalAccessAccounts(store));
});

app.post('/api/access-users', (req, res) => {
  const store = readStore();
  const actor = getAuditActor(req);
  if (String(actor.role || '').trim() !== 'Admin') {
    return res.status(403).send('Only admin can add portal access accounts.');
  }

  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const role = String(req.body?.role || '').trim();
  const email = normalizeEmail(req.body?.email || '');
  const active = req.body?.active !== false;

  if (!name) return res.status(400).send('Name is required.');
  if (!username) return res.status(400).send('Username is required.');
  if (!/^[a-z0-9._-]+$/.test(username)) return res.status(400).send('Username can only use lowercase letters, numbers, dots, dashes, and underscores.');
  if (!['Admin', 'Office', 'PM'].includes(role)) return res.status(400).send('Role must be Admin, Office, or PM.');
  if (email && !isValidEmail(email)) return res.status(400).send('Enter a valid email address or leave it blank for first-login setup.');

  const workerUsernameTaken = (store.workers || []).some(w => String(w.portalUsername || '').trim().toLowerCase() === username);
  const existingUser = (store.users || []).find(u => String(u.username || '').trim().toLowerCase() === username);
  const reserved = ['admin', 'office', 'pm'];

  if (workerUsernameTaken) return res.status(400).send('That username is already used by a worker account.');
  if (existingUser) return res.status(400).send('That username is already in Portal Access.');
  if (reserved.includes(username)) return res.status(400).send('That username is reserved by a system account.');

  store.users = Array.isArray(store.users) ? store.users : [];
  const tempPassword = 'changeme123';
  const account = {
    username,
    password: tempPassword,
    tempPassword,
    role,
    name,
    email,
    active,
    mustChangePassword: true
  };
  store.users.push(account);
  appendAuditLog(store, req, 'Added portal access account', `${name} · ${role} · ${username}`, { username, role, name });
  writeStore(store);
  res.json({
    ok: true,
    account: {
      name,
      username,
      role,
      email,
      active,
      passwordStatus: 'Temp Password Active',
      tempPassword,
      resettable: role !== 'Admin',
      source: 'Portal Access',
      mustChangePassword: true
    }
  });
});

app.put('/api/access-users/:username', (req, res) => {
  const store = readStore();
  const actor = getAuditActor(req);
  if (String(actor.role || '').trim() !== 'Admin') {
    return res.status(403).send('Only admin can update portal access accounts.');
  }

  const username = String(req.params.username || '').trim().toLowerCase();
  const storeUser = (store.users || []).find(u => String(u.username || '').trim().toLowerCase() === username);
  if (!storeUser) return res.status(404).send('Portal access account not found.');

  if (typeof req.body?.active === 'boolean') {
    storeUser.active = req.body.active;
  }

  appendAuditLog(store, req, storeUser.active === false ? 'Deactivated portal access' : 'Activated portal access', `${storeUser.name || storeUser.username} · ${storeUser.role}`, { username: storeUser.username, role: storeUser.role, name: storeUser.name });
  writeStore(store);
  res.json({ ok: true, username: storeUser.username, active: storeUser.active !== false });
});

app.post('/api/access-users/:username/reset-password', (req, res) => {
  const store = readStore();
  const actor = getAuditActor(req);
  if (String(actor.role || '').trim() !== 'Admin') {
    return res.status(403).send('Only admin can reset portal access passwords.');
  }

  const username = String(req.params.username || '').trim().toLowerCase();
  const storeUser = (store.users || []).find(u => String(u.username || '').trim().toLowerCase() === username);
  if (!storeUser) return res.status(404).send('Portal access account not found.');
  if (String(storeUser.role || '').trim() === 'Admin') return res.status(403).send('Admin accounts remain manual-only for safety.');

  const tempPassword = storeUser.tempPassword || 'changeme123';
  storeUser.password = tempPassword;
  storeUser.mustChangePassword = true;

  appendAuditLog(store, req, 'Reset portal access password', `${storeUser.name || storeUser.username} · ${storeUser.role}`, { username: storeUser.username, role: storeUser.role, name: storeUser.name });
  writeStore(store);
  res.json({ ok: true, username: storeUser.username, role: storeUser.role, tempPassword, mustChangePassword: true });
});


app.get('/api/email-alerts/worker-preview', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const store = readStore();
  res.json(workerReminderPreview(store));
});

app.put('/api/email-alerts/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const store = readStore();
  const settings = getEmailAlertSettings(store);
  const body = req.body || {};

  if (typeof body.workerAlertsEnabled === 'boolean') settings.workerAlertsEnabled = body.workerAlertsEnabled;
  if (typeof body.officeDigestEnabled === 'boolean') settings.officeDigestEnabled = body.officeDigestEnabled;
  if (body.testRecipient !== undefined) settings.testRecipient = normalizeEmail(body.testRecipient || '');
  if (body.reminderDays !== undefined) {
    settings.reminderDays = cleanReminderDays(body.reminderDays);
  }

  store.meta.emailAlerts = settings;
  appendAuditLog(store, req, 'Updated worker email alert settings', settings.workerAlertsEnabled ? 'Worker email alerts ON' : 'Worker email alerts OFF');
  writeStore(store);
  res.json({ ok: true, settings, preview: workerReminderPreview(store) });
});

app.post('/api/email-alerts/send-test-worker', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const store = readStore();
    const result = await sendWorkerReminderEmails(store, {
      testMode: true,
      testRecipient: req.body?.testRecipient
    });
    appendAuditLog(store, req, 'Sent test worker alert', result.to || 'Test recipient not set');
    writeStore(store);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send test worker alert.' });
  }
});

app.post('/api/email-alerts/send-worker-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const store = readStore();
    const result = await sendWorkerReminderEmails(store, { force: true });
    appendAuditLog(store, req, 'Sent worker alert emails', `${result.sent || 0} sent, ${result.skipped || 0} skipped`);
    writeStore(store);
    res.json({ ok: true, ...result, message: `${result.sent || 0} worker reminder email(s) sent. ${result.skipped || 0} skipped.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send worker alert emails.' });
  }
});

app.put('/api/certification-alert-rules', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const store = readStore();
  const incomingRules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const rules = incomingRules.map(sanitizeCertificationAlertRule).filter(Boolean);
  if (!rules.length) return res.status(400).json({ error: 'At least one certification alert rule is required.' });

  store.meta = store.meta || {};
  store.meta.certificationAlertRules = rules;
  const preview = workerReminderPreview(store);
  appendAuditLog(store, req, 'Updated certification alert rules', `${rules.length} rule(s) saved`);
  writeStore(store);
  res.json({ ok: true, certificationAlertRules: rules, preview });
});

app.get('/api/admin', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const store = readStore();
  const emailPreview = workerReminderPreview(store);
  res.json({
    emailAlerts: emailPreview.settings,
    workerEmailPreview: emailPreview,
    certificationAlertRules: getCertificationAlertRules(store),
    baselineRequirements: store.meta?.baselineRequirements || [],
    reminderRules: store.meta?.reminderRules || [],
    managedAccounts: managedPortalAccounts(store),
    accessAccounts: getPortalAccessAccounts(store),
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
startWorkerAlertScheduler();

app.listen(PORT, () => {
  console.log(`JAGD portal running on http://localhost:${PORT}`);
});
