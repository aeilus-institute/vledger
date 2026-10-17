// aevri.vledger 1.0 reference: value model (SPEC 7). Pure functions, no I/O.

// goals: [{id, S, N?, status, systemId?}], systems: [{id, W, status}] (SPEC 7)
// Global goal weight w = (W / sum W) * (S / sum S in the system). Goals without a known active system go to an
// implicit system "Other" whose W is the mean W of the active systems (1 when there are none). Goals of a dropped
// system weigh 0.
export const OTHER = '__other';

export function systemWeights(systems = [], goals = []) {
  const active = systems.filter((x) => x.status === 'active');
  const known = new Set(systems.map((x) => x.id));
  const needOther = goals.some((g) => g.status === 'active' && !known.has(g.systemId));
  const meanW = active.length ? active.reduce((t, x) => t + x.W, 0) / active.length : 1;
  const all = needOther ? [...active, { id: OTHER, W: meanW }] : active;
  const total = all.reduce((t, x) => t + x.W, 0);
  const om = {};
  for (const x of all) om[x.id] = total > 0 ? x.W / total : 0;
  return om;
}

export function goalWeights(goals, systems = []) {
  const om = systemWeights(systems, goals);
  const known = new Set(systems.map((x) => x.id));
  // a goal of a dropped system weighs 0; a goal without a system (or of an unknown one) goes to Other
  const sysOf = (g) => (g.systemId && g.systemId in om ? g.systemId : (known.has(g.systemId) ? null : OTHER));
  const active = goals.filter((g) => g.status === 'active');
  const sums = {};
  for (const g of active) sums[sysOf(g)] = (sums[sysOf(g)] || 0) + g.S;
  const w = {};
  for (const g of active) w[g.id] = sysOf(g) === null ? 0 : (om[sysOf(g)] ?? 0) * (sums[sysOf(g)] > 0 ? g.S / sums[sysOf(g)] : 0);
  return w;
}

export function progressShare(goal, contribution) {
  if (typeof contribution.k === 'number') return contribution.k;
  return contribution.c / (goal.N ?? goal.S);
}

// Comparable value v = sum over goals of w * k. Contributions to goals that are not active count 0.
export function comparableValue(goals, contributions, systems = []) {
  const w = goalWeights(goals, systems);
  const byId = Object.fromEntries(goals.map((g) => [g.id, g]));
  let v = 0;
  const parts = [];
  for (const c of contributions) {
    const g = byId[c.goalId];
    if (!g || !(g.id in w)) continue;
    const k = progressShare(g, c);
    parts.push({ goalId: g.id, k, w: w[g.id], wk: w[g.id] * k });
    v += w[g.id] * k;
  }
  return { v, parts };
}

// Planned value counts only through the holder's factor; default 0 (SPEC 7, TZ D-5).
// Rule precedence: contact and system, contact, system, default.
export function planFactor(settings, { contactId, systemId } = {}) {
  const rules = (settings && settings.planCountBy) || [];
  const byBoth = contactId && systemId && rules.find((r) => r.contactId === contactId && r.systemId === systemId);
  const byContact = contactId && rules.find((r) => r.contactId === contactId && !r.systemId);
  const bySystem = systemId && rules.find((r) => r.systemId === systemId && !r.contactId);
  const rule = byBoth || byContact || bySystem;
  if (rule) return rule.factor;
  return (settings && typeof settings.planCountDefault === 'number') ? settings.planCountDefault : 0;
}

