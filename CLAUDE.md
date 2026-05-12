# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

Run locally with Node.js (no build step — pure static files):

```
Start Server.bat          # runs: npx serve . -l 8080
```

Then open `http://localhost:8080`. Deploy by dragging the folder onto Netlify.

**After any code change**, a normal F5 refresh picks up new `app.js` / `style.css` immediately — the service worker uses network-first for those files. No cache-busting needed. Only bump `CACHE` in `sw.js` if you change the SW itself or other cached assets (`manifest.json`, `icon.svg`).

## Architecture

Single-page app: one HTML file, one JS file, one CSS file. No framework, no bundler, no dependencies except Chart.js (CDN) and Google Identity Services (CDN).

### Data flow

All state lives in `state` (top of `app.js`). Persistence is two-layered:
- **localStorage** — always written first (`saveWorkoutLocal`, `saveBodyweightLocal`)
- **Google Sheets** — written second, fire-and-forget or awaited depending on context

On Google auth, `ensureWorkoutSpreadsheet()` creates a private "FitTrack — My Workout Data" spreadsheet if one doesn't exist yet, then `syncFromSheets()` merges remote data into local state. Merge rules: Sheets wins for templates; local wins for sessions (full rewrite on every sync); body weight is union by date with local winning on conflict.

### Two spreadsheets

| Sheet | Purpose | ID |
|---|---|---|
| User's private sheet | workout templates, sessions, BW entries | auto-created, stored in `localStorage ft_workoutSheetId` |
| Trainer's sheet | body weight only (append-only) | hardcoded `BW_SHEET_ID` constant |

### Workout data model

```js
workoutData: {
  exercises: string[],           // global exercise library
  workouts:  [{ id, name, exercises: string[] }],   // templates
  sessions:  [{ id, date, workoutId, workoutName, entries: [
    { exercise: string, sets: [{ weight, reps }] }  // NEW format
  ]}],
}
```

Old entry format `{ exercise, weight, sets: Number, reps }` is migrated to the new format by `migrateOldEntries()` on every `loadLocal()` call.

### Sheets column layout

- **Templates** `A:C` — ID, Name, Exercises (JSON array)
- **Sessions** `A:H` — Session ID, Date, Workout ID, Workout Name, Exercise, Set #, Weight (kg), Reps — one row per set
- **BodyWeight** `A:D` — Date, Weight (kg), Waist (in), Notes

### Google auth

Uses GIS implicit flow (`google.accounts.oauth2.initTokenClient`). On load, attempts a silent token request (`prompt: ''`) — succeeds automatically if the user already has a Google session in the browser. A `setTimeout` loop in `init()` waits for the GIS script to load before calling `initTokenClient()`. Token auto-refreshes 5 minutes before expiry via `scheduleTokenRefresh()`.

### UI routing (workout tab)

Three views toggled by adding/removing `.active` on `.wv` elements: `view-workouts` (landing grid) → `view-create-workout` (template editor) → `view-log-session` (session logger). `showView(name)` handles the toggle. `state.editingWorkoutId` and `state.editingSessionId` track whether create/log views are in edit mode.

### Service worker

Network-first for `app.js`, `style.css`, `index.html` (changes visible immediately). Cache-first for everything else. Google API calls are never intercepted.

### iPhone / PWA

`viewport-fit=cover` + `env(safe-area-inset-*)` CSS handles the notch and home indicator. On mobile (≤600px) the header splits into two rows: brand+icons on top, tabs spanning full width below.
