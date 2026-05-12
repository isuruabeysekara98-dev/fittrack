// Pure utility functions shared between app.js (browser) and the test suite.
// All exports are side-effect-free.

export function todayISO() { return new Date().toISOString().split('T')[0]; }

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function vol(e) {
  if (Array.isArray(e.sets)) return e.sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0);
  return (e.weight || 0) * (e.sets || 0) * (e.reps || 0);
}

export function fmtVol(v) { return v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' kg'; }

export function fmtChg(p) {
  if (p === null || p === undefined) return '<span class="change-na">—</span>';
  const cls = p >= 0 ? 'change-pos' : 'change-neg';
  return `<span class="${cls}">${p >= 0 ? '+' : ''}${p.toFixed(1)}%</span>`;
}

export function fmtChgWeekly(pct, hasBaseline) {
  if (!hasBaseline) return '<span class="change-zero">0.0%</span>';
  if (pct === 0)    return '<span class="change-zero">0.0%</span>';
  const cls = pct > 0 ? 'change-pos' : 'change-neg';
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
}

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

export function safeParseJSON(str, fallback) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export function normalizeSheetDate(val) {
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

export function sessionVolMap(session) {
  const m = {};
  for (const e of session.entries) m[e.exercise] = (m[e.exercise] || 0) + vol(e);
  return m;
}

export function formatSetValues(sets, field) {
  if (!sets || !sets.length) return '';
  const vals = sets.map(s => s[field] ?? '');
  if (vals.every(v => v === vals[0])) return String(vals[0]);
  return vals.join(' / ');
}

// Pure version of migrateOldEntries: takes sessions[], returns new sessions[] (does not mutate state).
export function migrateOldEntries(sessions) {
  return sessions.map(session => ({
    ...session,
    entries: session.entries.map(e => {
      if (!Array.isArray(e.sets)) {
        const count = e.sets || 1;
        const sets = [];
        for (let i = 0; i < count; i++) sets.push({ weight: e.weight || 0, reps: e.reps || 0 });
        return { exercise: e.exercise, sets };
      }
      return e;
    }),
  }));
}

// Returns null if no sessions for this workout.
// Otherwise { workout, lastDate, rows: [{ ex, lastVol, avg7, avg30, vsAvg7, vsAvg30 }] }
export function buildPerWorkoutPerfRows(workout, sessions) {
  const wSessions = sessions
    .filter(s => s.workoutId === workout.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!wSessions.length) return null;

  const latest  = wSessions[0];
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

  const lastMap = sessionVolMap(latest);
  const rows = Object.entries(lastMap).map(([ex, lastVol]) => {
    const avg7  = avgVol(prev7,  ex);
    const avg30 = avgVol(prev30, ex);
    return {
      ex, lastVol,
      avg7,  vsAvg7:  avg7  !== null ? (lastVol - avg7)  / avg7  * 100 : null,
      avg30, vsAvg30: avg30 !== null ? (lastVol - avg30) / avg30 * 100 : null,
    };
  });

  return { workout, lastDate: latest.date, rows };
}
