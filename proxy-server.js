const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/html', limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// ── Persistent stores ─────────────────────────────────────────────────────────
//
// formRegistry: written to form-registry.json on every save so it survives restarts
// submissions:  in-memory only (resets on restart)
//
const REGISTRY_PATH = path.join(__dirname, 'form-registry.json');

let formRegistry = {};
try {
  if (fs.existsSync(REGISTRY_PATH)) {
    formRegistry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    console.log(`[Registry] Loaded ${Object.keys(formRegistry).length} form(s) from disk`);
  }
} catch (e) {
  console.warn('[Registry] Could not load registry file, starting fresh:', e.message);
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(formRegistry, null, 2));
  } catch (e) {
    console.warn('[Registry] Could not write registry file:', e.message);
  }
}

const submissions = {};

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/proxy/bee-auth', async (req, res) => {
  try {
    const { uid } = req.body;
    const response = await axios.post(
      'https://auth.getbee.io/loginV2',
      {
        client_id:     process.env.BEE_CLIENT_ID,
        client_secret: process.env.BEE_CLIENT_SECRET,
        uid:           uid || 'demo-user',
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).json({ error: 'Failed to authenticate' });
  }
});

// Health check
app.get('/proxy/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Form Registry ─────────────────────────────────────────────────────────────

// Register a new form or update an existing one.
// Called by the form builder when the user clicks "Save Form".
// Returns a stable formId that gets embedded as a hidden field in the rendered form.
app.post('/api/forms/register', (req, res) => {
  const { formId: existingId, title, description, fieldMeta, fieldDefs } = req.body;

  console.log(`[Form Register] ${existingId ? 'Updating' : 'Registering'} form:`, {
    formId: existingId || '(new)',
    title,
    description,
    fieldMeta,
    fieldDefs,
  });

  const formId = existingId ||
    'form_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  formRegistry[formId] = {
    formId,
    title:       title       || 'Untitled Form',
    description: description || '',
    fieldMeta:   fieldMeta   || [],   // [{ id, type, label }] — used to label submissions
    fieldDefs:   fieldDefs   || [],   // [{ id, type, label, attributes, options }] — full def for editing
    createdAt:   formRegistry[formId]?.createdAt || new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };

  if (!submissions[formId]) submissions[formId] = [];

  saveRegistry();
  console.log(`[Form ${existingId ? 'Updated' : 'Registered'}] ${formId} — "${formRegistry[formId].title}"`);
  res.json({ formId });
});

// List all registered forms with their submission counts
app.get('/api/forms', (req, res) => {
  const forms = Object.values(formRegistry).map(f => ({
    ...f,
    submissionCount: (submissions[f.formId] || []).length,
  }));
  res.json({ total: forms.length, forms });
});

// Get a single form definition
app.get('/api/forms/:formId', (req, res) => {
  const form = formRegistry[req.params.formId];
  if (!form) return res.status(404).json({ error: 'Form not found' });
  res.json({ ...form, submissionCount: (submissions[form.formId] || []).length });
});

// ── Form Submissions ──────────────────────────────────────────────────────────

// Re-compute labeled fields from the live registry, falling back to labels embedded
// in the submission's __field_labels hidden field, then to raw field IDs.
function relabelSubmission(submission) {
  const raw = submission.raw || {};

  // Parse labels embedded by the form builder into the hidden __field_labels field
  let embeddedLabels = {};
  if (raw.__field_labels) {
    try { embeddedLabels = JSON.parse(raw.__field_labels); } catch (e) {}
  }

  const form = formRegistry[submission.formId];
  if (form && Array.isArray(form.fieldMeta) && form.fieldMeta.length) {
    return form.fieldMeta
      .filter(m => m.type !== 'submit' && m.type !== 'hidden')
      .filter(m => raw[m.id] !== undefined)
      .map(m => ({ field: m.id, label: m.label, value: raw[m.id] }));
  }

  // Registry not available — use embedded label map if present
  if (Object.keys(embeddedLabels).length > 0) {
    return Object.entries(embeddedLabels)
      .filter(([id]) => raw[id] !== undefined)
      .map(([id, label]) => ({ field: id, label, value: raw[id] }));
  }

  // Last resort — field ID as label
  return submission.labeled;
}

