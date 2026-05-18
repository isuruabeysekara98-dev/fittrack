// ============================================================
// FitTrack — app.js
// ============================================================

// Trainer's body-weight spreadsheet (pre-configured)
const BW_SHEET_ID = '1dkC1t_-CCxLsArDa4K3ZrekTCMwIRomJ66aKxlEq56c';
const BW_SHEET_TAB = '1. Long term trend';

// ── State ─────────────────────────────────────────────────────
const state = {
  workoutData: {
    exercises: [],  // global library: string[]
    workouts:  [],  // templates: { id, name, exercises: string[] }
    sessions:  [],  // logged: { id, date, workoutId, workoutName, entries[] }
  },
  bodyweightData: { entries: [] },

  // Workout UI
  activeWorkoutId:     null,
  editingWorkoutId:    null,
  editingSessionId:    null,
  newWorkoutExercises: [],

  // Google
  googleToken:          null,
  clientId:             '',
  tokenClient:          null,
  workoutSheetId:       '',   // user's private workout spreadsheet
  tokenRefreshTimer:    null,
  silentAuthInProgress: false,

  // Charts
  weightChart: null,
};

// ── localStorage ──────────────────────────────────────────────
function loadLocal() {
  try {
    const wd  = localStorage.getItem('ft_workoutData');
    if (wd)  state.workoutData    = { exercises: [], workouts: [], sessions: [], ...JSON.parse(wd) };
    const bw  = localStorage.getItem('ft_bodyweightData');
    if (bw) {
      state.bodyweightData = JSON.parse(bw);
      state.bodyweightData.entries = (state.bodyweightData.entries || []).filter(e => isValidBwYear(e.date));
    }
    const cid = localStorage.getItem('ft_clientId');
    if (cid) state.clientId       = cid;
    const sid = localStorage.getItem('ft_workoutSheetId');
    if (sid) state.workoutSheetId = sid;
    migrateOldEntries();
    repairDuplicatedSets();
  } catch (e) { console.error('loadLocal:', e); }
}

// Migrate old entry format { exercise, weight, sets: Number, reps } → { exercise, sets: [{weight, reps}] }
function migrateOldEntries() {
  let changed = false;
  for (const session of state.workoutData.sessions) {
    session.entries = session.entries.map(e => {
      if (!Array.isArray(e.sets)) {
        changed = true;
        const count = e.sets || 1;
        const sets = [];
        for (let i = 0; i < count; i++) sets.push({ weight: e.weight || 0, reps: e.reps || 0 });
        return { exercise: e.exercise, sets };
      }
      return e;
    });
  }
  if (changed) saveWorkoutLocal();
}

// One-time repair: the sync bug caused sets to be duplicated on every sync.
// The first 3 sets per exercise are the originals; trim any extras.
function repairDuplicatedSets() {
  if (localStorage.getItem('ft_setsRepaired_v1')) return;
  let changed = false;
  for (const session of state.workoutData.sessions) {
    for (const entry of session.entries) {
      if (Array.isArray(entry.sets) && entry.sets.length > 3) {
        entry.sets = entry.sets.slice(0, 3);
        changed = true;
      }
    }
  }
  if (changed) saveWorkoutLocal();
  localStorage.setItem('ft_setsRepaired_v1', '1');
}

function saveWorkoutLocal()    { localStorage.setItem('ft_workoutData',    JSON.stringify(state.workoutData)); }
function saveBodyweightLocal() { localStorage.setItem('ft_bodyweightData', JSON.stringify(state.bodyweightData)); }

// ── Utilities ─────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().split('T')[0]; }
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function vol(e) {
  if (Array.isArray(e.sets)) return e.sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0);
  return (e.weight || 0) * (e.sets || 0) * (e.reps || 0); // legacy format
}
function avgWt(e) {
  if (!Array.isArray(e.sets) || !e.sets.length) return null;
  return e.sets.reduce((sum, s) => sum + (s.weight || 0), 0) / e.sets.length;
}
function fmtVol(v)  { return v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' kg'; }
function fmtWt(v)   { return v === null ? '—' : v.toFixed(1) + ' kg'; }
function fmtChg(p) {
  if (p === null || p === undefined) return '<span class="change-na">—</span>';
  const cls = p >= 0 ? 'change-pos' : 'change-neg';
  return `<span class="${cls}">${p >= 0 ? '+' : ''}${p.toFixed(1)}%</span>`;
}

// Always renders a %, showing 0.0% (neutral) for new exercises with no baseline
function fmtChgWeekly(pct, hasBaseline) {
  if (!hasBaseline) return '<span class="change-zero">0.0%</span>';
  if (pct === 0)    return '<span class="change-zero">0.0%</span>';
  const cls = pct > 0 ? 'change-pos' : 'change-neg';
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
}
function uid()      { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function getEl(id)  { return document.getElementById(id); }

// Normalise a Sheets date value to YYYY-MM-DD.
// Sheets with valueInputOption=USER_ENTERED auto-converts ISO strings to
// numeric serials (days since 1899-12-30). This handles all three forms:
//   1. Already ISO  "2026-01-15"  → passthrough
//   2. Serial       "46045"       → convert
//   3. Localised    "1/15/2026"   → reformat
function isValidBwYear(dateStr) {
  const y = parseInt(String(dateStr).slice(0, 4), 10);
  return y >= 2000 && y <= 2100;
}

function normalizeSheetDate(val) {
  if (!val) return val;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 10000 && n < 99999)
      return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const parts = s.split('/');
  if (parts.length === 3) {
    const [m, d, y] = parts.map(Number);
    const year = y < 100 ? 2000 + y : y;
    return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return s;
}

// ── Sync status pill ──────────────────────────────────────────
function setSyncStatus(s) {
  const dot   = getEl('syncDot');
  const label = getEl('syncLabel');
  if (!dot) return;
  dot.className = `sync-dot ${s}`;
  label.textContent = { idle: 'Offline', syncing: 'Syncing…', synced: 'Synced', error: 'Sync Error' }[s] || 'Offline';
}

// ── Sheets API primitives ─────────────────────────────────────
async function sheetsGet(sheetId, range) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${state.googleToken}` } }
  );
  if (r.status === 401) { handleTokenExpiry(); return []; }
  if (!r.ok) return [];
  return (await r.json()).values || [];
}

async function sheetsPut(sheetId, range, values) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${state.googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (r.status === 401) { handleTokenExpiry(); throw new Error('Token expired'); }
  if (!r.ok) throw new Error(`Sheets PUT ${r.status}`);
}

async function sheetsClear(sheetId, range) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { Authorization: `Bearer ${state.googleToken}` } }
  );
  if (r.status === 401) { handleTokenExpiry(); throw new Error('Token expired'); }
}

async function sheetsAppend(sheetId, range, values) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (r.status === 401) { handleTokenExpiry(); throw new Error('Token expired'); }
  if (!r.ok) throw new Error(`Sheets append ${r.status}`);
}

function handleTokenExpiry() {
  state.googleToken = null;
  updateGoogleStatus(false);
  setSyncStatus('idle');
}

// ── Workout spreadsheet setup ─────────────────────────────────

// Search Drive for an existing FitTrack spreadsheet so we reconnect to it
// instead of creating a new one when localStorage is empty (e.g. new domain).
async function findExistingWorkoutSheet() {
  const q = encodeURIComponent("name='FitTrack — My Workout Data' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${state.googleToken}` } }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.files?.[0]?.id || null;
}

