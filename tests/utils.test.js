import { describe, it, expect } from 'vitest';
import {
  vol, sessionVolMap, safeParseJSON, normalizeSheetDate,
  buildPerWorkoutPerfRows, formatSetValues, migrateOldEntries,
} from '../utils.js';

// ── vol() ─────────────────────────────────────────────────────
describe('vol', () => {
  it('sums sets in new format', () => {
    expect(vol({ sets: [{ weight: 80, reps: 10 }, { weight: 85, reps: 8 }] })).toBe(1480);
  });
  it('handles legacy format', () => {
    expect(vol({ weight: 80, sets: 3, reps: 10 })).toBe(2400);
  });
  it('returns 0 for empty sets array', () => {
    expect(vol({ sets: [] })).toBe(0);
  });
  it('treats missing weight or reps as 0', () => {
    expect(vol({ sets: [{ weight: 0, reps: 10 }, { weight: 80, reps: 0 }] })).toBe(0);
  });
});

// ── migrateOldEntries() ───────────────────────────────────────
describe('migrateOldEntries', () => {
  it('converts old format to sets array', () => {
    const input = [{ id: '1', date: '2026-01-01', workoutId: 'w1', workoutName: 'Push',
      entries: [{ exercise: 'Bench', weight: 80, sets: 3, reps: 10 }] }];
    const out = migrateOldEntries(input);
    expect(out[0].entries[0].sets).toHaveLength(3);
    expect(out[0].entries[0].sets[0]).toEqual({ weight: 80, reps: 10 });
  });
  it('leaves new format untouched', () => {
    const input = [{ id: '2', date: '2026-01-02', workoutId: 'w1', workoutName: 'Push',
      entries: [{ exercise: 'Bench', sets: [{ weight: 80, reps: 10 }] }] }];
    const out = migrateOldEntries(input);
    expect(out[0].entries[0].sets).toHaveLength(1);
  });
  it('is idempotent', () => {
    const input = [{ id: '3', date: '2026-01-03', workoutId: 'w1', workoutName: 'Push',
      entries: [{ exercise: 'Bench', sets: [{ weight: 80, reps: 10 }] }] }];
    expect(migrateOldEntries(migrateOldEntries(input))).toEqual(migrateOldEntries(input));
  });
});

// ── normalizeSheetDate() ──────────────────────────────────────
describe('normalizeSheetDate', () => {
  it('passes through ISO date unchanged', () => {
    expect(normalizeSheetDate('2026-01-15')).toBe('2026-01-15');
  });
  it('converts a known serial number to ISO', () => {
    // 46045 = 2026-01-23 (days since 1899-12-30)
    expect(normalizeSheetDate('46045')).toBe('2026-01-23');
  });
  it('reformats M/D/YYYY localised string', () => {
    expect(normalizeSheetDate('1/15/2026')).toBe('2026-01-15');
  });
  it('returns falsy input unchanged', () => {
    expect(normalizeSheetDate('')).toBe('');
    expect(normalizeSheetDate(null)).toBe(null);
    expect(normalizeSheetDate(undefined)).toBe(undefined);
  });
  it('ignores out-of-range integers', () => {
    expect(normalizeSheetDate('2026')).toBe('2026'); // year, not a serial
  });
});

// ── buildPerWorkoutPerfRows() ─────────────────────────────────
const workout = { id: 'w1', name: 'Push', exercises: ['Bench'] };

function makeSession(id, date, weight, reps) {
  return {
    id, date, workoutId: 'w1', workoutName: 'Push',
    entries: [{ exercise: 'Bench', sets: [{ weight, reps }] }],
  };
}

describe('buildPerWorkoutPerfRows', () => {
  it('returns null when no sessions for this workout', () => {
    expect(buildPerWorkoutPerfRows(workout, [])).toBeNull();
    expect(buildPerWorkoutPerfRows(workout, [makeSession('s1', '2026-01-01', 80, 10)]
      .map(s => ({ ...s, workoutId: 'other' })))).toBeNull();
  });

  it('returns lastDate and null averages for a single session', () => {
    const res = buildPerWorkoutPerfRows(workout, [makeSession('s1', '2026-01-15', 80, 10)]);
    expect(res.lastDate).toBe('2026-01-15');
    expect(res.rows[0].lastVol).toBe(800);
    expect(res.rows[0].avg7).toBeNull();
    expect(res.rows[0].avg30).toBeNull();
    expect(res.rows[0].vsAvg7).toBeNull();
  });

  it('excludes last session from averages and calculates % change', () => {
    // latest: 2026-01-15 (900kg), within 7 days: 2026-01-12 (800kg)
    const sessions = [
      makeSession('s1', '2026-01-15', 90, 10),
      makeSession('s2', '2026-01-12', 80, 10),
    ];
    const res = buildPerWorkoutPerfRows(workout, sessions);
    expect(res.rows[0].lastVol).toBe(900);
    expect(res.rows[0].avg7).toBe(800);
    expect(res.rows[0].vsAvg7).toBeCloseTo(12.5, 1);
  });

  it('excludes sessions outside 7d window from avg7 but includes in avg30', () => {
    const sessions = [
      makeSession('s1', '2026-01-15', 90, 10), // latest
      makeSession('s2', '2026-01-05', 80, 10), // 10 days before → in avg30 only
    ];
    const res = buildPerWorkoutPerfRows(workout, sessions);
    expect(res.rows[0].avg7).toBeNull();
    expect(res.rows[0].avg30).toBe(800);
  });
});

// ── formatSetValues() ─────────────────────────────────────────
describe('formatSetValues', () => {
  it('returns single value when all sets are the same', () => {
    const sets = [{ weight: 80, reps: 10 }, { weight: 80, reps: 10 }];
    expect(formatSetValues(sets, 'weight')).toBe('80');
  });
  it('returns slash-separated when sets differ', () => {
    const sets = [{ weight: 80, reps: 10 }, { weight: 85, reps: 8 }];
    expect(formatSetValues(sets, 'weight')).toBe('80 / 85');
    expect(formatSetValues(sets, 'reps')).toBe('10 / 8');
  });
  it('handles a single set', () => {
    expect(formatSetValues([{ weight: 100, reps: 5 }], 'weight')).toBe('100');
  });
  it('returns empty string for null/empty input', () => {
    expect(formatSetValues(null, 'weight')).toBe('');
    expect(formatSetValues([], 'weight')).toBe('');
  });
});

// ── safeParseJSON() ───────────────────────────────────────────
describe('safeParseJSON', () => {
  it('parses valid JSON', () => {
    expect(safeParseJSON('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeParseJSON('[1,2,3]', [])).toEqual([1, 2, 3]);
  });
  it('returns fallback for invalid JSON', () => {
    expect(safeParseJSON('not json', [])).toEqual([]);
  });
  it('returns fallback for null/undefined input', () => {
    expect(safeParseJSON(null, [])).toEqual([]);
    expect(safeParseJSON(undefined, {})).toEqual({});
  });
});

// ── sessionVolMap() ───────────────────────────────────────────
describe('sessionVolMap', () => {
  it('sums volume per exercise across multiple sets', () => {
    const session = {
      entries: [
        { exercise: 'Bench', sets: [{ weight: 80, reps: 10 }, { weight: 85, reps: 8 }] },
        { exercise: 'OHP',   sets: [{ weight: 50, reps: 10 }] },
      ],
    };
    const m = sessionVolMap(session);
    expect(m['Bench']).toBe(1480);
    expect(m['OHP']).toBe(500);
  });
});
