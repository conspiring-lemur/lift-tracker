'use strict';
/* Lift Tracker: a single-user, offline-first workout logger.
   All data lives in localStorage on the device. Use Program > Backup to save a copy. */

const KEY = 'lift-tracker-v1';

const TYPES = {
  total:    { label: 'Weight',     w: 'lbs',        r: 'reps',  step: 5, weighted: true },
  hand:     { label: 'Per hand',   w: 'lbs each',   r: 'reps',  step: 5, weighted: true },
  side:     { label: 'Per side',   w: 'lbs / side', r: 'reps',  step: 5, weighted: true },
  assisted: { label: 'Assisted',   w: 'assist lbs', r: 'reps',  step: 5, lowerBetter: true },
  bw:       { label: 'Bodyweight', w: '+lbs',       r: 'reps',  step: 5 },
  timed:    { label: 'Timed',      w: null,         r: 'sec',   step: 5 },
  cardio:   { label: 'Cardio',     w: 'min',        r: 'miles', step: 1 },
  circuit:  { label: 'Circuit',    w: null,         r: null },
};

/* ---------- state ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function seedState() {
  const exercises = {};
  const days = window.SEED_PROGRAM.map(([dayName, rows]) => ({
    id: slug(dayName),
    name: dayName,
    items: rows.map(([name, type, baseline = null, warmup = false, note = '']) => {
      const id = slug(name);
      if (!exercises[id]) exercises[id] = { id, name, type, note };
      else if (note && !exercises[id].note) exercises[id].note = note;
      return { exId: id, baseline, warmup: !!warmup };
    }),
  }));
  return {
    version: 1,
    userId: uid(), // sync-ready: lets a later version share progress with a gym buddy
    settings: { defaultSets: 6, repMin: 6, repMax: 8, restSec: 60, periodized: false, blockStart: today() },
    exercises, days, sessions: [], active: null,
  };
}

// One-time exercise cleanup (Nate, 2026-11-26). Ids stay the same for renames, so history and PRs
// carry over; merges move every logged entry onto the kept exercise. Also applied to fresh installs.
function cleanupExercises(d) {
  d.migrations = d.migrations || [];
  if (!d.migrations.includes('cleanup-2026-11-26')) cleanupA(d);
  if (!d.migrations.includes('renames-2026-11-26b')) renamesB(d);
  if (!d.migrations.includes('renames-2026-11-26c')) renamesB(d, 'renames-2026-11-26c');
  if (!d.migrations.includes('fly-both-2026-11-26')) flyBoth(d);
  if (!d.migrations.includes('fly-history-2026-11-26')) {
    // Past fly workouts were all the regular Fly machine; some were flagged warm-up by the old shared row.
    for (const sess of d.sessions || []) if (sess.date < '2026-11-26') for (const e of sess.entries || []) if (e.exId === 'fly-machine') e.warmup = false;
    d.migrations.push('fly-history-2026-11-26');
  }
  if (!d.migrations.includes('hamstring-both-2026-11-28')) hamstringBoth(d);
  if (!d.migrations.includes('decline-crunch-2026-11-28')) addDeclineCrunch(d);
  for (const sess of [...(d.sessions || []), ...(d.active ? [d.active] : [])]) splitFly(sess, d);
  return d;
}

// Clearer names Nate approved (2026-11-26). Same ids, so history and PRs stay attached.
function renamesB(d, flag = 'renames-2026-11-26b') {
  const exs = d.exercises || {};
  const renames = {
    'quad-extensions': ['Quad extensions', 'Leg extensions'],
    'calf-extensions': ['Calf extensions', 'Calf raises'],
    'standing-rows': ['Standing rows', 'Upright rows'],
    'y-lateral-dumbbell-raises': ['Y lateral dumbbell raises', 'Y raises'],
    'cross-chest-machine': ['Cross-chest machine', 'Single-arm cross-body chest press'],
    'supine-bench': ['Supine bench', 'Iso-lateral bench press'],
    'iso-lateral-supine-incline-press': ['Iso-lateral supine incline press', 'Iso-lateral incline press'],
  };
  for (const [id, [from, to]] of Object.entries(renames)) if (exs[id] && exs[id].name === from) exs[id].name = to;
  // Supine bench is a bench machine with a weighted arm on each side, so log it per side.
  if (exs['supine-bench'] && exs['supine-bench'].type === 'hand') exs['supine-bench'].type = 'side';
  // If "Upright rows" was already added from Suggestions, fold it into the renamed Standing rows.
  if (exs['upright-rows'] && exs['standing-rows']) mergeExercise(d, 'upright-rows', 'standing-rows');
  d.migrations.push(flag);
}

// Chest day needs both Fly machine rows: the warm-up and the working exercise (Nate, 2026-11-26).
// If the phone only had one fly row before the cleanup, that row became the warm-up and the working one vanished.
function flyBoth(d) {
  const exs = d.exercises || {}, chest = (d.days || []).find((x) => x.id === 'chest');
  if (chest) {
    if (!exs['fly-machine']) exs['fly-machine'] = { id: 'fly-machine', name: 'Fly machine', type: 'total', note: '' };
    if (!exs['fly-machine-warm-up']) exs['fly-machine-warm-up'] = { id: 'fly-machine-warm-up', name: 'Fly machine (warm-up)', type: exs['fly-machine'].type, note: '' };
    for (const it of chest.items) if (it.exId === 'fly-machine') it.warmup = false;
    if (!chest.items.some((it) => it.exId === 'fly-machine-warm-up')) {
      const at = chest.items.findIndex((it) => !it.warmup);
      chest.items.splice(at < 0 ? chest.items.length : at, 0, { exId: 'fly-machine-warm-up', baseline: 85, warmup: true });
    } else chest.items.find((it) => it.exId === 'fly-machine-warm-up').warmup = true;
    if (!chest.items.some((it) => it.exId === 'fly-machine')) {
      const after = chest.items.findIndex((it) => it.exId === 'single-arm-triceps-cable-pulls');
      chest.items.splice(after < 0 ? chest.items.length : after + 1, 0, { exId: 'fly-machine', baseline: 100, warmup: false });
    }
  }
  d.migrations.push('fly-both-2026-11-26');
}

// Fly machine warm-up vs working sets in one workout: sets heavier than the warm-up weight (85 lbs unless
// changed on Chest day) belong to the regular Fly machine, lighter ones to the warm-up. Fixes workouts logged
// while the two shared a row, and heavy sets logged on the warm-up row. Safe to run again and again.
// Pairs of [working id, warm-up id, day, default warm-up weight] that share this treatment.
const WARM_PAIRS = [['fly-machine', 'fly-machine-warm-up', 'chest', 85], ['hamstring-curls', 'hamstring-curls-warm-up', 'leg', 75]];
function splitFly(sess, d = S) { for (const pair of WARM_PAIRS) splitWarm(sess, d, ...pair); }
function splitWarm(sess, d, workId, warmId, dayId, defLimit) {
  if (!sess || !sess.entries || !(d.exercises || {})[warmId]) return;
  const day = (d.days || []).find((x) => x.id === dayId);
  const limit = day?.items.find((it) => it.exId === warmId)?.baseline ?? defLimit;
  const isWarm = (e) => e.exId === warmId || (e.exId === workId && e.warmup);
  const mixed = sess.entries.filter(isWarm);
  if (!mixed.length) return;
  const heavy = [], light = [];
  for (const e of mixed) for (const x of e.sets) ((x.w != null && x.w > limit) || (!x.done && e.exId === workId) ? heavy : light).push(x);
  const idx = sess.entries.indexOf(mixed[0]);
  sess.entries = sess.entries.filter((e) => !isWarm(e));
  let work = sess.entries.find((e) => e.exId === workId);
  if (heavy.length) { if (work) work.sets.push(...heavy); else sess.entries.splice(Math.min(idx, sess.entries.length), 0, (work = { exId: workId, warmup: false, sets: heavy })); }
  if (light.length) sess.entries.splice(Math.min(idx, sess.entries.length), 0, { exId: warmId, warmup: true, sets: light, note: mixed[0].note });
  for (const pr of sess.prs || []) if (pr.exId === warmId) pr.exId = workId;
}

// Lying hamstring curls get a warm-up and a working version, like Fly machine (Nate, 2026-11-28).
// Past hamstring sets are split by weight on load: above the warm-up weight is working, the rest warm-up.
function hamstringBoth(d) {
  const exs = d.exercises || {}, leg = (d.days || []).find((x) => x.id === 'leg');
  if (exs['hamstring-curls']) {
    if (/^Lying hamstring curls/.test(exs['hamstring-curls'].name)) exs['hamstring-curls'].name = 'Lying hamstring curls';
    if (!exs['hamstring-curls-warm-up']) exs['hamstring-curls-warm-up'] = { id: 'hamstring-curls-warm-up', name: 'Lying hamstring curls (warm-up)', type: exs['hamstring-curls'].type, note: '' };
    if (leg) {
      const row = leg.items.find((it) => it.exId === 'hamstring-curls' && it.warmup);
      if (row && !leg.items.some((it) => it.exId === 'hamstring-curls-warm-up')) row.exId = 'hamstring-curls-warm-up';
      for (const it of leg.items) if (it.exId === 'hamstring-curls') it.warmup = false;
      if (!leg.items.some((it) => it.exId === 'hamstring-curls')) {
        const after = leg.items.findIndex((it) => it.exId === 'seated-leg-curls');
        leg.items.splice(after < 0 ? leg.items.length : after, 0, { exId: 'hamstring-curls', baseline: null, warmup: false });
      }
    }
  }
  d.migrations.push('hamstring-both-2026-11-28');
}

// Decline crunch (Nate, 2026-11-28): legs up on a decline bench, crunch to the left, center and right.
// Added to every day's core work, just before Core circuit.
function addDeclineCrunch(d) {
  const exs = d.exercises || {};
  // Reuse one Nate already added by hand ("Decline crunch", "Decline crunches", ...), keeping its logged sets.
  const found = Object.values(exs).find((x) => /^decline crunch(es)?\b/i.test(x.name.trim()));
  const id = found ? found.id : 'decline-crunch';
  if (!found) exs[id] = { id, name: 'Decline crunch', type: 'bw', note: 'Legs up on a decline bench. Crunch to the left, center and right.' };
  for (const day of d.days || []) {
    if (day.items.some((it) => it.exId === id)) continue;
    const at = day.items.findIndex((it) => it.exId === 'core-circuit');
    day.items.splice(at < 0 ? day.items.length : at, 0, { exId: id, baseline: null, warmup: false });
  }
  d.migrations.push('decline-crunch-2026-11-28');
}

// Moves every use of one exercise onto another: day menus, logged sets, PRs and plans.
function mergeExercise(d, from, to) {
  const exs = d.exercises;
  if (!exs[from]) return;
  if (!exs[to]) exs[to] = { ...exs[from], id: to };
  const swap = (list) => { if (!list) return list; const out = []; for (const id of list.map((x) => (x === from ? to : x))) if (!out.includes(id)) out.push(id); return out; };
  for (const day of d.days || []) {
    let kept = false; // keep one row of the merged exercise per day
    day.items = day.items.map((it) => (it.exId === from ? { ...it, exId: to } : it)).filter((it) => it.exId !== to || (!kept && (kept = true)));
  }
  for (const sess of [...(d.sessions || []), ...(d.active ? [d.active] : [])]) {
    for (const e of sess.entries || []) if (e.exId === from) e.exId = to;
    for (const pr of sess.prs || []) if (pr.exId === from) pr.exId = to;
  }
  for (const k of Object.keys(d.plans || {})) d.plans[k] = swap(d.plans[k]);
  delete exs[from];
}

function cleanupA(d) {
  const exs = d.exercises || {}, days = d.days || [];
  const renames = {
    'hamstring-curls': ['Hamstring curls', 'Lying hamstring curls (on belly)'],
    'seated-leg-curls': ['Seated leg curls', 'Seated hamstring curls'],
    'triceps-cable-pulls': ['Triceps cable pulls', 'Triceps cable pulls (both arms)'],
    'cable-tricep-push-down': ['Cable tricep push down', 'Cable tricep push down (both arms)'],
    'bench-leg-lunges': ['Bench leg lunges', 'Bulgarian split squats'],
  };
  for (const [id, [from, to]] of Object.entries(renames)) if (exs[id] && exs[id].name === from) exs[id].name = to;
  const mergeInto = (from, to) => mergeExercise(d, from, to);
  // Fly machine warm-up gets its own exercise, so it no longer shares a row (and a tick) with the working sets.
  const chest = days.find((x) => x.id === 'chest');
  if (exs['fly-machine'] && chest && chest.items.some((it) => it.exId === 'fly-machine' && it.warmup)) {
    exs['fly-machine-warm-up'] = { id: 'fly-machine-warm-up', name: 'Fly machine (warm-up)', type: exs['fly-machine'].type, note: '' };
    const it = chest.items.find((x) => x.exId === 'fly-machine' && x.warmup);
    it.exId = 'fly-machine-warm-up';
  }
  mergeInto('treadmill-incline', 'cardio-warm-up');
  mergeInto('incline-chest-press', 'incline-dumbbell-press');
  // Single-arm triceps cable pulls were a note on the two-arm version; now their own exercise, weight per arm.
  if (exs['triceps-cable-pulls'] && !exs['single-arm-triceps-cable-pulls']) {
    exs['single-arm-triceps-cable-pulls'] = { id: 'single-arm-triceps-cable-pulls', name: 'Single-arm triceps cable pulls', type: 'hand', note: '' };
    if (/single arm/i.test(exs['triceps-cable-pulls'].note || '')) exs['triceps-cable-pulls'].note = '';
    for (const day of days) {
      const i = day.items.findIndex((x) => x.exId === 'triceps-cable-pulls');
      if (i >= 0) day.items.splice(i + 1, 0, { exId: 'single-arm-triceps-cable-pulls', baseline: 40, warmup: false });
    }
  }
  d.migrations.push('cleanup-2026-11-26');
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw); d.userId = d.userId || uid();
      // Rest now starts at 1 minute (Nate, 2026-11-20); move the old 2-minute default over once.
      if (d.settings && !d.settings.rest60) { if (d.settings.restSec === 120) d.settings.restSec = 60; d.settings.rest60 = true; }
      return cleanupExercises(d);
    }
  } catch (e) { console.warn('load failed', e); }
  return cleanupExercises(seedState());
}

let S = load();
let saveFailed = false;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); saveFailed = false; }
  catch (e) { if (!saveFailed) toast('Could not save. Storage may be full: make a backup.'); saveFailed = true; }
}

const ui = {
  tab: 'today', dayId: null, picks: new Set(), view: null, editing: false,
  openHist: null, progEx: null, sheet: null, openDays: new Set(),
};

/* ---------- helpers ---------- */

