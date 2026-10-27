/* ==========================================================================
   The plan engine: picks the next workout and analyzes the history.

   Pure functions, no imports, so the same file runs in Node (engine/cli.js,
   used by the daily Claude session) and in the browser (the dashboard on
   alexanderk.dev loads it through the site's Worker). Same data in, same
   plan out.

   Inputs are the repo's JSON files as they are:
     program      program.json      rotation, slots per day, targets
     exercises    exercises.json    the lift catalog ({ exercises: [...] })
     preferences  preferences.json  rankings per slot, "never" list, cardio
     workouts     workouts/*.json   merged into one { "YYYY-MM-DD": entry }
     bodyweight   bodyweight.json   { "YYYY-MM-DD": lb }
   Dates are "YYYY-MM-DD" strings in Alex's own time zone.
   ========================================================================== */

const DAY_MS = 86400000;
const toDays = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS;
export const daysBetween = (a, b) => toDays(b) - toDays(a);
export const addDays = (d, n) => new Date((toDays(d) + n) * DAY_MS).toISOString().slice(0, 10);
// Monday of the date's week
export const weekStart = (d) => addDays(d, -((new Date(toDays(d) * DAY_MS).getUTCDay() + 6) % 7));

// Today's date where Alex is (the container running this is in UTC)
export function localDate(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Estimated 1-rep max (Epley)
export const e1rm = (weight, reps) => (reps <= 0 || weight <= 0 ? 0 : reps === 1 ? weight : weight * (1 + reps / 30));
const round5 = (w) => Math.round(w / 5) * 5;

// Workouts as a list, oldest first
export function sessions(workouts) {
  return Object.entries(workouts || {})
    .map(([date, entry]) => ({ ...entry, date }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export const catalog = (exercises) => new Map((exercises.exercises || exercises).map((e) => [e.id, e]));

const liftsOf = (s) => (s.lifts || []).filter((l) => l.exercise && (l.sets || []).length);
const cardioOf = (s) => (Array.isArray(s.cardio) ? s.cardio : s.cardio ? [s.cardio] : []);
const minutesOf = (s) => (s.started && s.finished ? (Date.parse(s.finished) - Date.parse(s.started)) / 60000 : null);

/* --------------------------------------------------------------------------
   The plan for the next session on or after `date`
   -------------------------------------------------------------------------- */
export function computePlan({ program, exercises, preferences, workouts, date }) {
  const ex = catalog(exercises);
  const order = [...ex.keys()];
  const prefs = preferences || {};
  const never = new Set(prefs.never || []);
  const rankings = prefs.rankings || {};
  const all = sessions(workouts).filter((s) => s.date <= date);
  const today = all.find((s) => s.date === date);
  // What counts as "before this session": everything earlier, plus today if it's already done
  const past = all.filter((s) => s.date < date || s.status !== "in_progress");
  const completed = past.filter((s) => s.status === "completed" && s.day);
  const last = completed.at(-1);
  const rotation = program.rotation;
  const notes = [];

  // 1. Which day. Only a completed workout moves the rotation; a skip or rest keeps the same day up next.
  let day;
  if (today && today.status === "in_progress" && today.day) day = today.day;
  else if (!last) day = rotation[0];
  else day = rotation.at((rotation.indexOf(last.day) + 1) % rotation.length);
  const skippedSince = last ? past.filter((s) => s.date > last.date && s.status === "skipped").length : 0;
  if (skippedSince) notes.push(`${skippedSince} skipped since your last workout, so ${program.days[day].name} is still up.`);

  // 2. Easing back in after a break
  const gap = last ? daysBetween(last.date, date) : null;
  const deload = gap !== null && gap >= program.deload_after_days;
  if (deload) notes.push(`${gap} days since your last workout: weights are about ${Math.round((1 - program.deload_factor) * 100)}% lighter today.`);

  // 3. Suggest rest after a long run of training days (never forced)
  let streak = 0;
  for (let d = today && today.status === "completed" ? date : addDays(date, -1); ; d = addDays(d, -1)) {
    const s = all.find((x) => x.date === d);
    if (!s || s.status !== "completed") break;
    streak++;
  }
  if (streak >= program.rest_hint_after_days) notes.push(`You've trained ${streak} days in a row. Consider a rest day.`);

  // 4. Cardio: the machine used least in the last 2 weeks
  const machines = (prefs.cardio && prefs.cardio.machines) || ["treadmill", "bike", "elliptical"];
  const minutes = (prefs.cardio && prefs.cardio.minutes) || 25;
  const use = Object.fromEntries(machines.map((m) => [m, { count: 0, lastAt: "" }]));
  past.filter((s) => daysBetween(s.date, date) < 14).forEach((s) => cardioOf(s).forEach((c) => {
    if (use[c.machine]) { use[c.machine].count++; use[c.machine].lastAt = s.date; }
  }));
  const machine = [...machines].sort((a, b) => use[a].count - use[b].count || (use[a].lastAt < use[b].lastAt ? -1 : use[a].lastAt > use[b].lastAt ? 1 : 0))[0];
  const cardio = {
    minutes, machine,
    why: use[machine].count ? `used ${use[machine].count}× in the last 2 weeks, the least of the three` : "not used in the last 2 weeks",
  };

  // 5. Lifts: the day's core slots, plus a flex slot unless recent sessions ran long
  const plan = program.days[day];
  const sameDay = completed.filter((s) => s.day === day);
  const lastTwo = sameDay.slice(-2);
  const long = lastTwo.length === 2 && lastTwo.every((s) => minutesOf(s) > program.long_session_minutes);
  if (long) notes.push(`Your last two ${plan.name} sessions ran over ${program.long_session_minutes} minutes, so 4 lifts today.`);

  const since = addDays(date, -56);
  const freq = new Map();
  past.filter((s) => s.date > since).forEach((s) => liftsOf(s).forEach((l) => freq.set(l.exercise, (freq.get(l.exercise) || 0) + 1)));

  const chosen = [];
  const pick = (slot) => {
    const ranked = (rankings[slot] || []).filter((id) => ex.has(id) && !never.has(id));
    const candidates = order.map((id) => ex.get(id)).filter((e) => e.slot === slot && !never.has(e.id) && !chosen.some((c) => c.exercise === e.id));
    if (!candidates.length) return null;
    const maxFreq = Math.max(1, ...candidates.map((e) => freq.get(e.id) || 0));
    const scored = candidates.map((e) => {
      const rank = ranked.indexOf(e.id);
      const rankScore = rank < 0 ? 0 : 1 - (0.7 * rank) / ranked.length;
      const f = freq.get(e.id) || 0;
      // Accessories rotate: a small penalty if it was done in both of the last two sessions of this day
      const repeat = e.type === "isolation" && lastTwo.length === 2 && lastTwo.every((s) => liftsOf(s).some((l) => l.exercise === e.id));
      const score = 0.5 * rankScore + 0.4 * (f / maxFreq) - (repeat ? 0.45 : 0);
      const why = [];
      if (rank >= 0) why.push(`your #${rank + 1} for ${program.slots[slot].name.toLowerCase()}`);
      if (f) why.push(`logged ${f}× in the last 8 weeks`);
      if (!why.length) why.push("a standard pick for this slot");
      return { e, score, why: why.join(", ") };
    });
    // Ties go to the catalog order, which lists the standard pick for each slot first
    scored.sort((a, b) => b.score - a.score || order.indexOf(a.e.id) - order.indexOf(b.e.id));
    return scored[0];
  };

  const add = (slot, extraWhy) => {
    const best = pick(slot);
    if (!best) { notes.push(`Nothing left to suggest for ${program.slots[slot].name}: every lift there is on your "never" list.`); return; }
    chosen.push({
      slot, slotName: program.slots[slot].name, exercise: best.e.id, name: best.e.name,
      ...target(best.e, past, program, deload), why: extraWhy ? `${extraWhy}; ${best.why}` : best.why, flex: Boolean(extraWhy),
    });
  };
  plan.core.forEach((slot) => add(slot));

  if (!long) {
    const analysis = analyze({ program, exercises, workouts, date, weeks: 4 });
    const enoughHistory = past.length && daysBetween(past[0].date, date) >= 14;
    let flex = null, reason = "";
    if (enoughHistory) {
      const avg = Object.fromEntries(analysis.volume.map((v) => [v.muscle, v.avgWeekly]));
      let worst = 0;
      plan.flex.forEach((slot) => {
        const muscles = new Set(order.map((id) => ex.get(id)).filter((e) => e.slot === slot && !never.has(e.id)).flatMap((e) => e.primary || []));
        muscles.forEach((m) => {
          if (!(m in avg)) return;
          const deficit = program.weekly_sets.target - avg[m];
          if (deficit > worst) { worst = deficit; flex = slot; reason = `extra ${program.muscles[m].toLowerCase()} work (${avg[m]} sets a week lately, target ${program.weekly_sets.target})`; }
        });
      });
    }
    if (!flex) {
      flex = plan.flex.find((slot) => (rankings[slot] || []).some((id) => ex.has(id) && !never.has(id) && !chosen.some((c) => c.exercise === id)));
      if (flex) reason = "one of your favorites";
    }
    if (!flex) { flex = plan.flex[0]; reason = "fifth lift"; }
    add(flex, reason);
  }

  return {
    date, day, dayName: plan.name, number: sameDay.length + 1,
    cardio, lifts: chosen, notes,
  };
}

// Weight and reps to aim for, from the last time this lift was logged (double progression)
function target(e, past, program, deload) {
  const [lo, hi] = e.reps;
  const sets = program.sets_per_lift;
  const lastSession = [...past].reverse().find((s) => liftsOf(s).some((l) => l.exercise === e.id));
  if (!lastSession) {
    return { sets, reps: [lo, hi], weight: e.bodyweight ? 0 : null, note: e.bodyweight ? `Bodyweight, aim for ${lo} to ${hi} reps` : `No history yet: find a weight you can do for ${lo} to ${hi} reps` };
  }
  const lift = liftsOf(lastSession).find((l) => l.exercise === e.id);
  const top = Math.max(...lift.sets.map((s) => s.weight || 0));
  const work = lift.sets.filter((s) => (s.weight || 0) === top);
  const lastText = `${top || "BW"} × ${work.map((s) => s.reps).join(", ")} on ${lastSession.date}`;
  let weight = top, note;
  if (work.every((s) => s.reps >= hi)) {
    weight = top + e.increment;
    note = `Last: ${lastText}. You hit ${hi} on every set, so up ${e.increment} lb`;
  } else {
    note = `Last: ${lastText}. Same weight, beat it by a rep`;
  }
  if (deload && weight > 0) { weight = round5(weight * program.deload_factor); note += " (eased back after the break)"; }
  return { sets: Math.max(sets, work.length), reps: [lo, hi], weight, note };
}

/* --------------------------------------------------------------------------
   History analysis: volume per muscle, strength over time, weak areas
   -------------------------------------------------------------------------- */
export function analyze({ program, exercises, workouts, date, weeks = 12 }) {
  const ex = catalog(exercises);
  const all = sessions(workouts).filter((s) => s.date <= date);
  const logged = all.filter((s) => liftsOf(s).length || cardioOf(s).length);
  const firstWeek = addDays(weekStart(date), -7 * (weeks - 1));
  const muscleSets = (s, into, weight = 1) => liftsOf(s).forEach((l) => {
    const e = ex.get(l.exercise);
    if (!e) return;
    (e.primary || []).forEach((m) => { into[m] = (into[m] || 0) + l.sets.length * weight; });
    (e.secondary || []).forEach((m) => { into[m] = (into[m] || 0) + l.sets.length * 0.5 * weight; });
  });

  // Weekly sets per muscle and cardio minutes per machine
  const weekly = [];
  for (let w = firstWeek; w <= date; w = addDays(w, 7)) {
    const inWeek = logged.filter((s) => s.date >= w && s.date < addDays(w, 7));
    const sets = {}, cardio = {};
    inWeek.forEach((s) => {
      muscleSets(s, sets);
      cardioOf(s).forEach((c) => { cardio[c.machine] = (cardio[c.machine] || 0) + (c.minutes || 0); });
    });
    weekly.push({ week: w, sets, cardio, sessions: all.filter((s) => s.date >= w && s.date < addDays(w, 7) && s.status === "completed").length });
  }

  // Average weekly sets over the last 4 weeks
  const recent = {};
  logged.filter((s) => daysBetween(s.date, date) < 28).forEach((s) => muscleSets(s, recent));
  const ws = program.weekly_sets;
  const volume = program.tracked_muscles.map((m) => {
    const avgWeekly = Math.round(((recent[m] || 0) / 4) * 10) / 10;
    return { muscle: m, name: program.muscles[m], avgWeekly, status: avgWeekly < ws.low ? "low" : avgWeekly < ws.target ? "under" : avgWeekly > ws.high ? "high" : "ok" };
  });

  // Strength: best estimated 1RM per session per lift, and PRs
  const strength = {};
  logged.forEach((s) => liftsOf(s).forEach((l) => {
    const best = l.sets.reduce((b, set) => {
      const v = e1rm(set.weight || 0, set.reps || 0);
      return v > b.e1rm ? { e1rm: Math.round(v * 10) / 10, weight: set.weight, reps: set.reps } : b;
    }, { e1rm: 0 });
    if (!best.e1rm) return;
    const series = (strength[l.exercise] = strength[l.exercise] || []);
    const pr = !series.length || best.e1rm > Math.max(...series.map((p) => p.e1rm));
    series.push({ date: s.date, ...best, pr });
  }));

  const weakAreas = [];
  volume.filter((v) => v.status === "low" || v.status === "under")
    .sort((a, b) => a.avgWeekly - b.avgWeekly)
    .forEach((v) => weakAreas.push({ kind: "volume", muscle: v.muscle, label: `${v.name}: ${v.avgWeekly} sets a week`, detail: `Target is ${ws.target} to ${ws.high}. Average over the last 4 weeks.` }));

  // Stalls: logged recently and often, but no new best in 4+ weeks
  Object.entries(strength).forEach(([id, series]) => {
    const recentSessions = series.filter((p) => daysBetween(p.date, date) <= 42);
    const lastPr = series.filter((p) => p.pr).at(-1);
    if (recentSessions.length >= 3 && daysBetween(series[0].date, date) >= 35 && daysBetween(lastPr.date, date) >= 28 && daysBetween(series.at(-1).date, date) <= 14) {
      const name = ex.has(id) ? ex.get(id).name : id;
      weakAreas.push({ kind: "stall", exercise: id, label: `${name} has stalled`, detail: `No new best since ${lastPr.date} (est. 1RM ${lastPr.e1rm} lb).` });
    }
  });

  // Push vs pull balance over the last 4 weeks
  const sum = (ms) => ms.reduce((t, m) => t + (recent[m] || 0), 0);
  const push = sum(program.push_muscles), pull = sum(program.pull_muscles);
  const balance = { push: Math.round(push * 10) / 10, pull: Math.round(pull * 10) / 10, ratio: pull ? Math.round((push / pull) * 100) / 100 : null };
  if (push >= 8 && (pull === 0 || push / pull > 1.5)) weakAreas.push({ kind: "imbalance", label: "More pushing than pulling", detail: `${balance.push} pushing vs ${balance.pull} pulling sets in 4 weeks.` });
  if (pull >= 8 && push > 0 && pull / push > 1.5) weakAreas.push({ kind: "imbalance", label: "More pulling than pushing", detail: `${balance.pull} pulling vs ${balance.push} pushing sets in 4 weeks.` });

  // How often the plan was followed
  const followed = all.filter((s) => s.status === "completed" && s.recommended && s.recommended.lifts);
  const planned = followed.reduce((t, s) => t + s.recommended.lifts.length, 0);
  const done = followed.reduce((t, s) => t + s.recommended.lifts.filter((id) => liftsOf(s).some((l) => l.exercise === id)).length, 0);

  return {
    date, weekly, volume, strength, weakAreas, balance,
    adherence: planned ? Math.round((done / planned) * 100) : null,
    days: all.map((s) => ({ date: s.date, status: s.status, day: s.day || null })),
  };
}

/* --------------------------------------------------------------------------
   Body weight: day-to-day weigh-ins swing by a few lb with water and food,
   so the trend is the average of the weigh-ins in the 7 days up to each one.
   -------------------------------------------------------------------------- */
export function weightTrend(bodyweight = {}, date) {
  const dates = Object.keys(bodyweight).filter((d) => !date || d <= date).sort();
  const points = dates.map((d) => {
    const week = dates.filter((x) => x <= d && daysBetween(x, d) < 7).map((x) => bodyweight[x]);
    return { date: d, weight: bodyweight[d], trend: Math.round((week.reduce((a, b) => a + b, 0) / week.length) * 10) / 10 };
  });
  const last = points[points.length - 1];
  // Change in the trend over the last N days, from the closest point at or before that day
  const change = (days) => {
    if (!last) return null;
    const from = points.filter((p) => daysBetween(p.date, last.date) >= days).pop();
    return from ? Math.round((last.trend - from.trend) * 10) / 10 : null;
  };
  return { points, latest: last || null, change7: change(7), change30: change(30) };
}