async function ensureWorkoutSpreadsheet() {
  if (state.workoutSheetId) { updateWorkoutSheetStatus(); return; }

  // Before creating a new sheet, check if one already exists in Drive
  const existingId = await findExistingWorkoutSheet().catch(() => null);
  if (existingId) {
    state.workoutSheetId = existingId;
    localStorage.setItem('ft_workoutSheetId', existingId);
    updateWorkoutSheetStatus();
    return;
  }

  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.googleToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: 'FitTrack — My Workout Data' },
      sheets: [
        { properties: { title: 'Templates',  sheetId: 0 } },
        { properties: { title: 'Sessions',   sheetId: 1 } },
        { properties: { title: 'BodyWeight', sheetId: 2 } },
        { properties: { title: 'ForTrainer', sheetId: 3 } },
      ],
    }),
  });
  if (!r.ok) throw new Error('Failed to create workout spreadsheet');
  const data = await r.json();

  state.workoutSheetId = data.spreadsheetId;
  localStorage.setItem('ft_workoutSheetId', state.workoutSheetId);

  // Write headers
  await sheetsPut(state.workoutSheetId, 'Templates!A1:C1',  [['ID', 'Name', 'Exercises (JSON)']]);
  await sheetsPut(state.workoutSheetId, 'Sessions!A1:H1',   [['Session ID', 'Date', 'Workout ID', 'Workout Name', 'Exercise', 'Set #', 'Weight (kg)', 'Reps']]);
  await sheetsPut(state.workoutSheetId, 'BodyWeight!A1:D1', [['Date', 'Weight (kg)', 'Waist (in)', 'Notes']]);
  await sheetsPut(state.workoutSheetId, 'ForTrainer!A1:F1', [['Date', 'Workout', 'Exercise', 'Sets', 'Weight (kg)', 'Reps']]);

  updateWorkoutSheetStatus();
}

// ── Full data sync (merge local ↔ Sheets) ─────────────────────
async function syncFromSheets() {
  if (!state.googleToken || !state.workoutSheetId) return;
  setSyncStatus('syncing');

  try {
    const [tplRows, sessRows, bwRows] = await Promise.all([
      sheetsGet(state.workoutSheetId, 'Templates!A2:C'),
      sheetsGet(state.workoutSheetId, 'Sessions!A2:H'),
      sheetsGet(state.workoutSheetId, 'BodyWeight!A2:D'),
    ]);

    // ── Templates: Sheets wins; upload any local-only ──
    const remoteWorkouts = tplRows.map(r => ({
      id: r[0], name: r[1], exercises: safeParseJSON(r[2], []),
    })).filter(w => w.id && w.name);

    const remoteIds  = new Set(remoteWorkouts.map(w => w.id));
    const localOnly  = state.workoutData.workouts.filter(w => !remoteIds.has(w.id));
    state.workoutData.workouts = [...remoteWorkouts, ...localOnly];

    if (localOnly.length) await saveTemplatesToSheets();

    // ── Sessions: union by session ID (local wins) ──
    const sessionMap = {};
    const localSessionIds = new Set();
    for (const s of state.workoutData.sessions) {
      sessionMap[s.id] = s;
      localSessionIds.add(s.id);
    }

    const remoteSessionIds = new Set();
    for (const row of sessRows) {
      const [sid, rawDate, wid, wname, exercise, , weight, reps] = row; // col F = Set # (ignored, order preserved)
      if (!sid) continue;
      const date = normalizeSheetDate(rawDate);
      remoteSessionIds.add(sid);
      // Local wins for sessions — only import sessions that don't exist locally.
      // Merging Sheets rows into existing local sessions would duplicate sets.
      if (localSessionIds.has(sid)) continue;
      if (!sessionMap[sid]) sessionMap[sid] = { id: sid, date, workoutId: wid, workoutName: wname, entries: [] };
      if (exercise) {
        let entry = sessionMap[sid].entries.find(e => e.exercise === exercise);
        if (!entry) { entry = { exercise, sets: [] }; sessionMap[sid].entries.push(entry); }
        entry.sets.push({ weight: parseFloat(weight) || 0, reps: parseInt(reps) || 0 });
      }
    }
    state.workoutData.sessions = Object.values(sessionMap);

    // ── Body weight: union by date ──
    const bwMap = {};
    for (const e of state.bodyweightData.entries) bwMap[e.date] = e;

    const remoteDates = new Set();
    for (const row of bwRows) {
      const [rawDate, weight, waist, notes] = row;
      if (!rawDate || !weight) continue;
      const date = normalizeSheetDate(rawDate);
      if (!isValidBwYear(date)) continue;
      remoteDates.add(date);
      if (!bwMap[date]) bwMap[date] = {
        date, weight: parseFloat(weight),
        waist: waist ? parseFloat(waist) : null,
        notes: notes || '',
      };
    }
    state.bodyweightData.entries = Object.values(bwMap)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Save and mark synced immediately so data is visible even if write-back fails
    saveWorkoutLocal();
    saveBodyweightLocal();
    setSyncStatus('synced');

    // Write-back is fire-and-forget — failures don't affect what the user sees
    rewriteSessionsToSheets().catch(e => console.warn('Session rewrite:', e));
    rewriteBwToUserSheet().catch(e => console.warn('BW rewrite:', e));
  } catch (err) {
    console.error('Sync error:', err);
    setSyncStatus('error');
  }
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Write workouts to Sheets ──────────────────────────────────
async function saveTemplatesToSheets() {
  if (!state.googleToken || !state.workoutSheetId) return;
  await sheetsClear(state.workoutSheetId, 'Templates!A2:C');
  if (!state.workoutData.workouts.length) return;
  await sheetsPut(
    state.workoutSheetId, 'Templates!A2:C',
    state.workoutData.workouts.map(w => [w.id, w.name, JSON.stringify(w.exercises)])
  );
}

async function appendSessionToSheets(session) {
  if (!state.googleToken || !state.workoutSheetId) return;
  const rows = [];
  for (const e of session.entries) {
    if (Array.isArray(e.sets)) {
      e.sets.forEach((s, i) => rows.push([
        session.id, "'" + session.date, session.workoutId, session.workoutName,
        e.exercise, i + 1, s.weight, s.reps,
      ]));
    } else {
      rows.push([session.id, "'" + session.date, session.workoutId, session.workoutName, e.exercise, 1, e.weight, e.reps]);
    }
  }
  if (rows.length) await sheetsAppend(state.workoutSheetId, 'Sessions!A:H', rows);
}

async function rewriteSessionsToSheets() {
  if (!state.googleToken || !state.workoutSheetId) return;
  await sheetsClear(state.workoutSheetId, 'Sessions!A2:H');
  const rows = [];
  for (const session of state.workoutData.sessions) {
    for (const e of session.entries) {
      const sets = Array.isArray(e.sets) ? e.sets : [{ weight: e.weight || 0, reps: e.reps || 0 }];
      sets.forEach((s, i) => rows.push([
        session.id, "'" + session.date, session.workoutId, session.workoutName,
        e.exercise, i + 1, s.weight, s.reps,
      ]));
    }
  }
  if (rows.length) await sheetsAppend(state.workoutSheetId, 'Sessions!A:H', rows);
  rewriteTrainerSheet().catch(e => console.warn('ForTrainer sync:', e));
}

async function appendBwToUserSheet(date, weight, waist, notes) {
  if (!state.googleToken || !state.workoutSheetId) return;
  await sheetsAppend(state.workoutSheetId, 'BodyWeight!A:D', [
    ["'" + date, weight ?? '', waist ?? '', notes ?? ''],
  ]);
}

async function rewriteBwToUserSheet() {
  if (!state.googleToken || !state.workoutSheetId) return;
  await sheetsClear(state.workoutSheetId, 'BodyWeight!A2:D');
  const rows = state.bodyweightData.entries.map(e => ["'" + e.date, e.weight ?? '', e.waist ?? '', e.notes ?? '']);
  if (rows.length) await sheetsAppend(state.workoutSheetId, 'BodyWeight!A:D', rows);
}

// Returns a single value if all sets share the same value for `field`,
// or "v1 / v2 / v3" if they differ.
function formatSetValues(sets, field) {
  if (!sets || !sets.length) return '';
  const vals = sets.map(s => s[field] ?? '');
  if (vals.every(v => v === vals[0])) return String(vals[0]);
  return vals.join(' / ');
}

// Creates the ForTrainer tab if it doesn't exist, then writes the header.
// Safe to call on an existing spreadsheet — the API 400 "already exists" is swallowed.
async function ensureForTrainerTab() {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${state.workoutSheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'ForTrainer' } } }] }),
    }
  );
  // Swallow all errors — tab may already exist or user may lack edit rights
  if (!r.ok) { await r.body?.cancel?.(); return; }
  await sheetsPut(state.workoutSheetId, 'ForTrainer!A1:F1', [['Date', 'Workout', 'Exercise', 'Sets', 'Weight (kg)', 'Reps']]).catch(() => {});
}