function today() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmt = (n) => (n == null ? '' : (Math.round(n * 10) / 10).toString());
const fmtDate = (iso, opts = { month: 'short', day: 'numeric' }) => new Date(iso).toLocaleDateString(undefined, opts);
const ex = (id) => S.exercises[id] || { id, name: id, type: 'total' };
const typeOf = (id) => TYPES[ex(id).type] || TYPES.total;
// Full Body: an off-rotation day whose menu is every exercise from every day. Picking it never moves "Up next".
const FULL = 'fullbody';
function fullBodyDay() {
  const seen = new Set(), items = [];
  for (const d of S.days) for (const it of d.items) {
    const i = items.findIndex((x) => x.exId === it.exId);
    if (i < 0) { seen.add(it.exId); items.push({ ...it, group: d.name }); }
    else if (items[i].warmup && !it.warmup) items[i] = { ...it, group: d.name }; // a working lift somewhere wins over a warm-up
  }
  for (const id of [...((S.plans && S.plans[FULL]) || []), ...(ui.picksDay === FULL ? ui.picks : [])]) {
    if (!seen.has(id) && S.exercises[id]) { seen.add(id); items.push({ exId: id, baseline: null, warmup: false, group: 'Other' }); }
  }
  return { id: FULL, name: 'Full Body', items, virtual: true };
}
const dayById = (id) => (id === FULL ? fullBodyDay() : S.days.find((d) => d.id === id));
const e1rm = (w, r) => (r > 0 && w > 0 ? w * (1 + r / 30) : 0);
const finished = () => S.sessions.filter((s) => s.finished);

function repTarget() {
  const st = S.settings;
  if (!st.periodized) return { min: st.repMin, max: st.repMax, label: `${st.repMin}-${st.repMax} reps` };
  const days = Math.floor((new Date(today()) - new Date(st.blockStart)) / 864e5);
  const week = Math.max(0, Math.floor(days / 7)) % 8 + 1;
  const [min, max] = week <= 4 ? [4, 6] : [6, 8];
  return { min, max, week, label: `Week ${week} of 8 · ${min}-${max} reps` };
}

function nextDayId() {
  const last = finished().filter((s) => S.days.some((d) => d.id === s.dayId)).sort((a, b) => b.date.localeCompare(a.date) || b.start - a.start)[0];
  if (!last) return S.days[0]?.id;
  const i = S.days.findIndex((d) => d.id === last.dayId);
  return S.days[(i + 1) % S.days.length]?.id;
}

// Most recent finished entry for an exercise, optionally skipping one session.
function lastEntry(exId, skipId) {
  const ss = finished().filter((s) => s.id !== skipId).sort((a, b) => b.date.localeCompare(a.date) || b.start - a.start);
  for (const s of ss) {
    const e = s.entries.find((e) => e.exId === exId && e.sets.some((x) => x.done));
    if (e) return { session: s, entry: e };
  }
  return null;
}

const doneSets = (e) => e.sets.filter((x) => x.done);

function topSet(e) {
  const t = typeOf(e.exId);
  const sets = doneSets(e).filter((x) => (t.w ? x.w != null : true) && (t.r ? num(x.r) > 0 : true));
  if (!sets.length) return null;
  if (t.lowerBetter) return sets.reduce((a, b) => (b.w < a.w || (b.w === a.w && b.r > a.r) ? b : a));
  if (t.weighted || ex(e.exId).type === 'bw') return sets.reduce((a, b) => (b.w > a.w || (b.w === a.w && b.r > a.r) ? b : a));
  return sets.reduce((a, b) => (num(b.r) > num(a.r) ? b : a));
}

const describeSet = (exId, x) => {
  const t = typeOf(exId), type = ex(exId).type;
  if (type === 'circuit') return 'done';
  if (type === 'timed') return `${fmt(x.r)}s`;
  if (type === 'cardio') return [x.w != null ? `${fmt(x.w)} min` : '', x.r ? `${fmt(x.r)} mi` : ''].filter(Boolean).join(', ');
  if (type === 'bw') return (x.w ? `+${fmt(x.w)}×` : '') + `${fmt(x.r)}`;
  return `${fmt(x.w)}×${fmt(x.r) || '?'}`;
};

function plates(w) {
  let side = (w - 45) / 2;
  if (!(side > 0)) return w === 45 ? 'Empty bar' : '';
  const out = [];
  for (const p of [45, 35, 25, 10, 5, 2.5]) while (side >= p - 1e-9) { out.push(p); side -= p; }
  return `Bar + ${out.join(', ')} per side` + (side > 0.01 ? ` (+${fmt(side)})` : '');
}

// "140×8, 140×8, 140×8" -> "140×8 ×3"
function describeSets(exId, sets) {
  const parts = [];
  for (const x of sets) {
    const t = describeSet(exId, x), last = parts[parts.length - 1];
    if (last && last.t === t) last.n++; else parts.push({ t, n: 1 });
  }
  return parts.map((q) => (q.n > 1 ? `${q.t} ×${q.n}` : q.t)).join(', ');
}

/* ---------- personal records ---------- */

// Bests for one exercise across a list of {w, r} sets.
function bestsOf(exId, sets) {
  const type = ex(exId).type, t = TYPES[type] || TYPES.total;
  const b = {};
  for (const x of sets) {
    const w = num(x.w), r = num(x.r);
    if (t.weighted && w != null && r > 0) {
      if (b.weight == null || w > b.weight) b.weight = w;
      const e = e1rm(w, r);
      if (b.e1rm == null || e > b.e1rm) b.e1rm = e;
    }
    if (type === 'assisted' && w != null && r > 0 && (b.assist == null || w < b.assist)) b.assist = w;
    if ((type === 'bw' || type === 'assisted') && r > 0 && (b.reps == null || r > b.reps)) b.reps = r;
    if (type === 'timed' && r > 0 && (b.time == null || r > b.time)) b.time = r;
    if (type === 'cardio' && r > 0 && (b.miles == null || r > b.miles)) b.miles = r;
  }
  return b;
}

const PR_LABELS = {
  weight: (v) => `Heaviest: ${fmt(v)} lbs`,
  e1rm: (v) => `Best est. 1RM: ${Math.round(v)} lbs`,
  assist: (v) => `Least assistance: ${fmt(v)} lbs`,
  reps: (v) => `Most reps: ${fmt(v)}`,
  time: (v) => `Longest hold: ${fmt(v)}s`,
  miles: (v) => `Longest distance: ${fmt(v)} mi`,
};
const lowerIsBetter = (k) => k === 'assist';

function historySets(exId, skipId) {
  const out = [];
  for (const s of finished()) if (s.id !== skipId) for (const e of s.entries) if (e.exId === exId) out.push(...doneSets(e));
  return out;
}

// Which bests does `candidate` beat, compared with `prior` sets? Only counts if there is history to beat.
function newPRs(exId, prior, candidate) {
  const before = bestsOf(exId, prior), after = bestsOf(exId, [...prior, ...candidate]);
  const out = [];
  for (const k of Object.keys(after)) {
    if (before[k] == null) continue;
    const better = lowerIsBetter(k) ? after[k] < before[k] : after[k] > before[k] + 1e-9;
    if (better) out.push(PR_LABELS[k](after[k]));
  }
  return out;
}

/* ---------- workout flow ---------- */

function defaultSetCount(item, exId) {
  const type = ex(exId).type;
  if (type === 'cardio') return 1;
  if (item?.warmup) return 2;
  if (type === 'circuit' || type === 'timed' || type === 'bw') return 3;
  return S.settings.defaultSets;
}

