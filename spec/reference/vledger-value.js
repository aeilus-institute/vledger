// aevri.vledger 1.0 reference: value model (SPEC 7). Pure functions, no I/O.

// goals: [{id, S, N?, status}], contributions: [{goalId, c?, k?}]
export function goalWeights(goals) {
  const active = goals.filter((g) => g.status === 'active');
  const total = active.reduce((s, g) => s + g.S, 0);
  const w = {};
  for (const g of active) w[g.id] = total > 0 ? g.S / total : 0;
  return w;
}

export function progressShare(goal, contribution) {
  if (typeof contribution.k === 'number') return contribution.k;
  return contribution.c / (goal.N ?? goal.S);
}

// Comparable value v = sum over goals of w * k. Contributions to goals that are not active count 0.
export function comparableValue(goals, contributions) {
  const w = goalWeights(goals);
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
export function planFactor(settings, { counterpartyId, typeId } = {}) {
  const rules = (settings && settings.planCountBy) || [];
  const byBoth = rules.find((r) => r.counterpartyId === counterpartyId && r.typeId === typeId && counterpartyId && typeId);
  const byCp = rules.find((r) => r.counterpartyId === counterpartyId && !r.typeId);
  const byType = rules.find((r) => r.typeId === typeId && !r.counterpartyId);
  const rule = byBoth || byCp || byType;
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