async function rewriteTrainerSheet() {
  if (!state.googleToken || !state.workoutSheetId) return;
  await ensureForTrainerTab();
  await sheetsClear(state.workoutSheetId, 'ForTrainer!A2:F');
  const rows = [];
  const sorted = [...state.workoutData.sessions].sort((a, b) => b.date.localeCompare(a.date));
  for (const session of sorted) {
    for (const entry of session.entries) {
      const sets = Array.isArray(entry.sets) ? entry.sets : [{ weight: entry.weight || 0, reps: entry.reps || 0 }];
      rows.push([
        "'" + session.date,
        session.workoutName,
        entry.exercise,
        sets.length,
        formatSetValues(sets, 'weight'),
        formatSetValues(sets, 'reps'),
      ]);
    }
  }
  if (rows.length) await sheetsAppend(state.workoutSheetId, 'ForTrainer!A:F', rows);
}

// Append to trainer's body-weight sheet
async function appendBwToTrainerSheet(date, weight, waist, notes) {
  if (!state.googleToken) throw new Error('Not authenticated with Google.');
  await sheetsAppend(BW_SHEET_ID, `'${BW_SHEET_TAB}'!A:F`, [
    ["'" + date, weight, '', '', waist ?? '', notes ?? ''],
  ]);
}

// ── Google auth ───────────────────────────────────────────────
function scheduleTokenRefresh(expiresIn) {
  clearTimeout(state.tokenRefreshTimer);
  // Refresh 5 minutes before the token expires
  const delay = Math.max(((expiresIn || 3600) - 300) * 1000, 60_000);
  state.tokenRefreshTimer = setTimeout(() => {
    if (state.tokenClient) {
      state.silentAuthInProgress = true;
      state.tokenClient.requestAccessToken({ prompt: '' });
    }
  }, delay);
}

function initTokenClient() {
  if (!state.clientId || typeof google === 'undefined' || !google.accounts?.oauth2) return;
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly',
    callback: async resp => {
      const wasSilent = state.silentAuthInProgress;
      state.silentAuthInProgress = false;

      if (resp.error) {
        // Silent re-auth failed quietly — user stays offline until they tap Connect
        if (!wasSilent) setSyncStatus('error');
        return;
      }

      state.googleToken = resp.access_token;
      scheduleTokenRefresh(resp.expires_in);
      updateGoogleStatus(true);
      setSyncStatus('syncing');
      try {
        await ensureWorkoutSpreadsheet();
        await syncFromSheets();
        renderListView();
        if (getEl('bodyweight-tab')?.classList.contains('active')) renderBodyweightTab();
      } catch (err) {
        console.error('Post-auth error:', err);
        setSyncStatus('error');
      }
    },
  });
}

function requestGoogleToken() {
  if (!state.clientId) { showModal('settingsModal'); return; }
  if (typeof google === 'undefined' || !google.accounts?.oauth2) {
    alert('Google Identity Services not loaded — check your internet connection.'); return;
  }
  if (!state.tokenClient) initTokenClient();
  if (state.tokenClient) state.tokenClient.requestAccessToken();
}

// ── Workout view routing ──────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.wv').forEach(v => v.classList.remove('active'));
  getEl(`view-${name}`)?.classList.add('active');
}

// ── Exercise library ──────────────────────────────────────────
function addToLibrary(name) {
  const t = name.trim();
  if (!t || state.workoutData.exercises.includes(t)) return false;
  state.workoutData.exercises.push(t);
  saveWorkoutLocal();
  return true;
}

// ── Workout templates ─────────────────────────────────────────
function saveWorkoutTemplate(name, exercises, editId) {
  if (!name.trim() || !exercises.length) return false;
  if (editId) {
    const i = state.workoutData.workouts.findIndex(w => w.id === editId);
    if (i !== -1) state.workoutData.workouts[i] = { id: editId, name: name.trim(), exercises };
  } else {
    state.workoutData.workouts.push({ id: uid(), name: name.trim(), exercises });
  }
  saveWorkoutLocal();
  // Fire-and-forget Sheets sync
  saveTemplatesToSheets().catch(e => console.warn('Template sync:', e));
  return true;
}