function makeEntry(exId, dayId) {
  const item = dayById(dayId)?.items.find((i) => i.exId === exId);
  const last = lastEntry(exId);
  let sets;
  if (last) {
    sets = last.entry.sets.map((x) => ({ w: x.w, r: x.r, done: false }));
  } else {
    const n = defaultSetCount(item, exId);
    const w = typeOf(exId).w ? item?.baseline ?? null : null;
    sets = Array.from({ length: n }, () => ({ w, r: null, done: false }));
  }
  return { exId, warmup: !!item?.warmup, sets };
}

// Plans: the exercises picked for a day are saved, so a workout can be planned ahead.
function picksFor(dayId) { return new Set((S.plans && S.plans[dayId]) || []); }
function savePicks() {
  S.plans = S.plans || {};
  if (ui.picks.size) S.plans[ui.dayId] = [...ui.picks]; else delete S.plans[ui.dayId];
  save();
}

// Workout time excludes paused stretches.
function elapsed(s) {
  const until = s.pausedAt || s.end || Date.now();
  return Math.max(0, until - s.start - (s.pausedMs || 0));
}
function timerText(s) { return (s.pausedAt ? 'Paused · ' : '') + fmtClock(elapsed(s)); }
function pauseWorkout(s) { if (s && !s.pausedAt) { s.pausedAt = Date.now(); stopRest(); } }
function resumeWorkout(s) { if (s && s.pausedAt) { s.pausedMs = (s.pausedMs || 0) + (Date.now() - s.pausedAt); s.pausedAt = null; } }

function startWorkout() {
  const day = dayById(ui.dayId);
  const order = day.items.map((i) => i.exId);
  const picked = [...ui.picks].sort((a, b) => {
    const wa = day.items.find((i) => i.exId === a)?.warmup ? 0 : 1, wb = day.items.find((i) => i.exId === b)?.warmup ? 0 : 1;
    return wa - wb || order.indexOf(a) - order.indexOf(b);
  });
  S.active = { id: uid(), dayId: day.id, date: today(), start: Date.now(), entries: picked.map((id) => makeEntry(id, day.id)), finished: false };
  ui.picks.clear();
  if (S.plans) delete S.plans[day.id];
  ui.view = 'workout'; ui.editing = false;
  save(); render(); scrollTo(0, 0);
}

function current() { return ui.editing ? S.sessions.find((s) => s.id === ui.editing) : S.active; }

function finishWorkout() {
  const s = current();
  if (!s) return;
  splitFly(s);
  const prs = [];
  for (const e of s.entries) {
    const got = newPRs(e.exId, historySets(e.exId, s.id), doneSets(e));
    if (got.length) prs.push({ exId: e.exId, items: got });
  }
  s.prs = prs;
  resumeWorkout(s);
  s.finished = true;
  s.updatedAt = Date.now();
  if (!ui.editing) {
    s.end = Date.now();
    s.entries = s.entries.filter((e) => e.sets.length);
    S.sessions.push(s);
    S.active = null;
  }
  const wasEditing = ui.editing;
  ui.view = null; ui.editing = false; stopRest();
  save();
  if (wasEditing) { ui.tab = 'history'; render(); toast('Saved'); return; }
  ui.sheet = { kind: 'summary', id: s.id };
  ui.tab = 'today'; ui.dayId = nextDayId();
  render();
}

/* ---------- rest timer ---------- */

let rest = null, restTick = null, audioCtx = null;
function startRest() {
  const sec = S.settings.restSec;
  if (!sec) return;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) {}
  rest = { end: Date.now() + sec * 1000, total: sec };
  clearInterval(restTick);
  restTick = setInterval(updateRest, 250);
  updateRest();
}
function stopRest() { rest = null; clearInterval(restTick); const el = document.getElementById('rest'); if (el) el.hidden = true; }
function beep() {
  if (!audioCtx) return;
  try {
    [0, 0.25].forEach((t) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.15;
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.15);
    });
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function updateRest() {
  const el = document.getElementById('rest');
  if (!el) return;
  if (!rest || ui.view !== 'workout') { el.hidden = true; return; }
  const left = Math.ceil((rest.end - Date.now()) / 1000);
  el.hidden = false;
  if (left <= 0) { beep(); haptic(); stopRest(); toast('Rest is over. Next set.'); return; }
  el.querySelector('.rest-time').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el.querySelector('.ring-fg').style.strokeDasharray = `${Math.max(0, ((rest.end - Date.now()) / 1000 / (rest.total || S.settings.restSec)) * 100)} 100`;
}

/* ---------- rendering ---------- */

const $main = () => document.getElementById('main');