// Spearman rank correlation, ties averaged.
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let t = i; t <= j; t++) r[idx[t][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

export function spearman(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ra = ranks(a), rb = ranks(b);
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}

// Feeling checks at entry time (SPEC 7). Returns codes; the UI words them. Never used for reminders.
// assessments: [{v, ownScore?, contributions, at}] newest last; now: Date
export function feelingChecks(goals, assessments, now = new Date()) {
  const out = [];
  const sumByGoal = {};
  for (const a of assessments) for (const c of a.contributions || []) {
    const g = goals.find((x) => x.id === c.goalId);
    if (g) sumByGoal[g.id] = (sumByGoal[g.id] || 0) + progressShare(g, c);
  }
  for (const g of goals.filter((x) => x.status === 'active')) {
    if ((sumByGoal[g.id] || 0) > 1) out.push({ code: 'goal-overfilled', goalId: g.id, share: sumByGoal[g.id] });
  }
  const scored = assessments.filter((a) => a.ownScore && typeof a.v === 'number').slice(-20);
  const rho = spearman(scored.map((a) => a.ownScore.value), scored.map((a) => a.v));
  if (rho !== null && scored.length >= 5 && rho < 0.3) out.push({ code: 'scale-disagrees', rho });
  const active = goals.filter((g) => g.status === 'active');
  if (active.length > 1) {
    const top = active.reduce((m, g) => (g.S > m.S ? g : m));
    const since = now.getTime() - 90 * 86400000;
    const recent = assessments.filter((a) => Date.parse(a.at) >= since);
    const touches = (id) => recent.filter((a) => (a.contributions || []).some((c) => c.goalId === id)).length;
    const others = active.filter((g) => g.id !== top.id).reduce((s, g) => s + touches(g.id), 0);
    if (touches(top.id) === 0 && others >= 3) out.push({ code: 'top-goal-untouched', goalId: top.id });
  }
  return out;
}

// Spent value, efficiency, net value (SPEC 7, TZ v0.3 D-24).
export function assessValue(goals, systems, contributions = [], spent = []) {
  const a = comparableValue(goals, contributions, systems);
  const b = comparableValue(goals, spent, systems);
  return { v: a.v, parts: a.parts, spentV: b.v, spentParts: b.parts, efficiency: b.v > 0 ? a.v / b.v : null, net: a.v - b.v };
}

// Nearest reference on a log scale among [{v, phrase}] (SPEC 7, TZ v0.3 REF-2).
export function nearestReference(refs, v) {
  const dist = (r) => Math.abs(Math.log(Math.abs(r.v)) - Math.log(Math.abs(v)));
  const ok = refs.filter((r) => typeof r.v === 'number' && r.v !== 0);
  if (!ok.length || typeof v !== 'number' || v === 0) return null;
  const best = ok.reduce((m, r) => (dist(r) < dist(m) ? r : m));
  return { ...best, ratio: v / best.v };
}

// Retro only after an earlier realized assessment of the same event object (SPEC 5.3).
export function retroAllowed(assessments, eventId, objectIndex = null) {
  return assessments.some((a) => a.eventId === eventId && (a.objectIndex ?? null) === (objectIndex ?? null) && a.phase === 'realized');
}

// Analytics on confirmed events (SPEC 14). events: [{id, actor, action, actionType?, affected[], role, systemId?, status}],
// assessments: [{eventId, phase, v?, spentV?, createdAt}]. The value of an event is its latest assessment (retro over
// realized). Returns {bySystem, byContact, byAction, byRole, total}, each {key: {events, assessed, v, spentV, efficiency}}.
export function analytics(events, assessments, selfId) {
  const latest = {};
  for (const a of [...assessments].sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))) {
    if (!latest[a.eventId] || a.phase === 'retro' || latest[a.eventId].phase !== 'retro') latest[a.eventId] = a;
  }
  const out = { bySystem: {}, byContact: {}, byAction: {}, byRole: {}, total: {} };
  const add = (group, key, e) => {
    const g = (group[key] ||= { events: 0, assessed: 0, v: 0, spentV: 0, efficiency: null });
    g.events++;
    const a = latest[e.id];
    if (a) { g.assessed++; g.v += a.v || 0; g.spentV += a.spentV || 0; }
    g.efficiency = g.spentV > 0 ? g.v / g.spentV : null;
  };
  for (const e of events.filter((x) => x.status === 'confirmed')) {
    const other = e.actor === selfId ? (e.affected || [])[0] || selfId : e.actor;
    add(out.bySystem, e.systemId || 'none', e);
    add(out.byContact, other, e);
    add(out.byAction, (e.actionType || e.action || '').trim().toLowerCase(), e);
    add(out.byRole, e.role, e);
    add(out.total, 'all', e);
  }
  return out;
}

// One-click reactions (SPEC 17) in aggregate: coverage, distribution, by system and by month, the best and the wasted.
// events: [{id, occurredAt, systemId}], reactions: [{eventId, phase, reaction, createdAt}] (reaction already normalised).
// The latest reaction per event counts, a retro one before a realized one.
export const REACTION_SCALE = [-100, -20, 0, 20, 100, 500];
export function reactionStats(events, reactions) {
  const latest = {};
  for (const r of [...reactions].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    if (!REACTION_SCALE.includes(r.reaction)) continue;
    if (!latest[r.eventId] || r.phase === 'retro' || latest[r.eventId].phase !== 'retro') latest[r.eventId] = r;
  }
  const blank = () => ({ events: 0, assessed: 0, dist: Object.fromEntries(REACTION_SCALE.map((v) => [v, 0])), useful: 0, wasted: 0 });
  const add = (g, rx) => {
    g.events++;
    if (rx === undefined) return;
    g.assessed++; g.dist[rx]++;
    if (rx >= 20) g.useful++;
    if (rx < 0) g.wasted++;
  };
  const out = { total: blank(), bySystem: {}, byMonth: {}, best: [], wasted: [] };
  for (const e of events) {
    const rx = latest[e.id]?.reaction;
    add(out.total, rx);
    add(out.bySystem[e.systemId || 'none'] ||= blank(), rx);
    if (rx !== undefined) add(out.byMonth[String(e.occurredAt).slice(0, 7)] ||= blank(), rx);
    if (rx >= 100) out.best.push({ id: e.id, reaction: rx, occurredAt: e.occurredAt });
    if (rx < 0) out.wasted.push({ id: e.id, reaction: rx, occurredAt: e.occurredAt });
  }
  const order = (a, b) => b.reaction - a.reaction || String(b.occurredAt).localeCompare(String(a.occurredAt));
  out.best.sort(order);
  out.wasted.sort((a, b) => a.reaction - b.reaction || String(b.occurredAt).localeCompare(String(a.occurredAt)));
  return out;
}