function deleteWorkout(id) {
  state.workoutData.workouts = state.workoutData.workouts.filter(w => w.id !== id);
  saveWorkoutLocal();
  saveTemplatesToSheets().catch(e => console.warn('Template sync:', e));
}

// ── Sessions ──────────────────────────────────────────────────
function buildSession(workoutId, workoutName, date, entries) {
  const valid = entries.filter(e =>
    Array.isArray(e.sets) ? e.sets.length > 0 : e.weight > 0 && e.sets > 0 && e.reps > 0
  );
  if (!valid.length) return null;
  return { id: uid(), date: date || todayISO(), workoutId, workoutName, entries: valid };
}

function commitSession(session) {
  state.workoutData.sessions.push(session);
  saveWorkoutLocal();
  if (state.googleToken) {
    appendSessionToSheets(session)
      .then(() => rewriteTrainerSheet())
      .catch(e => console.warn('Session sync:', e));
  }
}

// ── Performance analysis ──────────────────────────────────────
function sessionVolMap(session) {
  const m = {};
  for (const e of session.entries) m[e.exercise] = (m[e.exercise] || 0) + vol(e);
  return m;
}

function buildPerfRows(workoutId) {
  const sessions = [...state.workoutData.sessions]
    .filter(s => !workoutId || s.workoutId === workoutId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!sessions.length) return [];

  const latest  = sessions[0];
  const cur     = sessionVolMap(latest);
  const prev    = sessions[1] || null;
  const prevMap = prev ? sessionVolMap(prev) : {};

  const cutoff = new Date(latest.date + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() - 30);
  const monthSess = sessions.slice(1).filter(s => new Date(s.date + 'T00:00:00') >= cutoff);

  return Object.entries(cur).map(([ex, curVol]) => {
    const prevVol  = prevMap[ex] ?? null;
    const exMonth  = monthSess.filter(s => s.entries.some(e => e.exercise === ex));
    const monthAvg = exMonth.length
      ? exMonth.reduce((sum, s) => sum + (sessionVolMap(s)[ex] || 0), 0) / exMonth.length
      : null;
    return {
      ex, curVol, prevVol,
      prevDate: prev?.date || null,
      monthAvg,
      vsPrev:  prevVol  !== null ? (curVol - prevVol)  / prevVol  * 100 : null,
      vsMonth: monthAvg !== null ? (curVol - monthAvg) / monthAvg * 100 : null,
    };
  });
}

// ── Per-workout accordion (landing page) ─────────────────────
// Returns null if no sessions for this workout.
// Otherwise returns { workout, lastDate, rows[] } where each row has:
//   { ex, lastVol, avg7, avg30, vsAvg7, vsAvg30 }
// avg7/avg30 = average volume of that exercise across sessions in the
//   7 or 30 days BEFORE the last session (so the last session is excluded).
function buildPerWorkoutPerfRows(workout, sessions) {
  const wSessions = sessions
    .filter(s => s.workoutId === workout.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!wSessions.length) return null;

  const latest   = wSessions[0];
  const lastDate = new Date(latest.date + 'T00:00:00');
  const cut7     = new Date(+lastDate - 7  * 86400000);
  const cut30    = new Date(+lastDate - 30 * 86400000);

  const preceding = wSessions.slice(1);
  const prev7  = preceding.filter(s => new Date(s.date + 'T00:00:00') >= cut7);
  const prev30 = preceding.filter(s => new Date(s.date + 'T00:00:00') >= cut30);

  const avgVol = (sessArr, ex) => {
    if (!sessArr.length) return null;
    const withEx = sessArr.filter(s => s.entries.some(e => e.exercise === ex));
    if (!withEx.length) return null;
    return withEx.reduce((sum, s) => sum + (sessionVolMap(s)[ex] || 0), 0) / withEx.length;
  };

  const sessionAvgWt = (sess, ex) => {
    const entry = sess.entries.find(e => e.exercise === ex);
    return entry ? avgWt(entry) : null;
  };

  const avgWtOverSessions = (sessArr, ex) => {
    if (!sessArr.length) return null;
    const weights = sessArr.map(s => sessionAvgWt(s, ex)).filter(w => w !== null);
    if (!weights.length) return null;
    return weights.reduce((sum, w) => sum + w, 0) / weights.length;
  };

  const lastMap = sessionVolMap(latest);
  const rows = Object.entries(lastMap).map(([ex, lastVol]) => {
    const avg7  = avgVol(prev7,  ex);
    const avg30 = avgVol(prev30, ex);
    const lastAvgWt = sessionAvgWt(latest, ex);
    const avg7Wt    = avgWtOverSessions(prev7, ex);
    return {
      ex, lastVol,
      avg7,  vsAvg7:  avg7  !== null ? (lastVol - avg7)  / avg7  * 100 : null,
      avg30, vsAvg30: avg30 !== null ? (lastVol - avg30) / avg30 * 100 : null,
      lastAvgWt,
      avg7Wt, vsAvg7Wt: (lastAvgWt !== null && avg7Wt !== null) ? (lastAvgWt - avg7Wt) / avg7Wt * 100 : null,
    };
  });

  return { workout, lastDate: latest.date, rows };
}