// SF Symbols-style line icons (drawn inline so the app works offline).
const svg = (d, cls = '', extra = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const I = {
  check: svg('<path d="M5.5 12.5l4.2 4.2L18.5 7.8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  chev: svg('<path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>', 'chev'),
  more: svg('<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="7.8" cy="12" r="1.35" fill="currentColor"/><circle cx="12" cy="12" r="1.35" fill="currentColor"/><circle cx="16.2" cy="12" r="1.35" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  minus: svg('<path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  star: svg('<path d="M12 3.2l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.8l-5.4 3 1.2-6.1-4.5-4.2 6.1-.7z" fill="currentColor"/>'),
  note: svg('<path d="M14.5 4.5l5 5L9 20H4v-5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>'),
  bolt: svg('<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  timer: svg('<circle cx="12" cy="13.5" r="7.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 9.5v4l2.5 1.5M9.5 3h5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  share: svg('<path d="M12 3.5v11M8 7.5l4-4 4 4M7 11H5.5v9.5h13V11H17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  trash: svg('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  done: svg('<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/>'),
  play: svg('<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" fill="currentColor"/>'),
  plate: svg('<rect x="2.5" y="10.8" width="19" height="2.4" rx="1.2" fill="currentColor"/><rect x="5" y="6.5" width="3" height="11" rx="1.2" fill="currentColor"/><rect x="16" y="6.5" width="3" height="11" rx="1.2" fill="currentColor"/>'),
};

const dayTitle = (d) => `${esc(d?.name || 'Workout')} Day`;
const largeTitle = (title, sub = '', eyebrow = '') =>
  `<header class="large-title">${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1>${title}</h1>${sub ? `<p class="subhead">${sub}</p>` : ''}</header>`;
const groupH = (txt, trail = '') => `<h2 class="group-h"><span>${txt}</span>${trail ? `<span class="group-h-trail">${trail}</span>` : ''}</h2>`;
const groupF = (txt) => `<p class="group-f">${txt}</p>`;
const typeOptions = (sel) => Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.label}</option>`).join('');
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(x).padStart(2, '0'); };

let navKind = null;
// Runs a navigation with an iOS-style push / pop / fade transition where the browser supports it.
function nav(kind, fn) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce) { fn(); return; }
  document.documentElement.dataset.nav = kind;
  const t = document.startViewTransition(() => { fn(); });
  t.finished.finally(() => { delete document.documentElement.dataset.nav; });
}

function render() {
  const inWorkout = ui.view === 'workout' && current();
  if (!inWorkout) ui.view = null;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  document.body.classList.toggle('in-workout', !!inWorkout);
  const html = inWorkout ? renderWorkout() : { today: renderToday, history: renderHistory, progress: renderProgress, program: renderProgram }[ui.tab]();
  $main().innerHTML = html;
  if (!inWorkout && ui.tab === 'progress') drawChart();
  // compact nav bar title, shown once the large title scrolls away
  document.getElementById('nav-title').textContent = inWorkout ? '' : ($main().querySelector('.large-title h1')?.textContent || '');
  onScroll();
  // "workout in progress" bar above the tab bar, like Music's mini player
  const mini = document.getElementById('mini');
  if (S.active && !inWorkout) {
    mini.hidden = false;
    mini.querySelector('.mini-name').textContent = `${dayById(S.active.dayId)?.name || ''} Day`;
    const n = S.active.entries.reduce((k, e) => k + doneSets(e).length, 0);
    mini.querySelector('.mini-sub').textContent = `${n} set${n === 1 ? '' : 's'} done · ${timerText(S.active)}`;
  } else mini.hidden = true;
  document.body.classList.toggle('has-mini', !!(S.active && !inWorkout));
  renderSheet();
  updateRest();
}

function onScroll() {
  document.body.classList.toggle('scrolled', scrollY > 44);
}

function renderToday() {
  if (!ui.dayId || !dayById(ui.dayId)) ui.dayId = nextDayId();
  const day = dayById(ui.dayId);
  if (ui.picksDay !== day.id) { ui.picks = picksFor(day.id); ui.picksDay = day.id; }
  const target = repTarget();
  const counts = {};
  for (const s of finished()) if (s.dayId === day.id) for (const e of s.entries) counts[e.exId] = (counts[e.exId] || 0) + 1;
  const order = (items) => items.map((it, i) => ({ it, i })).sort((a, b) => (counts[b.it.exId] || 0) - (counts[a.it.exId] || 0) || a.i - b.i).map((x) => x.it);
  const row = (it) => {
    const e = ex(it.exId), last = lastEntry(it.exId), top = last && topSet(last.entry);
    const sub = last ? `${top ? describeSet(it.exId, top) : 'Done'} · ${fmtDate(last.session.date)}`
      : it.baseline != null && typeOf(it.exId).w ? `Start near ${fmt(it.baseline)} ${typeOf(it.exId).w}` : e.note || TYPES[e.type].label;
    const on = ui.picks.has(it.exId);
    return `<button class="row pick ${on ? 'on' : ''}" data-act="pick" data-id="${esc(it.exId)}" aria-pressed="${on}">
      <span class="check">${on ? I.check : ''}</span>
      <span class="row-text"><span class="row-title">${esc(e.name)}</span><span class="row-sub">${esc(sub)}</span></span>
      ${counts[it.exId] ? `<span class="row-trail">${counts[it.exId]}×</span>` : ''}
    </button>`;
  };
  const warm = day.items.filter((i) => i.warmup), all = day.items.filter((i) => !i.warmup);
  // Most Selected: picked in at least a quarter of this day's workouts, and more than once after
  // the first workout (max 8), most picked first. Everything else is Least Selected.
  const nDay = finished().filter((s) => s.dayId === day.id).length;
  const bar = nDay < 2 ? 1 : Math.max(2, Math.ceil(nDay / 4));
  const fav = order(all.filter((it) => (counts[it.exId] || 0) >= bar)).slice(0, 8);
  const favIds = new Set(fav.map((it) => it.exId));
  const rest = order(all.filter((it) => !favIds.has(it.exId)));
  const nWork = [...ui.picks].filter((id) => !day.items.find((i) => i.exId === id)?.warmup).length;
  const names = new Set(Object.values(S.exercises).filter((x) => day.items.some((i) => i.exId === x.id)).map((x) => x.name.toLowerCase()));
  const ideas = (window.SUGGESTIONS?.[day.id] || []).filter(([n]) => !names.has(n.toLowerCase()));
  const eyebrow = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const sub = `${day.virtual ? 'Off rotation · ' : day.id === nextDayId() ? 'Up next in your rotation · ' : ''}${S.settings.periodized ? target.label : `${S.settings.defaultSets} sets × ${target.label}`}`;
  const n = ui.picks.size;
  return `${largeTitle(dayTitle(day), sub, eyebrow)}
    <div class="seg ${S.days.length > 5 ? 'scroll' : ''}" role="tablist">${S.days.map((d) => `<button role="tab" class="seg-btn ${d.id === day.id ? 'on' : ''}" aria-selected="${d.id === day.id}" data-act="day" data-id="${esc(d.id)}">${esc(d.name)}${S.plans?.[d.id]?.length && d.id !== day.id ? '<i class="seg-dot" aria-label="planned"></i>' : ''}</button>`).join('')}</div>
    <button class="fb-pill ${day.virtual ? 'on' : ''}" data-act="day" data-id="${day.virtual ? esc(nextDayId()) : FULL}" aria-pressed="${!!day.virtual}">${I.bolt}<span>${day.virtual ? 'Back to your rotation' : 'Full Body Day'}</span>${S.plans?.[FULL]?.length && !day.virtual ? '<i class="seg-dot" aria-label="planned"></i>' : ''}</button>
    ${warm.length ? `${groupH('Warm-up')}<div class="group">${warm.map(row).join('')}</div>` : ''}
    ${fav.length ? `${groupH('Most Selected', `${nWork} of 5–7`)}<div class="group">${fav.map(row).join('')}</div>` : ''}
    ${day.virtual
    ? [...S.days.map((d) => d.name), 'Other'].filter((g, i, gs) => gs.indexOf(g) === i && rest.some((it) => it.group === g)).map((g, gi) => `${groupH(esc(g), gi || fav.length ? '' : `${nWork} of 5–7`)}<div class="group">${rest.filter((it) => it.group === g).map(row).join('')}</div>`).join('')
    : rest.length ? `${groupH(fav.length ? 'Least Selected' : 'Exercises', fav.length ? '' : `${nWork} of 5–7`)}<div class="group">${rest.map(row).join('')}</div>` : ''}
    ${groupF(n ? `<span class="plan-saved">${I.check}Plan saved.</span> It stays here until you start this workout.` : 'Pick exercises now to plan ahead. Your plan is saved for this day.')}
    ${groupH('New Exercise')}
    <form class="group form-row" data-form="today-new">
      <input name="name" list="ex-names" placeholder="Name" required autocomplete="off">
      <select name="type" aria-label="Type">${typeOptions('total')}</select>
      <button class="add-btn" aria-label="Add">${I.plus}</button>
    </form>
    <datalist id="ex-names">${Object.values(S.exercises).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
    ${ideas.length ? `${groupH('Suggestions')}<div class="capsules">${ideas.map(([nm, t]) => `<button class="capsule" data-act="add-idea" data-name="${esc(nm)}" data-type="${t}">${I.plus}${esc(nm)}</button>`).join('')}</div>${groupF(`Tap one to add it to ${esc(day.name)} Day.`)}` : ''}
    <div class="cta-bar">${n ? '<button class="btn-plain" data-act="clear-plan">Clear</button>' : ''}<button class="btn-filled" data-act="start" ${n ? '' : 'disabled'}>${n ? `Start Workout <span class="btn-count">${n}</span>` : 'Select Exercises'}</button></div>`;
}

function progressionHint(e) {
  const t = typeOf(e.exId);
  if (!(t.weighted || t.lowerBetter) || e.warmup) return '';
  const last = lastEntry(e.exId, current()?.id);
  if (!last) return '';
  const sets = doneSets(last.entry);
  const { max } = repTarget();
  if (sets.length < 3 || !sets.every((x) => num(x.r) >= max && x.w != null)) return '';
  const w = Math.max(...sets.map((x) => x.w));
  const next = t.lowerBetter ? Math.max(0, Math.min(...sets.map((x) => x.w)) - t.step) : w + t.step;
  if (e.sets.some((x) => x.done)) return '';
  if (e.sets.every((x) => x.w === next)) return '';
  return `<button class="hint" data-act="apply-hint" data-w="${next}"><span class="hint-icon">${I.bolt}</span><span><b>Ready to go up</b><br>You hit ${max} on every set. Try ${fmt(next)} ${t.w}.</span><span class="hint-go">Apply</span></button>`;
}

// Percent of planned sets ticked off in this workout.
function pctDone(s) {
  const total = s.entries.reduce((n, e) => n + e.sets.length, 0);
  return total ? Math.round((s.entries.reduce((n, e) => n + doneSets(e).length, 0) / total) * 100) : 0;
}
function progressBlock(s) {
  const total = s.entries.reduce((n, e) => n + e.sets.length, 0), done = s.entries.reduce((n, e) => n + doneSets(e).length, 0);
  const exDone = s.entries.filter((e) => e.sets.length && e.sets.every((x) => x.done)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="work-prog ${pct === 100 ? 'full' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
    <div class="wp-top"><span class="wp-pct">${pct}%<small> complete</small></span><span class="wp-sub">${done} of ${total} sets · ${exDone} of ${s.entries.length} exercises</span></div>
    <div class="wp-track"><div class="wp-fill" style="width:${pct}%"></div></div>
  </div>`;
}

function renderWorkout() {
  const s = current(), day = dayById(s.dayId);
  const target = repTarget();
  const cards = s.entries.map((e, ei) => {
    const x = ex(e.exId), t = TYPES[x.type] || TYPES.total;
    const last = lastEntry(e.exId, s.id);
    const best = bestsOf(e.exId, historySets(e.exId, s.id));
    const nextW = (e.sets.find((y) => !y.done) || e.sets[e.sets.length - 1] || {}).w;
    const plateTxt = window.BARBELL?.includes(e.exId) && nextW ? esc(plates(nextW)) : '';
    const bestTxt = Object.keys(best).filter((k) => k !== 'e1rm').map((k) => PR_LABELS[k](best[k])).join(' · ');
    const nDone = doneSets(e).length;
    const rows = e.sets.map((st, si) => {
      const wCell = t.w ? `<div class="stepper">
          <button class="step" data-act="step" data-e="${ei}" data-s="${si}" data-d="-1" aria-label="Less">${I.minus}</button>
          <input class="num" inputmode="decimal" data-f="w" data-e="${ei}" data-s="${si}" value="${fmt(st.w)}" placeholder="–" aria-label="${t.w}">
          <button class="step" data-act="step" data-e="${ei}" data-s="${si}" data-d="1" aria-label="More">${I.plus}</button></div>` : '';
      const rCell = t.r ? `<input class="num reps" inputmode="${x.type === 'cardio' ? 'decimal' : 'numeric'}" data-f="r" data-e="${ei}" data-s="${si}" value="${fmt(st.r)}" placeholder="${t.r === 'reps' ? (e.warmup ? '–' : `${target.min}–${target.max}`) : '–'}" aria-label="${t.r}">` : '';
      const label = x.type === 'circuit' ? `<span class="round">Round ${si + 1}</span>` : '';
      return `<div class="set-row ${st.done ? 'done' : ''} ${t.w ? '' : t.r ? 'no-w' : 'no-wr'}"><span class="set-n">${si + 1}</span>${label}${wCell}${rCell}
        <button class="tick ${st.done ? 'on' : ''}" data-act="tick" data-e="${ei}" data-s="${si}" aria-label="Set ${si + 1} done" aria-pressed="${st.done}">${I.check}</button></div>`;
    }).join('');
    const head = t.w || t.r ? `<div class="set-head ${t.w ? '' : t.r ? 'no-w' : 'no-wr'}"><span>Set</span>${t.w ? `<span>${esc(t.w)}</span>` : ''}${t.r ? `<span>${esc(t.r)}</span>` : ''}<span></span></div>` : '';
    return `<section class="ex-card" data-card="${ei}">
      <div class="ex-head">
        <div class="ex-titles">
          <h3>${esc(x.name)}${e.warmup ? '<span class="tag">Warm-up</span>' : ''}</h3>
          <p class="ex-sub">${last ? `Last time · ${fmtDate(last.session.date)}<br><span class="ex-last">${describeSets(e.exId, doneSets(last.entry))}</span>` : esc(x.note || t.label)}</p>
        </div>
        <span class="ex-count ${nDone && nDone >= e.sets.length ? 'full' : ''}">${nDone}/${e.sets.length}</span>
        <button class="icon-btn" data-act="card-menu" data-e="${ei}" aria-label="More options for ${esc(x.name)}">${I.more}</button>
      </div>
      ${bestTxt || last?.entry.note ? `<div class="meta">${bestTxt ? `<span class="meta-pr">${I.star}${esc(bestTxt)}</span>` : ''}${last?.entry.note ? `<span class="meta-note">${I.note}${esc(last.entry.note)}</span>` : ''}</div>` : ''}
      ${progressionHint(e)}
      <div class="sets">${head}${rows}</div>
      ${plateTxt ? `<p class="plates">${I.plate}${plateTxt}</p>` : ''}
      <div class="ex-foot">
        <input class="note" data-nf="${ei}" value="${esc(e.note || '')}" placeholder="Add a note for next time">
        <div class="ex-actions"><button class="text-btn" data-act="add-set" data-e="${ei}">${I.plus}Add Set</button><button class="text-btn quiet" data-act="del-set" data-e="${ei}" ${e.sets.length ? '' : 'disabled'}>Remove Set</button></div>
      </div>
    </section>`;
  }).join('');
  return `<header class="work-nav">
      <button class="nav-text ${ui.editing ? '' : 'danger'}" data-act="${ui.editing ? 'cancel-edit' : 'discard'}">${ui.editing ? 'Cancel' : 'Discard'}</button>
      <div class="work-title"><span class="wt-name">${dayTitle(day)}</span><span class="wt-sub"><span class="wt-time" id="work-timer">${ui.editing ? fmtDate(s.date, { weekday: 'short', month: 'short', day: 'numeric' }) : timerText(s)}</span> · <span class="wt-pct">${pctDone(s)}%</span></span></div>
      <button class="nav-text bold" data-act="finish">${ui.editing ? 'Save' : 'Finish'}</button>
      <span class="wn-bar ${pctDone(s) === 100 ? 'full' : ''}" style="width:${pctDone(s)}%"></span>
    </header>
    ${progressBlock(s)}
    <div class="work-bar"><span class="work-goal">Goal: ${S.settings.periodized ? target.label : `${S.settings.defaultSets} sets × ${target.label}`}</span>
      ${ui.editing ? '' : `<button class="pause-btn ${s.pausedAt ? 'on' : ''}" data-act="${s.pausedAt ? 'unpause' : 'pause'}">${s.pausedAt ? `${I.play}Resume` : `${I.pause}Pause`}</button>`}</div>
    ${ui.editing ? '' : `<div class="rest-set"><span class="rest-set-label">${I.timer}Rest between sets</span><span class="rest-step"><button data-act="rest-len" data-dir="-1" aria-label="Shorter rest" ${S.settings.restSec <= 30 ? 'disabled' : ''}>−</button><b id="rest-len">${fmtClock(S.settings.restSec * 1000)}</b><button data-act="rest-len" data-dir="1" aria-label="Longer rest" ${S.settings.restSec >= 600 ? 'disabled' : ''}>+</button></span></div>`}
    ${s.pausedAt ? `<button class="paused-card" data-act="unpause"><span class="paused-icon">${I.pause}</span><span class="row-text"><b>Workout Paused</b><span>The timer is stopped. Tap to resume, or tick a set and it resumes on its own.</span></span></button>` : ''}
    <div class="${s.pausedAt ? 'cards-paused' : ''}">${cards || '<p class="empty">No exercises yet.</p>'}</div>
    <button class="btn-tinted" data-act="add-ex">${I.plus}Add Exercise</button>`;
}

function renderHistory() {
  const ss = finished().sort((a, b) => b.date.localeCompare(a.date) || b.start - a.start);
  if (!ss.length) return `${largeTitle('History')}<div class="empty-state"><div class="empty-icon">${I.note}</div><h3>No Workouts Yet</h3><p>Finished workouts show up here, so you can see what you lifted last time.</p></div>`;
  const byMonth = [];
  for (const s of ss) {
    const m = fmtDate(s.date, { month: 'long', year: 'numeric' });
    if (!byMonth.length || byMonth[byMonth.length - 1].m !== m) byMonth.push({ m, list: [] });
    byMonth[byMonth.length - 1].list.push(s);
  }
  const row = (s) => {
    const open = ui.openHist === s.id;
    const nSets = s.entries.reduce((n, e) => n + doneSets(e).length, 0);
    const nPr = (s.prs || []).reduce((n, p) => n + p.items.length, 0);
    const dt = new Date(s.date + 'T12:00');
    return `<div class="hist ${open ? 'open' : ''}">
      <button class="row hist-row" data-act="hist" data-id="${s.id}" aria-expanded="${open}">
        <span class="cal"><span class="cal-wd">${dt.toLocaleDateString(undefined, { weekday: 'short' })}</span><span class="cal-d">${dt.getDate()}</span></span>
        <span class="row-text"><span class="row-title">${esc(dayById(s.dayId)?.name || s.dayId)} Day</span><span class="row-sub">${s.entries.length} exercise${s.entries.length === 1 ? '' : 's'} · ${nSets} set${nSets === 1 ? '' : 's'}${s.end ? ` · ${Math.round(elapsed(s) / 6e4)} min` : ''}</span></span>
        ${nPr ? `<span class="pr-pill">${I.star}${nPr}</span>` : ''}
        ${I.chev}
      </button>
      ${open ? `<div class="hist-body">
        ${s.entries.map((e) => `<div class="hist-ex"><span class="hist-name">${esc(ex(e.exId).name)}</span><span class="hist-sets">${describeSets(e.exId, doneSets(e)) || 'No sets done'}</span>${e.note ? `<span class="hist-note">${I.note}${esc(e.note)}</span>` : ''}</div>`).join('')}
        ${(s.prs || []).map((p) => `<div class="hist-pr">${I.star}<span><b>${esc(ex(p.exId).name)}</b> ${p.items.map(esc).join(', ')}</span></div>`).join('')}
        <div class="hist-actions"><button class="text-btn" data-act="edit-session" data-id="${s.id}">Edit</button><button class="text-btn" data-act="share-card" data-id="${s.id}">${I.share}Share</button><button class="text-btn danger" data-act="del-session" data-id="${s.id}">${I.trash}Delete</button></div>
      </div>` : ''}
    </div>`;
  };
  return `${largeTitle('History', `${ss.length} workout${ss.length > 1 ? 's' : ''} logged`)}
    ${byMonth.map((g) => `${groupH(g.m)}<div class="group">${g.list.map(row).join('')}</div>`).join('')}`;
}

function chartPoints(exId) {
  const type = ex(exId).type, t = TYPES[type] || TYPES.total;
  const pts = [];
  for (const s of finished().sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)) {
    const sets = s.entries.filter((e) => e.exId === exId).flatMap(doneSets);
    if (!sets.length) continue;
    const b = bestsOf(exId, sets);
    const top = topSet({ exId, sets });
    if (t.weighted && b.weight != null) pts.push({ date: s.date, a: b.weight, b: b.e1rm, note: top ? describeSet(exId, top) : '' });
    else if (type === 'assisted' && b.assist != null) pts.push({ date: s.date, a: b.assist, note: top ? describeSet(exId, top) : '' });
    else if (type === 'bw' && b.reps != null) pts.push({ date: s.date, a: b.reps });
    else if (type === 'timed' && b.time != null) pts.push({ date: s.date, a: b.time });
    else if (type === 'cardio' && b.miles != null) pts.push({ date: s.date, a: b.miles });
  }
  const label = t.weighted ? ['Top Set', 'Est. 1RM'] : type === 'assisted' ? ['Assistance (lower is better)'] : type === 'timed' ? ['Longest Hold'] : type === 'cardio' ? ['Distance'] : ['Most Reps'];
  const unit = t.weighted || type === 'assisted' ? 'lbs' : type === 'timed' ? 'sec' : type === 'cardio' ? 'mi' : 'reps';
  return { pts, label, unit };
}

function renderProgress() {
  const all = finished();
  const now = new Date(today());
  const within = (d) => all.filter((s) => (now - new Date(s.date)) / 864e5 < d).length;
  const logged = new Set(all.flatMap((s) => s.entries.filter((e) => doneSets(e).length).map((e) => e.exId)));
  const loggedList = [...logged].filter((id) => ex(id).type !== 'circuit').sort((a, b) => ex(a).name.localeCompare(ex(b).name));
  if (!ui.progEx || !logged.has(ui.progEx)) ui.progEx = loggedList[0] || null;
  const prCount = all.reduce((n, s) => n + (s.prs || []).reduce((m, p) => m + p.items.length, 0), 0);
  const tiles = `<div class="tiles">
    <div class="tile"><span class="tile-k">This Week</span><span class="tile-n">${within(7)}</span><span class="tile-u">workouts</span></div>
    <div class="tile"><span class="tile-k">30 Days</span><span class="tile-n">${within(30)}</span><span class="tile-u">workouts</span></div>
    <div class="tile pr"><span class="tile-k">PRs</span><span class="tile-n">${prCount}</span><span class="tile-u">all time</span></div>
  </div>`;
  if (!ui.progEx) return `${largeTitle('Progress')}${tiles}<div class="empty-state"><div class="empty-icon">${I.bolt}</div><h3>No Data Yet</h3><p>Log a workout and your charts and personal records appear here.</p></div>`;
  const id = ui.progEx, b = bestsOf(id, historySets(id));
  const { pts, label, unit } = chartPoints(id);
  const latest = pts[pts.length - 1], first = pts[0];
  const delta = pts.length > 1 ? latest.a - first.a : 0;
  const recent = all.filter((s) => s.entries.some((e) => e.exId === id && doneSets(e).length)).sort((a, c) => c.date.localeCompare(a.date)).slice(0, 8);
  return `${largeTitle('Progress')}${tiles}
    <div class="group"><label class="row select-row"><span class="row-title">Exercise</span>
      <select data-act="prog-ex">${loggedList.map((x) => `<option value="${esc(x)}" ${x === id ? 'selected' : ''}>${esc(ex(x).name)}</option>`).join('')}</select>${I.chev}</label></div>
    <section class="chart-card">
      <p class="chart-k">${esc(label[0])}</p>
      <p class="chart-big">${latest ? fmt(latest.a) : '–'}<span> ${unit}</span></p>
      ${pts.length > 1 && delta ? `<p class="chart-delta ${(delta > 0) !== (ex(id).type === 'assisted') ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${fmt(delta)} ${unit} since ${fmtDate(first.date)}</p>` : '<p class="chart-delta">&nbsp;</p>'}
      <div id="chart" class="chart"></div>
      ${label.length > 1 ? `<div class="legend">${label.map((l, i) => `<span><i class="sw s${i + 1}"></i>${esc(l)}</span>`).join('')}</div>` : ''}
    </section>
    ${groupH('Personal Records')}
    <div class="group">${Object.keys(b).length ? Object.keys(b).map((k) => { const [l, v] = PR_LABELS[k](b[k]).split(': '); return `<div class="row static"><span class="pr-ico">${I.star}</span><span class="row-title">${esc(l)}</span><span class="row-value">${esc(v)}</span></div>`; }).join('') : '<div class="row static"><span class="row-sub">No records yet</span></div>'}</div>
    ${groupH('Recent Sessions')}
    <div class="group">${recent.map((s) => `<div class="row static"><span class="row-date">${fmtDate(s.date)}</span><span class="row-value wrap">${describeSets(id, s.entries.filter((e) => e.exId === id).flatMap(doneSets))}</span></div>`).join('')}</div>`;
}

function drawChart() {
  const host = document.getElementById('chart');
  if (!host || !ui.progEx) return;
  const { pts, label, unit } = chartPoints(ui.progEx);
  if (pts.length < 2) { host.innerHTML = `<p class="chart-empty">${pts.length ? `One session so far. The chart fills in after your next one.` : 'No data yet.'}</p>`; return; }
  const W = host.clientWidth || 340, H = 190, m = { l: 4, r: 36, t: 10, b: 24 };
  const vals = pts.flatMap((p) => [p.a, p.b].filter((v) => v != null));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || Math.max(1, hi * 0.1);
  lo = Math.max(0, lo - pad); hi = hi + pad;
  const tickStep = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / tickStep) * tickStep; hi = Math.ceil(hi / tickStep) * tickStep;
  const x = (i) => m.l + (i * (W - m.l - m.r)) / (pts.length - 1);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += tickStep) grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - m.r + 6}" y="${y(v) + 4}" class="axis">${fmt(v)}</text>`;
  const xl = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${fmtDate(pts[i].date)}</text>`).join('');
  const path = (k) => pts.map((d, i) => (d[k] == null ? null : `${x(i)},${y(d[k])}`)).filter(Boolean);
  const pa = path('a'), pb = path('b');
  const area = `<polygon points="${x(0)},${H - m.b} ${pa.join(' ')} ${x(pts.length - 1)},${H - m.b}" class="area"/>`;
  const last = pts.length - 1;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label.join(' and '))} over time, in ${unit}">
    <defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="ga0"/><stop offset="1" class="ga1"/></linearGradient></defs>
    ${grid}${xl}${area}
    ${pb.length ? `<polyline points="${pb.join(' ')}" class="line s2"/>` : ''}
    <polyline points="${pa.join(' ')}" class="line s1"/>
    <circle cx="${x(last)}" cy="${y(pts[last].a)}" r="5" class="dot s1"/>
    <line class="cross" y1="${m.t}" y2="${H - m.b}" x1="0" x2="0" visibility="hidden"/>
    <circle class="hover-dot" r="5" cx="0" cy="0" visibility="hidden"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/></svg>
    <div class="tip" hidden></div>`;
  const el = host.querySelector('svg'), tip = host.querySelector('.tip'), cross = host.querySelector('.cross'), hd = host.querySelector('.hover-dot');
  const move = (ev) => {
    const r = el.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(last, Math.round(((px - m.l) / (W - m.l - m.r)) * last)));
    const d = pts[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    hd.setAttribute('cx', x(i)); hd.setAttribute('cy', y(d.a)); hd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<span class="tip-d">${fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span><span class="tip-v">${fmt(d.a)} ${unit}</span>${d.note ? `<span class="tip-s">${esc(d.note)}</span>` : ''}${d.b != null ? `<span class="tip-s"><i class="sw s2"></i>1RM ${Math.round(d.b)}</span>` : ''}`;
    const left = (x(i) / W) * r.width;
    tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth)}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hd.setAttribute('visibility', 'hidden'); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointerleave', hide);
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function renderProgram() {
  const st = S.settings;
  const dayBlock = (d, di) => {
    const open = ui.openDays.has(d.id);
    const head = `<button class="row day-row ${open ? 'open' : ''}" data-act="toggle-day" data-id="${esc(d.id)}" aria-expanded="${open}">
      <span class="day-badge">${esc(d.name.slice(0, 1))}</span>
      <span class="row-text"><span class="row-title">${esc(d.name)} Day</span><span class="row-sub">${d.items.length} exercises</span></span>${I.chev}</button>`;
    if (!open) return head;
    return head + `<div class="day-edit">
      <label class="row field-row"><span class="row-title">Name</span><input data-pf="day-name" data-d="${di}" value="${esc(d.name)}"></label>
      ${d.items.map((it, ii) => {
        const x = ex(it.exId), t = TYPES[x.type] || TYPES.total;
        return `<div class="prog-row">
          <div class="prog-main">
            <input class="prog-name" data-pf="ex-name" data-id="${esc(it.exId)}" value="${esc(x.name)}" aria-label="Exercise name">
            <div class="prog-sub">
              <select class="mini-select" data-pf="ex-type" data-id="${esc(it.exId)}" aria-label="Type">${typeOptions(x.type)}</select>
              ${t.w && t.w !== 'min' ? `<span class="base"><input class="num sm" inputmode="decimal" data-pf="baseline" data-d="${di}" data-i="${ii}" value="${fmt(it.baseline)}" placeholder="–" aria-label="Starting weight">${esc(t.w)}</span>` : ''}
              <label class="mini-switch"><input type="checkbox" class="switch sm" data-pf="warmup" data-d="${di}" data-i="${ii}" ${it.warmup ? 'checked' : ''}>Warm-up</label>
            </div>
          </div>
          <div class="prog-btns">
            <button class="icon-btn sm" data-act="mv" data-d="${di}" data-i="${ii}" data-dir="-1" aria-label="Move up" ${ii ? '' : 'disabled'}>${I.up}</button>
            <button class="icon-btn sm" data-act="mv" data-d="${di}" data-i="${ii}" data-dir="1" aria-label="Move down" ${ii < d.items.length - 1 ? '' : 'disabled'}>${I.down}</button>
            <button class="icon-btn sm danger" data-act="rm-item" data-d="${di}" data-i="${ii}" aria-label="Remove">${I.trash}</button>
          </div></div>`;
      }).join('')}
      <form class="form-row inner" data-form="add-item" data-d="${di}">
        <input name="name" list="ex-names" placeholder="Add exercise" required autocomplete="off">
        <select name="type" aria-label="Type">${typeOptions('total')}</select>
        <button class="add-btn" aria-label="Add">${I.plus}</button>
      </form>
      <button class="row center danger" data-act="rm-day" data-d="${di}">Delete ${esc(d.name)} Day</button>
    </div>`;
  };
  return `${largeTitle('Program')}
    <datalist id="ex-names">${Object.values(S.exercises).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
    ${groupH('Days', `<button class="text-btn hdr-btn" data-act="reorder-days">${ui.reorderDays ? 'Done' : 'Reorder'}</button>`)}
    <div class="group">${ui.reorderDays
      ? S.days.map((d, di) => `<div class="row day-row reorder"><span class="day-badge">${esc(d.name.slice(0, 1))}</span>
          <span class="row-text"><span class="row-title">${esc(d.name)} Day</span><span class="row-sub">${di === 0 ? 'First in rotation' : `After ${esc(S.days[di - 1].name)}`}</span></span>
          <button class="icon-btn sm" data-act="mv-day" data-d="${di}" data-dir="-1" aria-label="Move ${esc(d.name)} earlier" ${di ? '' : 'disabled'}>${I.up}</button>
          <button class="icon-btn sm" data-act="mv-day" data-d="${di}" data-dir="1" aria-label="Move ${esc(d.name)} later" ${di < S.days.length - 1 ? '' : 'disabled'}>${I.down}</button></div>`).join('')
      : `${S.days.map(dayBlock).join('')}<button class="row link" data-act="add-day">${I.plus}Add Day</button>`}</div>
    ${groupF(ui.reorderDays ? 'Your rotation runs top to bottom, then starts over. After you finish a day, the next one down comes up.' : 'Each day is a menu. You pick 5–7 exercises from it per workout.')}
    ${groupH('Targets')}
    <div class="group">
      <label class="row field-row"><span class="row-title">Sets per exercise</span><input class="num-r" inputmode="numeric" data-sf="defaultSets" value="${st.defaultSets}"></label>
      <div class="row field-row"><span class="row-title">Rep range</span><span class="range"><input class="num-r" inputmode="numeric" data-sf="repMin" value="${st.repMin}" aria-label="Lowest reps">–<input class="num-r" inputmode="numeric" data-sf="repMax" value="${st.repMax}" aria-label="Highest reps"></span></div>
      <label class="row field-row"><span class="row-title">Rest timer</span><span class="range"><input class="num-r" inputmode="numeric" data-sf="restSec" value="${st.restSec}">sec</span></label>
      <label class="row field-row"><span class="row-title">8-week block</span><input type="checkbox" class="switch" data-sf="periodized" ${st.periodized ? 'checked' : ''}></label>
      ${st.periodized ? `<label class="row field-row"><span class="row-title">Block started</span><input type="date" class="date-r" data-sf="blockStart" value="${st.blockStart}"></label>` : ''}
    </div>
    ${groupF(st.periodized ? `${repTarget().label}. Weeks 1–4 use 4–6 reps, weeks 5–8 use 6–8.` : 'Set the rest timer to 0 to turn it off. The 8-week block switches between 4–6 and 6–8 reps.')}
    ${groupH('Home Screen Widget')}
    <div class="group">
      <label class="row field-row"><span class="row-title">Update when I finish</span><input type="checkbox" class="switch" data-sf="widgetAuto" ${st.widgetAuto ? 'checked' : ''}></label>
      <button class="row link" data-act="widget">Update Widget Now</button>
      <button class="row link" data-act="widget-file">Save Widget File Instead…</button>
    </div>
    ${groupF('When you finish a workout, Scriptable opens for a second and saves it, then tap ◀ Lifts in the top-left corner to come back. Needs the Lift Tracker script in Scriptable. The widget shows "Workout done" that day and your next workout from the next morning.')}
    ${groupH('Backup')}
    <div class="group">
      <button class="row link" data-act="export">Save Backup…</button>
      <label class="row link file-btn">Restore from Backup…<input type="file" accept="application/json,.json" data-act="import" hidden></label>
    </div>
    ${groupF(`Your workouts are stored only on this iPhone. Save a backup to Files or iCloud Drive now and then.${S.lastBackup ? ` Last backup ${fmtDate(S.lastBackup)}.` : ''}`)}
    <div class="group"><button class="row center danger" data-act="reset">Erase All Data</button></div>
    <p class="fine">Lift Tracker · ${finished().length} workouts stored</p>`;
}

/* ---------- sheets (bottom modals) ---------- */

let sheetCloseTimer;
function renderSheet() {
  const host = document.getElementById('sheet');
  const sh = ui.sheet;
  clearTimeout(sheetCloseTimer);
  if (!sh) {
    if (host.hidden || host.classList.contains('closing')) return;
    host.classList.add('closing');
    sheetCloseTimer = setTimeout(() => { host.hidden = true; host.innerHTML = ''; host.classList.remove('closing'); }, 260);
    return;
  }
  const wasOpen = !host.hidden && !host.classList.contains('closing');
  host.classList.remove('closing');
  let body = '', kind = 'card';
  if (sh.kind === 'summary') {
    const s = S.sessions.find((x) => x.id === sh.id);
    const sets = s.entries.reduce((n, e) => n + doneSets(e).length, 0);
    const vol = sessionVolume(s);
    body = `<div class="done-hero"><span class="done-icon">${I.done}</span><h2>Workout Complete</h2><p class="muted">${dayTitle(dayById(s.dayId))} · ${fmtDate(s.date, { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      <div class="tiles">
        <div class="tile"><span class="tile-k">Time</span><span class="tile-n">${Math.round(elapsed(s) / 6e4)}</span><span class="tile-u">min</span></div>
        <div class="tile"><span class="tile-k">Sets</span><span class="tile-n">${sets}</span><span class="tile-u">done</span></div>
        <div class="tile"><span class="tile-k">Volume</span><span class="tile-n">${vol >= 10000 ? `${(vol / 1000).toFixed(1)}k` : Math.round(vol).toLocaleString()}</span><span class="tile-u">lbs</span></div>
      </div>
      ${(s.prs || []).length ? `${groupH('New Personal Records')}<div class="group">${s.prs.map((p) => `<div class="row static"><span class="pr-ico">${I.star}</span><span class="row-text"><span class="row-title">${esc(ex(p.exId).name)}</span><span class="row-sub">${p.items.map(esc).join(' · ')}</span></span></div>`).join('')}</div>` : ''}
      <button class="btn-filled" data-act="close-sheet">Done</button>
      <button class="btn-tinted" data-act="share-card" data-id="${s.id}">${I.share}Share with a Friend</button>
      ${S.settings.widgetAuto ? '' : '<button class="text-btn sheet-link" data-act="widget">Update Home Screen Widget</button>'}`;
  } else if (sh.kind === 'add-ex') {
    const s = current(), day = dayById(s.dayId), have = new Set(s.entries.map((e) => e.exId));
    const fromDay = day ? day.items.filter((i) => !have.has(i.exId)).map((i) => i.exId) : [];
    const others = Object.keys(S.exercises).filter((id) => !have.has(id) && !fromDay.includes(id)).sort((a, b) => ex(a).name.localeCompare(ex(b).name));
    const btn = (id) => `<button class="row" data-act="add-ex-pick" data-id="${esc(id)}"><span class="row-text"><span class="row-title">${esc(ex(id).name)}</span><span class="row-sub">${esc(TYPES[ex(id).type]?.label || '')}</span></span><span class="add-dot">${I.plus}</span></button>`;
    kind = 'tall';
    body = `<div class="sheet-nav"><button class="nav-text" data-act="close-sheet">Cancel</button><span class="sheet-title">Add Exercise</span><span></span></div>
      ${groupH('New')}
      <form class="group form-row" data-form="add-new-ex"><input name="name" placeholder="Name" required autocomplete="off"><select name="type" aria-label="Type">${typeOptions('total')}</select><button class="add-btn" aria-label="Add">${I.plus}</button></form>
      ${fromDay.length ? `${groupH(`${esc(day.name)} Day`)}<div class="group">${fromDay.map(btn).join('')}</div>` : ''}
      ${others.length ? `${groupH('All Exercises')}<div class="group">${others.map(btn).join('')}</div>` : ''}`;
  } else if (sh.kind === 'confirm') {
    kind = 'actionsheet';
    body = `<div class="action-group"><p class="action-msg">${esc(sh.msg)}</p><button class="action ${sh.danger ? 'danger' : ''}" data-act="confirm-yes">${esc(sh.ok)}</button></div>
      <button class="action cancel" data-act="close-sheet">Cancel</button>`;
  } else if (sh.kind === 'add-day') {
    body = `<div class="sheet-nav"><button class="nav-text" data-act="close-sheet">Cancel</button><span class="sheet-title">New Day</span><span></span></div>
      <form class="group form-row" data-form="add-day"><input name="name" placeholder="For example: Full Body" required autocomplete="off"><button class="add-btn" aria-label="Add">${I.plus}</button></form>`;
  } else if (sh.kind === 'card-menu') {
    const s = current(), e = s.entries[sh.e];
    kind = 'actionsheet';
    body = `<div class="action-group"><p class="action-msg"><b>${esc(ex(e.exId).name)}</b></p>
        <button class="action" data-act="card-mv" data-dir="-1" ${sh.e ? '' : 'disabled'}>Move Up</button>
        <button class="action" data-act="card-mv" data-dir="1" ${sh.e < s.entries.length - 1 ? '' : 'disabled'}>Move Down</button>
        <button class="action" data-act="card-progress">Show Progress</button>
        <button class="action danger" data-act="card-rm">Remove from Workout</button></div>
      <button class="action cancel" data-act="close-sheet">Cancel</button>`;
  }
  host.innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"></div><div class="sheet-panel ${kind} ${wasOpen ? 'no-anim' : ''}" role="dialog" aria-modal="true">${kind === 'actionsheet' ? '' : '<div class="grabber"></div>'}${body}</div>`;
  host.hidden = false;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  el.innerHTML = `<span class="toast-icon ${kind}">${kind === 'pr' ? I.star : I.done}</span><span>${esc(msg)}</span>`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 350); }, 3000);
}

// iOS Safari has no vibration API, but toggling a native switch gives a light haptic tap (iOS 18+).
function haptic() {
  try { document.getElementById('hap').click(); } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(8);
}

/* ---------- events ---------- */

// In-app confirmation sheet (native confirm dialogs look out of place and are blocked in some viewers).
function ask(msg, ok = 'OK', danger = false) {
  return new Promise((resolve) => { ui.sheet = { kind: 'confirm', msg, ok, danger, resolve }; renderSheet(); });
}
function closeSheet(result = false) {
  const sh = ui.sheet; ui.sheet = null; renderSheet();
  if (sh?.resolve) sh.resolve(result);
}

async function onClick(ev) {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act, d = el.dataset;
  const s = current();
  switch (a) {
    case 'tab':
      if (d.tab === ui.tab && ui.view !== 'workout') { scrollTo({ top: 0, behavior: 'smooth' }); break; }
      nav('fade', () => { ui.tab = d.tab; ui.view = null; ui.editing = false; ui.reorderDays = false; render(); scrollTo(0, 0); }); break;
    case 'day': if (ui.dayId !== d.id) { haptic(); ui.dayId = d.id; render(); } break;
    case 'pick': haptic(); ui.picks.has(d.id) ? ui.picks.delete(d.id) : ui.picks.add(d.id); savePicks(); render(); break;
    case 'clear-plan': if (await ask(`Clear the plan for ${dayById(ui.dayId)?.name} Day?`, 'Clear Plan', true)) { ui.picks.clear(); savePicks(); render(); } break;
    case 'rest-len': {
      S.settings.restSec = Math.min(600, Math.max(30, S.settings.restSec + 30 * Number(d.dir)));
      haptic(); save(); render(); break;
    }
    case 'pause': pauseWorkout(s); haptic(); save(); render(); break;
    case 'unpause': resumeWorkout(s); haptic(); save(); render(); break;
    case 'start':
      if (S.active && !(await ask('You already have a workout in progress. Replace it with a new one?', 'Replace', true))) return;
      haptic(); nav('push', startWorkout); break;
    case 'resume': nav('push', () => { ui.view = 'workout'; ui.editing = false; render(); scrollTo(0, 0); }); break;
    case 'step': {
      const st = s.entries[d.e].sets[d.s], t = typeOf(s.entries[d.e].exId);
      st.w = Math.max(0, (num(st.w) || 0) + Number(d.d) * (t.step || 5));
      haptic(); save(); render(); break;
    }
    case 'tick': {
      const e = s.entries[d.e], st = e.sets[d.s];
      if (s.pausedAt) resumeWorkout(s);
      st.done = !st.done;
      if (st.done) {
        const t = typeOf(e.exId);
        if (t.r === 'reps' && num(st.r) == null) st.r = repTarget().max;
        // carry this set's numbers into the next untouched set
        const nx = e.sets[+d.s + 1];
        if (nx && !nx.done && nx.w == null && st.w != null) nx.w = st.w;
        const prior = [...historySets(e.exId, s.id), ...e.sets.filter((x, i) => x.done && i !== +d.s)];
        const prs = newPRs(e.exId, prior, [st]);
        haptic();
        if (prs.length) { toast(`New PR! ${prs.join(' · ')}`, 'pr'); setTimeout(haptic, 120); }
        if (!ui.editing) startRest();
      }
      save(); render(); break;
    }
    case 'add-set': {
      const e = s.entries[d.e], last = e.sets[e.sets.length - 1];
      e.sets.push({ w: last?.w ?? null, r: last?.r ?? null, done: false });
      save(); render(); break;
    }
    case 'del-set': s.entries[d.e].sets.pop(); save(); render(); break;
    case 'apply-hint': {
      const card = el.closest('[data-card]'), e = s.entries[card.dataset.card];
      e.sets.forEach((x) => { if (!x.done) x.w = Number(d.w); });
      save(); render(); break;
    }
    case 'card-menu': ui.sheet = { kind: 'card-menu', e: +d.e }; renderSheet(); break;
    case 'card-mv': {
      const i = ui.sheet.e, j = i + Number(d.dir);
      [s.entries[i], s.entries[j]] = [s.entries[j], s.entries[i]];
      ui.sheet = null; save(); render(); break;
    }
    case 'card-rm': s.entries.splice(ui.sheet.e, 1); ui.sheet = null; save(); render(); break;
    case 'card-progress': { const id = s.entries[ui.sheet.e].exId; ui.sheet = null; renderSheet(); nav('pop', () => { ui.progEx = id; ui.tab = 'progress'; ui.view = null; render(); scrollTo(0, 0); }); break; }
    case 'add-ex': ui.sheet = { kind: 'add-ex' }; renderSheet(); break;
    case 'add-ex-pick': s.entries.push(makeEntry(d.id, s.dayId)); ui.sheet = null; save(); render(); scrollTo(0, document.body.scrollHeight); break;
    case 'finish':
      if (!ui.editing && !s.entries.some((e) => e.sets.some((x) => x.done)) && !(await ask('No sets are ticked yet. Finish anyway?', 'Finish'))) return;
      haptic();
      if (!ui.editing && S.settings.widgetAuto) { finishWorkout(); sendToScriptable(); } else nav('pop', finishWorkout);
      break;
    case 'discard': if (await ask('Discard this workout? Nothing from it will be saved.', 'Discard', true)) { nav('pop', () => { S.active = null; ui.view = null; stopRest(); save(); render(); }); } break;
    case 'cancel-edit': nav('pop', () => { S = load(); ui.editing = false; ui.view = null; ui.tab = 'history'; render(); }); break;
    case 'close-sheet': closeSheet(false); break;
    case 'confirm-yes': closeSheet(true); break;
    case 'hist': ui.openHist = ui.openHist === d.id ? null : d.id; render(); break;
    case 'edit-session': nav('push', () => { save(); ui.editing = d.id; ui.view = 'workout'; render(); scrollTo(0, 0); }); break;
    case 'del-session': if (await ask('Delete this workout for good?', 'Delete', true)) { S.sessions = S.sessions.filter((x) => x.id !== d.id); save(); render(); } break;
    case 'toggle-day': ui.openDays.has(d.id) ? ui.openDays.delete(d.id) : ui.openDays.add(d.id); render(); break;
    case 'reorder-days': ui.reorderDays = !ui.reorderDays; render(); break;
    case 'mv-day': {
      const i = +d.d, j = i + Number(d.dir);
      if (j < 0 || j >= S.days.length) break;
      [S.days[i], S.days[j]] = [S.days[j], S.days[i]];
      haptic(); save(); render(); break;
    }
    case 'mv': {
      const items = S.days[d.d].items, i = +d.i, j = i + Number(d.dir);
      [items[i], items[j]] = [items[j], items[i]]; save(); render(); break;
    }
    case 'rm-item': S.days[d.d].items.splice(+d.i, 1); save(); render(); break;
    case 'rm-day':
      if (S.days.length > 1 && (await ask(`Delete ${S.days[d.d].name} day from your program? Logged workouts stay in History.`, 'Delete day', true))) { S.days.splice(+d.d, 1); save(); render(); }
      break;
    case 'add-day': ui.sheet = { kind: 'add-day' }; renderSheet(); setTimeout(() => document.querySelector('#sheet input')?.focus(), 50); break;
    case 'add-idea': {
      const id = findOrCreateExercise(d.name, d.type), day = dayById(ui.dayId);
      if (!day.items.some((i) => i.exId === id)) day.items.push({ exId: id, baseline: null, warmup: false });
      haptic(); ui.picks.add(id); savePicks(); render(); toast(`Added ${d.name} to ${day.name} Day`); break;
    }
    case 'export': exportBackup(); break;
    case 'widget': sendToScriptable(); break;
    case 'widget-file': shareWidget(); break;
    case 'share-card': shareCard(S.sessions.find((x) => x.id === d.id)); break;
    case 'reset':
      if (await ask('Erase every logged workout and reset the program? This cannot be undone. Save a backup first if you might want it.', 'Erase everything', true)) { S = cleanupExercises(seedState()); save(); ui.tab = 'today'; ui.dayId = null; render(); }
      break;
  }
}

function onInput(ev) {
  const el = ev.target;
  if (el.dataset.nf) { current().entries[el.dataset.nf].note = el.value; save(); return; }
  if (el.dataset.f) {
    const s = current(), st = s.entries[el.dataset.e].sets[el.dataset.s];
    st[el.dataset.f] = num(el.value);
    save();
  }
}

function onChange(ev) {
  const el = ev.target, d = el.dataset;
  if (d.act === 'prog-ex') { ui.progEx = el.value; render(); return; }
  if (d.act === 'import') { importBackup(el.files[0]); el.value = ''; return; }
  if (d.sf) {
    const k = d.sf;
    if (k === 'periodized') S.settings.periodized = el.checked;
    else if (k === 'widgetAuto') S.settings.widgetAuto = el.checked;
    else if (k === 'blockStart') S.settings.blockStart = el.value || today();
    else { const n = num(el.value); if (n != null && n >= 0) S.settings[k] = Math.round(n); }
    save(); render(); return;
  }
  if (d.pf) {
    const k = d.pf;
    if (k === 'day-name') S.days[d.d].name = el.value.trim() || S.days[d.d].name;
    if (k === 'ex-name' && el.value.trim()) S.exercises[d.id].name = el.value.trim();
    if (k === 'ex-type') S.exercises[d.id].type = el.value;
    if (k === 'baseline') S.days[d.d].items[d.i].baseline = num(el.value);
    if (k === 'warmup') S.days[d.d].items[d.i].warmup = el.checked;
    save(); render();
  }
}

function findOrCreateExercise(name, type) {
  name = name.trim();
  const found = Object.values(S.exercises).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  let id = slug(name) || uid(); if (S.exercises[id]) id += '-' + uid().slice(-3);
  S.exercises[id] = { id, name, type, note: '' };
  return id;
}

function onSubmit(ev) {
  const f = ev.target;
  ev.preventDefault();
  if (f.dataset.form === 'add-day') {
    const nm = f.name.value.trim(); if (!nm) return;
    let id = slug(nm) || uid(); if (dayById(id)) id += '-' + uid().slice(-3);
    S.days.push({ id, name: nm, items: [] }); ui.openDays.add(id); ui.sheet = null; save(); render(); return;
  }
  const name = f.name.value, type = f.type.value;
  if (!name.trim()) return;
  if (f.dataset.form === 'add-item') {
    const id = findOrCreateExercise(name, type), day = S.days[f.dataset.d];
    if (!day.items.some((i) => i.exId === id)) day.items.push({ exId: id, baseline: null, warmup: false });
    save(); render();
  } else if (f.dataset.form === 'today-new') {
    const id = findOrCreateExercise(name, type), day = dayById(ui.dayId);
    if (!day.virtual && !day.items.some((i) => i.exId === id)) day.items.push({ exId: id, baseline: null, warmup: false });
    ui.picks.add(id); savePicks(); render();
  } else if (f.dataset.form === 'add-new-ex') {
    const id = findOrCreateExercise(name, type), s = current();
    const day = dayById(s.dayId);
    if (day && !day.items.some((i) => i.exId === id)) day.items.push({ exId: id, baseline: null, warmup: false });
    s.entries.push(makeEntry(id, s.dayId));
    ui.sheet = null; save(); render();
  }
}

async function exportBackup() {
  const data = JSON.stringify(S, null, 1);
  const name = `lift-tracker-backup-${today()}.json`;
  const file = new File([data], name, { type: 'application/json' });
  S.lastBackup = today(); save();
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Lift Tracker backup' }); render(); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  render();
}

// Small data file for the Scriptable home screen widget (widget/LiftTracker.js).
// Widgets can't read this app's storage, so the app shares this file to iCloud Drive > Scriptable.
function widgetData() {
  const fin = finished().sort((a, b) => b.date.localeCompare(a.date) || b.start - a.start);
  const t = repTarget();
  return {
    app: 'lift-tracker', version: 1, updated: Date.now(),
    url: location.href.split('#')[0],
    next: { name: dayById(nextDayId())?.name || '', target: `${S.settings.defaultSets} × ${t.min}–${t.max}` },
    rotation: S.days.map((d) => d.name),
    workouts: fin.slice(0, 14).map((s) => ({
      date: s.date, day: dayById(s.dayId)?.name || s.dayId,
      sets: s.entries.reduce((n, e) => n + doneSets(e).length, 0),
      prs: (s.prs || []).reduce((n, p) => n + p.items.length, 0),
    })),
  };
}

// Hands the data straight to the Scriptable script (it saves it for the widget). Must run inside a tap.
function sendToScriptable() {
  location.href = `scriptable:///run/${encodeURIComponent('Lift Tracker')}?data=${encodeURIComponent(JSON.stringify(widgetData()))}`;
}

async function shareWidget() {
  const file = new File([JSON.stringify(widgetData())], 'lift-tracker-widget.json', { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      toast('Widget updated');
      return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Share card: a picture of one workout to text a friend. Drawn on a canvas, sent through the iOS share sheet.
function sessionVolume(s) {
  return s.entries.reduce((n, e) => { const ty = ex(e.exId).type; return n + (TYPES[ty]?.weighted ? doneSets(e).reduce((m, x) => m + (num(x.w) || 0) * (num(x.r) || 0) * (ty === 'total' ? 1 : 2), 0) : 0); }, 0);
}

function drawShareCard(s) {
  const W = 1080, P = 72, font = (w, px) => `${w} ${px}px -apple-system, "SF Pro Display", system-ui, sans-serif`;
  const rows = s.entries.filter((e) => doneSets(e).length);
  const shown = rows.slice(0, 9), more = rows.length - shown.length;
  const prIds = new Set((s.prs || []).map((p) => p.exId));
  const nPr = (s.prs || []).reduce((n, p) => n + p.items.length, 0);
  const H = Math.max(1350, 640 + shown.length * 92 + (more ? 70 : 0) + 150);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#1c1c1e'); bg.addColorStop(1, '#000'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const fit = (t, max) => { if (g.measureText(t).width <= max) return t; while (t && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
  const star = (cx, cy, r) => { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, q = i % 2 ? r * 0.45 : r; g[i ? 'lineTo' : 'moveTo'](cx + q * Math.cos(a), cy + q * Math.sin(a)); } g.closePath(); g.fill(); };
  g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(235,235,245,0.6)'; g.font = font(600, 32);
  g.fillText(fmtDate(s.date, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase(), P, 130);
  g.fillStyle = '#fff'; g.font = font(800, 92);
  g.fillText(fit(`${dayById(s.dayId)?.name || 'Workout'} Day`, W - 2 * P), P, 235);
  // Stat tiles
  const vol = sessionVolume(s), sets = rows.reduce((n, e) => n + doneSets(e).length, 0);
  const tiles = [['TIME', String(Math.round(elapsed(s) / 6e4)), 'min', '#0a84ff'], ['SETS', String(sets), 'done', '#30d158'],
    ['VOLUME', vol >= 10000 ? `${(vol / 1000).toFixed(1)}k` : Math.round(vol).toLocaleString(), 'lbs', '#bf5af2']];
  if (nPr) tiles.push(['PRS', String(nPr), nPr === 1 ? 'record' : 'records', '#ff9f0a']);
  const tw = (W - 2 * P - (tiles.length - 1) * 20) / tiles.length;
  tiles.forEach(([k, n, u, col], i) => {
    const x = P + i * (tw + 20), y = 290;
    g.fillStyle = 'rgba(255,255,255,0.08)'; rr(x, y, tw, 190, 28); g.fill();
    g.fillStyle = col; g.font = font(700, 24); g.fillText(k, x + 26, y + 50);
    let px = 64; g.font = font(700, px); while (px > 36 && g.measureText(n).width > tw - 52) g.font = font(700, (px -= 2));
    g.fillStyle = '#fff'; g.fillText(n, x + 26, y + 125);
    g.fillStyle = 'rgba(235,235,245,0.6)'; g.font = font(500, 26); g.fillText(u, x + 26, y + 165);
  });
  // Exercises with their top set
  let y = 580;
  g.fillStyle = 'rgba(235,235,245,0.6)'; g.font = font(600, 26); g.fillText('TOP SETS', P, y);
  y += 20;
  shown.forEach((e, i) => {
    const top = topSet(e), right = top ? describeSet(e.exId, top) : `${doneSets(e).length} sets`;
    const unit = top && typeOf(e.exId).w && !['bw', 'cardio', 'timed', 'circuit'].includes(ex(e.exId).type) ? ` ${typeOf(e.exId).w}` : '';
    const ry = y + i * 92;
    if (i) { g.fillStyle = 'rgba(84,84,88,0.65)'; g.fillRect(P, ry, W - 2 * P, 2); }
    g.font = font(700, 40); const rText = right + unit, rw = g.measureText(rText).width;
    g.fillStyle = prIds.has(e.exId) ? '#ff9f0a' : '#30d158'; g.fillText(rText, W - P - rw, ry + 62);
    let nameMax = W - 2 * P - rw - 40;
    if (prIds.has(e.exId)) { g.fillStyle = '#ff9f0a'; star(W - P - rw - 34, ry + 48, 16); nameMax -= 44; }
    g.fillStyle = '#fff'; g.font = font(500, 40); g.fillText(fit(ex(e.exId).name, nameMax), P, ry + 62);
  });
  y += shown.length * 92;
  if (more) { g.fillStyle = 'rgba(235,235,245,0.6)'; g.font = font(500, 32); g.fillText(`+ ${more} more`, P, y + 50); y += 70; }
  // Footer
  g.fillStyle = '#0a84ff'; rr(P, H - 110, 52, 52, 14); g.fill();
  g.fillStyle = '#fff'; // dumbbell glyph
  g.fillRect(P + 16, H - 86, 20, 4);
  for (const [dx, h] of [[9, 16], [14, 26], [34, 26], [39, 16]]) { rr(P + dx - 2.5, H - 84 - h / 2, 5, h, 2.5); g.fill(); }
  g.fillStyle = 'rgba(235,235,245,0.6)'; g.font = font(600, 30); g.fillText('Logged with Lift Tracker', P + 74, H - 73);
  return c;
}

async function shareCard(s) {
  if (!s) return;
  // Built synchronously: Safari only opens the share sheet if nothing is awaited after the tap.
  const bin = atob(drawShareCard(s).toDataURL('image/png').split(',')[1]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  const name = `${(dayById(s.dayId)?.name || 'workout').toLowerCase().replace(/\s+/g, '-')}-${s.date}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importBackup(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!data.exercises || !data.days || !Array.isArray(data.sessions)) throw new Error('not a backup');
      ask(`Restore this backup with ${data.sessions.length} workouts? It replaces what is on this phone now.`, 'Restore', true).then((yes) => {
        if (!yes) return;
        S = cleanupExercises(data); save(); ui.tab = 'today'; ui.dayId = null; render(); toast('Backup restored');
      });
    } catch (e) { toast('That file is not a Lift Tracker backup.'); }
  };
  r.readAsText(file);
}

/* ---------- boot ---------- */

document.addEventListener('click', onClick);
document.addEventListener('input', onInput);
document.addEventListener('change', onChange);
document.addEventListener('submit', onSubmit);
document.addEventListener('focusin', (e) => { if (e.target.classList?.contains('num')) setTimeout(() => e.target.select(), 0); });
document.getElementById('rest').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.rest === 'skip') stopRest();
  if (b.dataset.rest === 'add' && rest) { rest.end += 30000; rest.total += 30; updateRest(); }
  if (b.dataset.rest === 'sub' && rest) { rest.end -= 30000; rest.total = Math.max(30, rest.total - 30); updateRest(); }
});
setInterval(() => {
  if (S.active && ui.view === 'workout' && !ui.editing) { const t = document.getElementById('work-timer'); if (t) t.textContent = timerText(S.active); }
  if (S.active && ui.view !== 'workout') { const m = document.querySelector('#mini .mini-sub'); if (m) m.textContent = m.textContent.replace(/ · .*$/, '') + ' · ' + timerText(S.active); }
}, 1000);
addEventListener('scroll', onScroll, { passive: true });
if (S.active) ui.view = 'workout';
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