// Receive a submitted form.
// form_id in the body (injected as a hidden field by the builder) identifies the source form.
// Field keys in req.body are matched against the stored fieldMeta to produce labeled results.
app.post('/api/form-submit', (req, res) => {
  const rawBody  = req.body;
  console.log('[Form Submit] Received submission:', rawBody);
  const form_id  = rawBody.form_id || null;
  const form     = form_id ? formRegistry[form_id] : null;

  // Parse labels embedded by the builder into __field_labels hidden field
  let embeddedLabels = {};
  if (rawBody.__field_labels) {
    try { embeddedLabels = JSON.parse(rawBody.__field_labels); } catch (e) {}
  }

  // Build a labeled view — registry first, embedded labels second, field IDs last
  const labeled = form
    ? form.fieldMeta
        .filter(m => m.type !== 'submit' && m.type !== 'hidden')
        .filter(m => rawBody[m.id] !== undefined)
        .map(m => ({ field: m.id, label: m.label, value: rawBody[m.id] }))
    : Object.keys(embeddedLabels).length > 0
      ? Object.entries(embeddedLabels)
          .filter(([id]) => rawBody[id] !== undefined)
          .map(([id, label]) => ({ field: id, label, value: rawBody[id] }))
      : Object.entries(rawBody)
          .filter(([k]) => k !== 'form_id' && k !== '__field_labels')
          .map(([k, v]) => ({ field: k, label: k, value: v }));

  const submission = {
    id:        'sub_' + Date.now(),
    formId:    form_id,
    formTitle: form?.title || 'Unknown Form',
    timestamp: new Date().toISOString(),
    labeled,
    raw:       rawBody,
  };

  if (form_id) {
    if (!submissions[form_id]) submissions[form_id] = [];
    submissions[form_id].push(submission);
  }

  console.log(`[Form Submit] form="${submission.formTitle}" (${form_id || 'unregistered'}) | sub=${submission.id}`);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Submitted</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:Inter,sans-serif; }
    body { display:flex; align-items:center; justify-content:center; min-height:100vh; background:#F8FAFC; }
    .card { background:white; padding:48px 56px; border-radius:12px; text-align:center; box-shadow:0 4px 24px rgba(0,0,0,0.08); max-width:460px; width:90%; }
    .check { width:64px; height:64px; background:#ECFDF5; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:30px; }
    h1 { font-size:22px; color:#1E293B; margin-bottom:10px; }
    p  { font-size:14px; color:#64748B; line-height:1.7; }
    .meta { margin-top:16px; padding:12px 16px; background:#F8FAFC; border-radius:8px; font-size:12px; color:#64748B; text-align:left; }
    .meta strong { color:#374151; }
    a  { display:inline-block; margin-top:24px; padding:10px 28px; background:#6366F1; color:white; border-radius:7px; text-decoration:none; font-size:13px; font-weight:500; }
    a:hover { background:#4F46E5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h1>Submitted Successfully</h1>
    <p>Your response has been recorded.</p>
    <div class="meta">
      <strong>Form:</strong> ${submission.formTitle}<br/>
      <strong>Submission ID:</strong> ${submission.id}<br/>
      <strong>Time:</strong> ${new Date(submission.timestamp).toLocaleString()}
    </div>
    <a href="javascript:history.back()">← Go Back</a>
  </div>
</body>
</html>`);
});

// Get all submissions for a specific form, with labeled field data
app.get('/api/forms/:formId/submissions', (req, res) => {
  const form = formRegistry[req.params.formId];
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const subs = (submissions[req.params.formId] || []).map(s => ({
    id:        s.id,
    timestamp: s.timestamp,
    data:      relabelSubmission(s),
    raw:       s.raw,
  }));

  res.json({
    formId:      form.formId,
    title:       form.title,
    description: form.description,
    fields:      form.fieldMeta.filter(m => m.type !== 'submit' && m.type !== 'hidden'),
    total:       subs.length,
    submissions: subs,
  });
});

// Get all submissions across every form, newest first
app.get('/api/form-submissions', (req, res) => {
  const all = Object.values(submissions)
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map(s => ({
      ...s,
      formTitle: formRegistry[s.formId]?.title || s.formTitle,
      labeled:   relabelSubmission(s),
    }));
  res.json({ total: all.length, submissions: all });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log(`  Auth:        POST /proxy/bee-auth`);
  console.log(`  Register:    POST /api/forms/register`);
  console.log(`  Forms:       GET  /api/forms`);
  console.log(`  Submissions: GET  /api/forms/:formId/submissions`);
  console.log(`  Submit:      POST /api/form-submit`);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
});