function renderPerWorkoutAccordion(elId) {
  const el = getEl(elId);
  if (!el) return;

  const sessions = state.workoutData.sessions;
  const results  = state.workoutData.workouts
    .map(w => buildPerWorkoutPerfRows(w, sessions))
    .filter(Boolean)
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate)); // most recently used first

  if (!results.length) {
    el.innerHTML = '<div class="empty-state">No sessions logged yet — data appears after your first session.</div>';
    return;
  }

  el.innerHTML = results.map((res, idx) => `
    <details class="perf-accordion" ${idx === 0 ? 'open' : ''}>
      <summary class="perf-accordion-summary">
        <span class="perf-accordion-name">${res.workout.name}</span>
        <span class="perf-accordion-meta">Last: ${fmtDate(res.lastDate)}</span>
      </summary>
      <table class="perf-table">
        <thead><tr>
          <th>Exercise</th>
          <th>Last Session</th>
          <th>vs 7-day Avg</th>
          <th>vs 30-day Avg</th>
          <th>Avg Wt (Last)</th>
          <th>vs 7d Avg Wt</th>
        </tr></thead>
        <tbody>${res.rows.map(r => `
          <tr>
            <td class="perf-exercise">${r.ex}</td>
            <td class="perf-volume">${fmtVol(r.lastVol)}</td>
            <td>${fmtChg(r.vsAvg7)}</td>
            <td>${fmtChg(r.vsAvg30)}</td>
            <td class="perf-volume">${fmtWt(r.lastAvgWt)}</td>
            <td>${fmtChg(r.vsAvg7Wt)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </details>`).join('');
}

// ── Weekly performance (landing page) ────────────────────────
function buildWeeklyPerfRows() {
  const now  = new Date(); now.setHours(23, 59, 59, 999);
  const msDay = 86400000;
  const t7   = new Date(+now - 7  * msDay);  // start of this week window
  const t14  = new Date(+now - 14 * msDay);  // start of last week window
  const t28  = new Date(+now - 28 * msDay);  // start of monthly window

  const inRange = (dateStr, from, to) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d >= from && d <= to;
  };

  const allSessions   = state.workoutData.sessions;
  const thisWeekSess  = allSessions.filter(s => inRange(s.date, t7,  now));
  const lastWeekSess  = allSessions.filter(s => inRange(s.date, t14, t7));
  const lastMonthSess = allSessions.filter(s => inRange(s.date, t28, t7)); // 4 weeks before this week

  const sumByEx = sessions => {
    const m = {};
    for (const sess of sessions)
      for (const e of sess.entries)
        m[e.exercise] = (m[e.exercise] || 0) + vol(e);
    return m;
  };

  const thisMap  = sumByEx(thisWeekSess);
  const prevMap  = sumByEx(lastWeekSess);
  // Monthly avg = total tonnage over the 4 preceding weeks ÷ 4
  const monthMap = sumByEx(lastMonthSess);
  const avgMap   = Object.fromEntries(Object.entries(monthMap).map(([k, v]) => [k, v / 4]));

  return Object.entries(thisMap)
    .map(([ex, curVol]) => {
      const prevVol     = prevMap[ex] ?? null;
      const avgVol      = avgMap[ex]  ?? null;
      const hasPrev     = prevVol !== null && prevVol > 0;
      const hasAvg      = avgVol  !== null && avgVol  > 0;
      const vsPrev      = hasPrev ? (curVol - prevVol) / prevVol * 100 : 0;
      const vsAvg       = hasAvg  ? (curVol - avgVol)  / avgVol  * 100 : 0;
      return { ex, curVol, prevVol, avgVol, hasPrev, hasAvg, vsPrev, vsAvg };
    })
    .sort((a, b) => b.curVol - a.curVol);
}

function renderWeeklyPerfTable(elId) {
  const el = getEl(elId);
  if (!el) return;
  const rows = buildWeeklyPerfRows();

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">No sessions in the past 7 days — log a workout to see your weekly volume here.</div>';
    return;
  }

  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Exercise</th>
          <th>This Week</th>
          <th>vs Last Week</th>
          <th>vs Month Avg</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="perf-exercise">${r.ex}</td>
            <td class="perf-volume">${fmtVol(r.curVol)}</td>
            <td>${fmtChgWeekly(r.vsPrev, r.hasPrev)}</td>
            <td>${fmtChgWeekly(r.vsAvg,  r.hasAvg)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Per-session performance (log session reference) ───────────
function renderPerfTable(workoutId, elId) {
  const el = getEl(elId);
  if (!el) return;
  const rows = buildPerfRows(workoutId);
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">No sessions logged yet — data appears after your first session.</div>';
    return;
  }
  el.innerHTML = `
    <table class="perf-table">
      <thead><tr>
        <th>Exercise</th><th>Latest</th><th>Previous</th>
        <th>vs Prev</th><th>Month Avg</th><th>vs Avg</th>
      </tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td class="perf-exercise">${r.ex}</td>
          <td class="perf-volume">${fmtVol(r.curVol)}</td>
          <td class="perf-muted">${r.prevVol !== null
            ? `${fmtVol(r.prevVol)}<br><span style="font-size:11px;color:var(--text-muted)">${fmtDate(r.prevDate)}</span>`
            : '<span class="change-na">—</span>'}</td>
          <td>${fmtChg(r.vsPrev)}</td>
          <td class="perf-muted">${r.monthAvg !== null ? fmtVol(r.monthAvg) : '<span class="change-na">—</span>'}</td>
          <td>${fmtChg(r.vsMonth)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderWorkoutGrid() {
  const el = getEl('workoutGrid');
  if (!el) return;
  if (!state.workoutData.workouts.length) {
    el.innerHTML = `
      <div class="no-workouts">
        <div class="no-workouts-title">No workouts yet</div>
        <div class="no-workouts-sub">Click "+ New Workout" to create your first — e.g. Arm Day, Push Day, Leg Day.</div>
      </div>`;
    return;
  }
  el.innerHTML = state.workoutData.workouts.map(w => `
    <div class="workout-card">
      <div class="workout-card-name">${w.name}</div>
      <div class="workout-card-meta">${w.exercises.length} exercise${w.exercises.length !== 1 ? 's' : ''}</div>
      <div class="workout-card-exercises">${w.exercises.slice(0, 4).join(', ')}${w.exercises.length > 4 ? '…' : ''}</div>
      <div class="workout-card-actions">
        <button class="btn btn-primary btn-sm" data-start="${w.id}">Start Session</button>
        <button class="btn btn-outline btn-sm" data-edit="${w.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-delete="${w.id}">Delete</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('[data-start]').forEach(b  => b.addEventListener('click', () => openLogSession(b.dataset.start)));
  el.querySelectorAll('[data-edit]').forEach(b   => b.addEventListener('click', () => openCreateWorkout(b.dataset.edit)));
  el.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => {
    const w = state.workoutData.workouts.find(w => w.id === b.dataset.delete);
    if (w && confirm(`Delete "${w.name}"?`)) { deleteWorkout(w.id); renderListView(); }
  }));
}

function renderSessionHistory() {
  const el = getEl('sessionHistory');
  if (!el) return;
  const sessions = [...state.workoutData.sessions]
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);

  if (!sessions.length) { el.innerHTML = '<div class="empty-state">No sessions logged yet.</div>'; return; }
  el.innerHTML = sessions.map(s => {
    const vm    = sessionVolMap(s);
    const total = Object.values(vm).reduce((a, b) => a + b, 0);
    return `
      <div class="session-item">
        <div class="session-item-header">
          <div>
            <span class="session-date">${fmtDate(s.date)}</span>
            <span class="session-workout-tag">${s.workoutName}</span>
          </div>
          <div class="session-item-right">
            <span class="session-total">${fmtVol(total)} total</span>
            <button class="btn btn-outline btn-sm" data-edit-session="${s.id}">Edit</button>
          </div>
        </div>
        <div class="session-exercises">
          ${Object.entries(vm).map(([ex, v]) => `<span class="exercise-chip">${ex} · ${fmtVol(v)}</span>`).join('')}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-edit-session]').forEach(btn =>
    btn.addEventListener('click', () => openEditSession(btn.dataset.editSession))
  );
}

function renderListView() {
  renderWorkoutGrid();
  renderPerWorkoutAccordion('perfMain');
  renderSessionHistory();
  showView('workouts');
}

// ── Create / Edit workout ─────────────────────────────────────
function openCreateWorkout(editId) {
  state.editingWorkoutId = editId || null;
  if (editId) {
    const w = state.workoutData.workouts.find(w => w.id === editId);
    if (!w) return;
    getEl('createWorkoutTitle').textContent = `Edit: ${w.name}`;
    getEl('workoutNameInput').value = w.name;
    state.newWorkoutExercises = [...w.exercises];
  } else {
    getEl('createWorkoutTitle').textContent = 'New Workout';
    getEl('workoutNameInput').value = '';
    state.newWorkoutExercises = [];
  }
  refreshWorkoutExList();
  refreshLibrarySelect();
  showView('create-workout');
}

function refreshWorkoutExList() {
  const el = getEl('workoutExerciseList');
  if (!el) return;
  if (!state.newWorkoutExercises.length) {
    el.innerHTML = '<div class="empty-state" style="padding:12px 0;text-align:left">No exercises added yet.</div>';
    return;
  }
  el.innerHTML = state.newWorkoutExercises.map((ex, i) => `
    <div class="exercise-item">
      <span class="exercise-item-name">${ex}</span>
      <div class="exercise-item-controls">
        <button class="reorder-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="reorder-btn" data-dn="${i}" ${i === state.newWorkoutExercises.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-ghost" data-rm="${i}">Remove</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.up;
    [state.newWorkoutExercises[i-1], state.newWorkoutExercises[i]] = [state.newWorkoutExercises[i], state.newWorkoutExercises[i-1]];
    refreshWorkoutExList();
  }));
  el.querySelectorAll('[data-dn]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.dn;
    [state.newWorkoutExercises[i], state.newWorkoutExercises[i+1]] = [state.newWorkoutExercises[i+1], state.newWorkoutExercises[i]];
    refreshWorkoutExList();
  }));
  el.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    state.newWorkoutExercises.splice(+b.dataset.rm, 1);
    refreshWorkoutExList(); refreshLibrarySelect();
  }));
}

function refreshLibrarySelect() {
  const sel = getEl('addExToWorkoutSelect');
  if (!sel) return;
  const avail = state.workoutData.exercises.filter(e => !state.newWorkoutExercises.includes(e));
  sel.innerHTML = '<option value="">Add from library…</option>';
  avail.forEach(ex => { const o = document.createElement('option'); o.value = o.textContent = ex; sel.appendChild(o); });
}

// ── Log session ───────────────────────────────────────────────
function renderSetRow(exIdx, setIdx, weight = '', reps = '') {
  return `
    <div class="set-row" data-set-idx="${setIdx}">
      <span class="set-number">Set ${setIdx + 1}</span>
      <div class="set-fields">
        <input type="number" class="form-input set-input" data-ex="${exIdx}" data-set="${setIdx}" data-field="weight" min="0" step="0.5" placeholder="kg" ${weight !== '' ? `value="${weight}"` : ''}>
        <span class="set-unit">kg</span>
        <input type="number" class="form-input set-input" data-ex="${exIdx}" data-set="${setIdx}" data-field="reps" min="1" placeholder="reps" ${reps !== '' ? `value="${reps}"` : ''}>
        <span class="set-unit">reps</span>
        <button class="btn btn-ghost remove-set-btn" data-ex-idx="${exIdx}" data-set-idx="${setIdx}" title="Remove set" style="visibility:hidden">✕</button>
      </div>
    </div>`;
}

function renumberSets(setsList) {
  const rows = setsList.querySelectorAll('.set-row');
  rows.forEach((row, i) => {
    row.dataset.setIdx = i;
    const numEl = row.querySelector('.set-number');
    if (numEl) numEl.textContent = `Set ${i + 1}`;
    row.querySelectorAll('[data-set]').forEach(inp => { inp.dataset.set = i; });
    const rmBtn = row.querySelector('.remove-set-btn');
    if (rmBtn) { rmBtn.dataset.setIdx = i; rmBtn.style.visibility = rows.length > 1 ? 'visible' : 'hidden'; }
  });
}

function addSetToExercise(exIdx) {
  const setsList = getEl('sessionExerciseInputs').querySelector(`.sets-list[data-ex-idx="${exIdx}"]`);
  if (!setsList) return;
  const newIdx = setsList.querySelectorAll('.set-row').length;
  setsList.insertAdjacentHTML('beforeend', renderSetRow(exIdx, newIdx));
  renumberSets(setsList);
}

function attachSessionContainerHandler(container) {
  container.onclick = e => {
    const addBtn = e.target.closest('.add-set-btn');
    if (addBtn) { addSetToExercise(+addBtn.dataset.exIdx); return; }
    const rmBtn = e.target.closest('.remove-set-btn');
    if (rmBtn) {
      const setsList = container.querySelector(`.sets-list[data-ex-idx="${rmBtn.dataset.exIdx}"]`);
      const rows = setsList.querySelectorAll('.set-row');
      if (rows.length <= 1) return;
      rows[+rmBtn.dataset.setIdx].remove();
      renumberSets(setsList);
    }
  };
}

function openLogSession(workoutId) {
  const w = state.workoutData.workouts.find(w => w.id === workoutId);
  if (!w) return;
  state.activeWorkoutId  = workoutId;
  state.editingSessionId = null;
  getEl('logSessionTitle').textContent = w.name;
  getEl('sessionDate').value = todayISO();
  const saveBtn = getEl('saveSessionBtn');
  if (saveBtn) saveBtn.textContent = 'Save Session';

  const container = getEl('sessionExerciseInputs');
  container.innerHTML = w.exercises.map((ex, exIdx) => `
    <div class="exercise-input-row" data-ex-idx="${exIdx}">
      <div class="exercise-input-label">${ex}</div>
      <div class="sets-list" data-ex-idx="${exIdx}">
        ${renderSetRow(exIdx, 0)}
      </div>
      <button class="btn btn-outline btn-sm add-set-btn" data-ex-idx="${exIdx}" style="margin-top:10px">+ Add Set</button>
    </div>`).join('');

  attachSessionContainerHandler(container);
  renderPerfTable(workoutId, 'perfLog');
  showView('log-session');
}

function openEditSession(sessionId) {
  const session = state.workoutData.sessions.find(s => s.id === sessionId);
  if (!session) return;
  state.editingSessionId = sessionId;
  state.activeWorkoutId  = session.workoutId;
  getEl('logSessionTitle').textContent = session.workoutName + ' — Edit';
  getEl('sessionDate').value = session.date;
  const saveBtn = getEl('saveSessionBtn');
  if (saveBtn) saveBtn.textContent = 'Update Session';

  const container = getEl('sessionExerciseInputs');
  container.innerHTML = session.entries.map((entry, exIdx) => `
    <div class="exercise-input-row" data-ex-idx="${exIdx}">
      <div class="exercise-input-label">${entry.exercise}</div>
      <div class="sets-list" data-ex-idx="${exIdx}">
        ${(Array.isArray(entry.sets) ? entry.sets : [{ weight: entry.weight, reps: entry.reps }])
          .map((s, setIdx) => renderSetRow(exIdx, setIdx, s.weight || '', s.reps || '')).join('')}
      </div>
      <button class="btn btn-outline btn-sm add-set-btn" data-ex-idx="${exIdx}" style="margin-top:10px">+ Add Set</button>
    </div>`).join('');

  container.querySelectorAll('.sets-list').forEach(sl => renumberSets(sl));
  attachSessionContainerHandler(container);
  renderPerfTable(session.workoutId, 'perfLog');
  showView('log-session');
}

// ── Body weight ───────────────────────────────────────────────
function addBodyweightEntry(date, weight, waist, notes) {
  if (!isValidBwYear(date)) { alert('Please enter a valid date.'); return; }
  // Replace any existing entry for the same date
  state.bodyweightData.entries = state.bodyweightData.entries.filter(e => e.date !== date);
  state.bodyweightData.entries.push({
    date, weight: parseFloat(weight),
    waist: waist ? parseFloat(waist) : null,
    notes: notes || '',
  });
  state.bodyweightData.entries.sort((a, b) => new Date(a.date) - new Date(b.date));
  saveBodyweightLocal();
}

function threeMonthEntries() {
  const cut = new Date(); cut.setMonth(cut.getMonth() - 3);
  return state.bodyweightData.entries.filter(e => new Date(e.date + 'T00:00:00') >= cut);
}

// ── Weight chart ──────────────────────────────────────────────
function renderWeightChart() {
  const entries = threeMonthEntries();
  const canvas  = getEl('weightChart');
  if (!canvas) return;
  if (state.weightChart) { state.weightChart.destroy(); state.weightChart = null; }

  state.weightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels:   entries.map(e => fmtDate(e.date)),
      datasets: [{
        label: 'Weight (kg)', data: entries.map(e => e.weight),
        borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,0.08)',
        pointBackgroundColor: '#7c3aed', pointBorderColor: '#fff',
        pointBorderWidth: 2, pointRadius: 5, pointHoverRadius: 7,
        tension: 0.35, fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1f2937', borderColor: '#374151', borderWidth: 1,
          titleColor: '#e6edf3', bodyColor: '#8b949e', padding: 10,
          callbacks: { label: c => `  Weight: ${c.raw} kg` },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8b949e', callback: v => v + ' kg', font: { size: 11 } } },
      },
    },
  });
}

function renderBwHistory() {
  const el = getEl('bwHistory');
  if (!el) return;
  const entries = [...state.bodyweightData.entries]
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);
  if (!entries.length) { el.innerHTML = '<div class="empty-state">No entries yet.</div>'; return; }
  el.innerHTML = `
    <table class="bw-table">
      <thead><tr><th>Date</th><th>Weight (kg)</th><th>Waist (in)</th><th>Notes</th><th></th></tr></thead>
      <tbody>${entries.map(e => `
        <tr>
          <td>${fmtDate(e.date)}</td>
          <td>${e.weight}</td>
          <td>${e.waist ?? '—'}</td>
          <td class="bw-notes">${e.notes || '—'}</td>
          <td><button class="btn btn-outline btn-sm" data-edit-bw="${e.date}">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  el.querySelectorAll('[data-edit-bw]').forEach(btn => btn.addEventListener('click', () => {
    const entry = state.bodyweightData.entries.find(e => e.date === btn.dataset.editBw);
    if (!entry) return;
    getEl('bwDate').value   = entry.date;
    getEl('bwWeight').value = entry.weight ?? '';
    getEl('bwWaist').value  = entry.waist  ?? '';
    getEl('bwNotes').value  = entry.notes  || '';
    const saveBtn = getEl('saveBwBtn');
    if (saveBtn) saveBtn.textContent = 'Update Entry';
    getEl('bwDate').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

function renderBodyweightTab() {
  renderWeightChart();
  renderBwHistory();
}

// ── Settings UI helpers ───────────────────────────────────────
function updateGoogleStatus(connected) {
  const dot  = getEl('gStatusDot');
  const text = getEl('gStatusText');
  const btn  = getEl('connectGoogleBtn');
  if (!dot) return;
  dot.className    = connected ? 'status-dot connected' : 'status-dot';
  text.textContent = connected ? 'Connected' : 'Not connected';
  if (btn) btn.textContent = connected ? 'Reconnect' : 'Connect Google';
}

function updateWorkoutSheetStatus() {
  const dot    = getEl('wSheetDot');
  const text   = getEl('wSheetText');
  const link   = getEl('workoutSheetLink');
  const anchor = getEl('workoutSheetAnchor');
  if (!dot) return;
  if (state.workoutSheetId) {
    dot.className    = 'status-dot connected';
    text.textContent = 'Workout spreadsheet ready';
    if (anchor) anchor.href = `https://docs.google.com/spreadsheets/d/${state.workoutSheetId}`;
    link?.classList.remove('hidden');
  } else {
    dot.className    = 'status-dot';
    text.textContent = 'Not set up — connect Google first';
    link?.classList.add('hidden');
  }
}

function showBwStatus(msg, type) {
  const el = getEl('syncStatus');
  if (!el) return;
  el.textContent = msg; el.className = `sync-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

function showSessionStatus(msg, type) {
  const el = getEl('sessionSaveStatus');
  if (!el) return;
  el.textContent = msg; el.className = `sync-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function showModal(id) { getEl(id)?.classList.remove('hidden'); }
function hideModal(id) { getEl(id)?.classList.add('hidden'); }

// ── Event listeners ───────────────────────────────────────────
function setupEvents() {

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      getEl(`${btn.dataset.tab}-tab`).classList.add('active');
      if (btn.dataset.tab === 'bodyweight') renderBodyweightTab();
    })
  );

  // Settings modal
  getEl('settingsBtn')?.addEventListener('click', () => {
    const ci = getEl('clientIdInput');
    if (ci && state.clientId) ci.value = state.clientId;
    const si = getEl('sheetIdInput');
    if (si && state.workoutSheetId) si.value = state.workoutSheetId;
    updateWorkoutSheetStatus();
    showModal('settingsModal');
  });
  getEl('closeSettingsBtn')?.addEventListener('click', () => hideModal('settingsModal'));
  getEl('settingsModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) hideModal('settingsModal'); });

  // Save client ID (and optional spreadsheet ID)
  getEl('saveSettingsBtn')?.addEventListener('click', () => {
    const val = getEl('clientIdInput')?.value.trim();
    if (!val) { alert('Please paste your Google OAuth Client ID.'); return; }
    state.clientId = val;
    localStorage.setItem('ft_clientId', val);

    const sheetVal = getEl('sheetIdInput')?.value.trim();
    if (sheetVal) {
      // Accept full URL or bare ID
      const match = sheetVal.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      const id = match ? match[1] : sheetVal;
      state.workoutSheetId = id;
      localStorage.setItem('ft_workoutSheetId', id);
      updateWorkoutSheetStatus();
    }

    state.tokenClient = null;
    initTokenClient();
    alert('Saved. Click "Connect Google" to sign in.');
  });

  // Connect Google (in settings)
  getEl('connectGoogleBtn')?.addEventListener('click', () => {
    if (!state.clientId) { alert('Save your Client ID first.'); return; }
    requestGoogleToken();
  });

  // Sync pill — click to reconnect
  getEl('syncPill')?.addEventListener('click', () => {
    if (!state.googleToken) requestGoogleToken();
  });

  // ── Workout views ──
  getEl('newWorkoutBtn')?.addEventListener('click',  () => openCreateWorkout(null));
  getEl('backToListBtn')?.addEventListener('click',  () => renderListView());
  getEl('backFromLogBtn')?.addEventListener('click', () => renderListView());

  // Add exercise from library
  getEl('addExToWorkoutBtn')?.addEventListener('click', () => {
    const sel = getEl('addExToWorkoutSelect');
    const val = sel?.value;
    if (!val || state.newWorkoutExercises.includes(val)) return;
    state.newWorkoutExercises.push(val);
    sel.value = '';
    refreshWorkoutExList(); refreshLibrarySelect();
  });

  // Add new exercise to library & workout
  getEl('addToLibraryBtn')?.addEventListener('click', () => {
    const input = getEl('newExerciseName');
    const name  = input?.value.trim();
    if (!name) return;
    addToLibrary(name);
    if (!state.newWorkoutExercises.includes(name)) {
      state.newWorkoutExercises.push(name);
      refreshWorkoutExList();
    }
    input.value = '';
    refreshLibrarySelect();
  });
  getEl('newExerciseName')?.addEventListener('keypress', e => { if (e.key === 'Enter') getEl('addToLibraryBtn')?.click(); });

  // Save workout template
  getEl('saveWorkoutTemplateBtn')?.addEventListener('click', () => {
    const name = getEl('workoutNameInput')?.value;
    if (!name?.trim())                    { alert('Please enter a workout name.'); return; }
    if (!state.newWorkoutExercises.length){ alert('Please add at least one exercise.'); return; }
    saveWorkoutTemplate(name, [...state.newWorkoutExercises], state.editingWorkoutId);
    renderListView();
  });

  // Save / update session
  getEl('saveSessionBtn')?.addEventListener('click', async () => {
    const date      = getEl('sessionDate')?.value || todayISO();
    const container = getEl('sessionExerciseInputs');

    // Read entries from DOM (works for both new and edit)
    const entries = Array.from(container.querySelectorAll('.exercise-input-row')).map(row => {
      const exercise = row.querySelector('.exercise-input-label')?.textContent || '';
      const setsList = row.querySelector('.sets-list');
      const sets = Array.from(setsList?.querySelectorAll('.set-row') || []).map(setRow => ({
        weight: parseFloat(setRow.querySelector('[data-field="weight"]')?.value) || 0,
        reps:   parseInt(setRow.querySelector('[data-field="reps"]')?.value)     || 0,
      })).filter(s => s.weight > 0 && s.reps > 0);
      return { exercise, sets };
    });

    const validEntries = entries.filter(e => e.sets.length > 0);
    if (!validEntries.length) { alert('Fill in weight and reps for at least one set.'); return; }

    if (state.editingSessionId) {
      // ── Update existing session ──
      const idx = state.workoutData.sessions.findIndex(s => s.id === state.editingSessionId);
      if (idx !== -1) {
        state.workoutData.sessions[idx] = { ...state.workoutData.sessions[idx], date, entries: validEntries };
        saveWorkoutLocal();
        state.editingSessionId = null;
        if (state.googleToken) {
          showSessionStatus('Updating Google Sheets…', 'success');
          try {
            await rewriteSessionsToSheets();
            showSessionStatus('Session updated and synced to Google Sheets.', 'success');
          } catch (err) {
            showSessionStatus('Saved locally. Sheets error: ' + err.message, 'error');
          }
        } else {
          showSessionStatus('Session updated locally. Connect Google to sync.', 'success');
        }
      }
    } else {
      // ── New session ──
      const workout = state.workoutData.workouts.find(w => w.id === state.activeWorkoutId);
      const session = buildSession(state.activeWorkoutId, workout?.name || '', date, validEntries);
      if (!session) { alert('Fill in weight and reps for at least one set.'); return; }
      commitSession(session);
      showSessionStatus(state.googleToken ? 'Session saved and syncing to Google Sheets…' : 'Session saved locally.', 'success');
    }

    setTimeout(() => renderListView(), 1200);
  });

  // Save body weight
  getEl('saveBwBtn')?.addEventListener('click', async () => {
    const date   = getEl('bwDate')?.value   || todayISO();
    const weight = getEl('bwWeight')?.value;
    const waist  = getEl('bwWaist')?.value;
    const notes  = getEl('bwNotes')?.value  || '';
    if (!weight) { alert('Please enter your weight.'); return; }

    addBodyweightEntry(date, weight, waist || null, notes);
    renderBodyweightTab();

    const btn = getEl('saveBwBtn');
    btn.textContent = 'Saving…'; btn.disabled = true;

    try {
      if (state.googleToken) {
        const w = parseFloat(weight);
        const ws = waist ? parseFloat(waist) : null;
        await rewriteBwToUserSheet();
        await appendBwToTrainerSheet(date, w, ws, notes);
        showBwStatus('Saved and synced to Google Sheets.', 'success');
      } else {
        showBwStatus('Saved locally. Connect Google to sync across devices.', 'success');
      }
      getEl('bwWeight').value = '';
      getEl('bwWaist').value  = '';
      getEl('bwNotes').value  = '';
      getEl('bwDate').value   = todayISO();
      btn.textContent = 'Save Entry';
    } catch (err) {
      showBwStatus('Local save done — Sheets error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Init ──────────────────────────────────────────────────────
function init() {
  // Register service worker for PWA / offline
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .catch(e => console.warn('SW registration failed:', e));
  }

  loadLocal();

  // Set default dates
  const bd = getEl('bwDate');
  if (bd) bd.value = todayISO();

  // Attempt silent sign-in once GIS loads; retries until the library is ready
  const tryGoogle = () => {
    if (typeof google !== 'undefined' && google.accounts?.oauth2) {
      if (state.clientId) {
        initTokenClient();
        // prompt:'' = silent — no popup; succeeds if the user is already
        // signed into Google in this browser, fails quietly otherwise
        state.silentAuthInProgress = true;
        state.tokenClient?.requestAccessToken({ prompt: '' });
      }
    } else {
      setTimeout(tryGoogle, 500);
    }
  };
  tryGoogle();

  setupEvents();
  renderListView();
  setSyncStatus(state.workoutSheetId ? 'idle' : 'idle');
  updateGoogleStatus(false);
  updateWorkoutSheetStatus();
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();
