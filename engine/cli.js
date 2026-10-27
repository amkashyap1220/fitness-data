#!/usr/bin/env node
/* ==========================================================================
   Command line for the daily Claude session (see CLAUDE.md).

     node engine/cli.js plan [--write]          today's plan (--write saves state.json)
     node engine/cli.js start                   open today's entry with the plan
     node engine/cli.js log <lift> <sets...>    add sets: 185x8  185x8x3  185x8,7,6  bwx10
     node engine/cli.js undo <lift>             remove the last set of a lift
     node engine/cli.js cardio <machine> <min> [--notes "..."]
     node engine/cli.js note "<text>"
     node engine/cli.js finish | skip | rest    close the day, save the next plan
     node engine/cli.js summary                 the day so far vs last time
     node engine/cli.js find <words>            look up lift ids
     node engine/cli.js requests                lifts Alex asked for on the dashboard
     node engine/cli.js add-exercise '<json>' [--request N] [--rank first|last]
                                                add a lift (and clear request N)
     node engine/cli.js drop-request N          clear a request without adding
     node engine/cli.js validate                check every file
     node engine/cli.js save "<message>"        commit and push

   Every command takes --date YYYY-MM-DD (default: today in preferences.timezone).
   ========================================================================== */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computePlan, analyze, localDate, sessions, catalog, addDays } from "./engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MACHINES = ["treadmill", "bike", "elliptical"];
const STATUSES = ["in_progress", "completed", "skipped", "rest"];

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));
const writeJson = (file, data) => {
  mkdirSync(dirname(join(ROOT, file)), { recursive: true });
  writeFileSync(join(ROOT, file), JSON.stringify(data, null, 2) + "\n");
};

export function load(root = ROOT) {
  const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
  const dir = join(root, "workouts");
  const workouts = {};
  if (existsSync(dir)) readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)).sort()
    .forEach((f) => Object.assign(workouts, read(join("workouts", f))));
  return { program: read("program.json"), exercises: read("exercises.json"), preferences: read("preferences.json"), workouts };
}

// Only the year file the date belongs to is rewritten, with dates in order
function saveDay(data, date) {
  const year = date.slice(0, 4);
  const inYear = Object.fromEntries(Object.entries(data.workouts).filter(([d]) => d.startsWith(year)).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeJson(`workouts/${year}.json`, inYear);
}

export function parseSets(tokens) {
  const sets = [];
  for (const raw of tokens) {
    const t = raw.toLowerCase().replace(/\s+/g, "").replace(/lbs?$/, "");
    const m = t.match(/^(bw\+?|bw\+\d+(?:\.\d+)?|\d+(?:\.\d+)?)x(\d+(?:,\d+)*)(?:x(\d+))?$/);
    if (!m) throw new Error(`Can't read "${raw}". Use 185x8, 185x8x3 (3 sets), 185x8,7,6 or bwx10.`);
    const weight = m[1].startsWith("bw") ? Number(m[1].replace(/^bw\+?/, "") || 0) : Number(m[1]);
    const reps = m[2].split(",").map(Number);
    const times = m[3] ? Number(m[3]) : 1;
    if (m[3] && reps.length > 1) throw new Error(`"${raw}": use either 185x8x3 or 185x8,8,8, not both.`);
    for (let i = 0; i < times; i++) reps.forEach((r) => sets.push({ weight, reps: r }));
  }
  if (!sets.length) throw new Error("No sets given.");
  return sets;
}

export function findExercises(exercises, words) {
  const q = words.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (exercises.exercises || []).filter((e) => {
    const hay = `${e.id} ${e.name}`.toLowerCase().replace(/-/g, " ");
    return q.every((w) => hay.includes(w));
  });
}

function resolve(exercises, word) {
  const w = word.toLowerCase();
  const byId = (exercises.exercises || []).find((e) => e.id === w || e.name.toLowerCase() === w);
  if (byId) return byId;
  const found = findExercises(exercises, word);
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No lift matches "${word}". Add it with add-exercise first.`);
  throw new Error(`"${word}" matches several lifts: ${found.map((e) => e.id).join(", ")}`);
}

const fmtSets = (sets) => {
  const groups = [];
  sets.forEach((s) => {
    const g = groups.at(-1);
    if (g && g.weight === s.weight) g.reps.push(s.reps); else groups.push({ weight: s.weight, reps: [s.reps] });
  });
  return groups.map((g) => `${g.weight || "BW"} × ${g.reps.join(", ")}`).join(" · ");
};

export function formatPlan(plan, data) {
  const lines = [`${plan.dayName} day #${plan.number} (${plan.date})`, ""];
  lines.push(`Cardio: ${plan.cardio.minutes} min on the ${plan.cardio.machine} (${plan.cardio.why})`, "");
  plan.lifts.forEach((l, i) => {
    const w = l.weight === null ? "pick a weight" : l.weight === 0 ? "bodyweight" : `${l.weight} lb`;
    lines.push(`${i + 1}. ${l.name}: ${l.sets} × ${l.reps[0]}-${l.reps[1]} @ ${w}${l.flex ? "  [flex]" : ""}`);
    lines.push(`   ${l.note}. Why: ${l.why}.`);
  });
  if (plan.notes.length) lines.push("", ...plan.notes.map((n) => `Note: ${n}`));
  return lines.join("\n");
}

export function summarize(data, date) {
  const ex = catalog(data.exercises);
  const entry = data.workouts[date];
  if (!entry) return `Nothing logged for ${date}.`;
  const lines = [`${date}: ${entry.day || "?"} · ${entry.status}`];
  const analysis = analyze({ ...data, date, weeks: 1 });
  let volume = 0;
  (entry.lifts || []).forEach((l) => {
    const name = ex.has(l.exercise) ? ex.get(l.exercise).name : l.exercise;
    const pr = (analysis.strength[l.exercise] || []).find((p) => p.date === date && p.pr);
    const earlier = (analysis.strength[l.exercise] || []).filter((p) => p.date < date);
    volume += l.sets.reduce((t, s) => t + (s.weight || 0) * s.reps, 0);
    lines.push(`- ${name}: ${fmtSets(l.sets)}${pr && earlier.length ? `  NEW BEST (est. 1RM ${pr.e1rm} lb)` : ""}`);
  });
  const cardio = (Array.isArray(entry.cardio) ? entry.cardio : entry.cardio ? [entry.cardio] : []);
  const minutes = cardio.reduce((t, c) => t + (c.minutes || 0), 0);
  const goal = (data.preferences.cardio && data.preferences.cardio.minutes) || 25;
  lines.push(`- Cardio: ${minutes ? cardio.map((c) => `${c.minutes} min ${c.machine}`).join(" + ") : "none"}${minutes < goal ? ` (target ${goal})` : ""}`);
  const prev = sessions(data.workouts).filter((s) => s.date < date && s.status === "completed" && s.day === entry.day).at(-1);
  if (prev) {
    const prevVolume = (prev.lifts || []).reduce((t, l) => t + l.sets.reduce((u, s) => u + (s.weight || 0) * s.reps, 0), 0);
    lines.push(`- Volume: ${volume.toLocaleString("en-US")} lb (last ${entry.day}: ${prevVolume.toLocaleString("en-US")} lb)`);
  } else if (volume) {
    lines.push(`- Volume: ${volume.toLocaleString("en-US")} lb`);
  }
  if (entry.recommended && entry.recommended.lifts) {
    const missed = entry.recommended.lifts.filter((id) => !(entry.lifts || []).some((l) => l.exercise === id));
    if (missed.length && entry.status === "completed") lines.push(`- Swapped or skipped from the plan: ${missed.map((id) => (ex.has(id) ? ex.get(id).name : id)).join(", ")}`);
  }
  return lines.join("\n");
}

export function validate(data) {
  const problems = [];
  const ex = catalog(data.exercises);
  const ids = new Set();
  (data.exercises.exercises || []).forEach((e) => {
    if (ids.has(e.id)) problems.push(`exercises.json: duplicate id ${e.id}`);
    ids.add(e.id);
    if (!/^[a-z0-9-]+$/.test(e.id || "")) problems.push(`exercises.json: bad id "${e.id}"`);
    if (!data.program.slots[e.slot]) problems.push(`exercises.json: ${e.id} has unknown slot "${e.slot}"`);
    [...(e.primary || []), ...(e.secondary || [])].forEach((m) => { if (!data.program.muscles[m]) problems.push(`exercises.json: ${e.id} has unknown muscle "${m}"`); });
    if (!Array.isArray(e.reps) || e.reps.length !== 2 || e.reps[0] > e.reps[1]) problems.push(`exercises.json: ${e.id} needs reps [low, high]`);
    if (!(e.increment > 0)) problems.push(`exercises.json: ${e.id} needs an increment`);
  });
  Object.entries(data.preferences.rankings || {}).forEach(([slot, list]) => {
    if (!data.program.slots[slot]) problems.push(`preferences.json: unknown slot "${slot}" in rankings`);
    list.forEach((id) => { if (!ex.has(id)) problems.push(`preferences.json: unknown lift "${id}" in rankings.${slot}`); });
  });
  (data.preferences.requests || []).forEach((r, i) => {
    if (!r || typeof r.text !== "string" || !r.text.trim()) problems.push(`preferences.json: request ${i} has no text`);
  });
  Object.entries(data.workouts).forEach(([date, w]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`workouts: bad date key "${date}"`);
    if (!STATUSES.includes(w.status)) problems.push(`workouts ${date}: status must be one of ${STATUSES.join(", ")}`);
    if (w.day && !data.program.days[w.day]) problems.push(`workouts ${date}: unknown day "${w.day}"`);
    (w.lifts || []).forEach((l) => {
      if (!ex.has(l.exercise)) problems.push(`workouts ${date}: unknown lift "${l.exercise}"`);
      (l.sets || []).forEach((s) => { if (!(s.reps > 0) || !(s.weight >= 0)) problems.push(`workouts ${date}: bad set in ${l.exercise}`); });
    });
    (Array.isArray(w.cardio) ? w.cardio : w.cardio ? [w.cardio] : []).forEach((c) => {
      if (!MACHINES.includes(c.machine)) problems.push(`workouts ${date}: cardio machine must be treadmill, bike or elliptical`);
    });
  });
  return problems;
}

// Removes and returns request number `n` from preferences.requests
function takeRequest(prefs, n) {
  const list = prefs.requests || [];
  const i = Number(n);
  if (!Number.isInteger(i) || !list[i]) throw new Error(`No request ${n}. Run "requests" to see them.`);
  return list.splice(i, 1)[0];
}

/* --------------------------------------------------------------------------
   Commands
   -------------------------------------------------------------------------- */
function main(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else args.push(argv[i]);
  }
  const [cmd, ...rest] = args;
  const data = load();
  const date = flags.date || localDate(data.preferences.timezone || "America/Chicago");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
  const now = new Date().toISOString();

  const planFor = (d) => computePlan({ ...data, date: d });
  const writeState = (d = date) => {
    // The next session's plan, for the dashboard and the next daily session
    const plan = planFor(d);
    writeJson("state.json", { generated_at: now, plan });
    return plan;
  };
  const open = () => {
    if (!data.workouts[date]) {
      const plan = planFor(date);
      data.workouts[date] = {
        status: "in_progress", day: plan.day, started: now, cardio: [], lifts: [],
        recommended: { lifts: plan.lifts.map((l) => l.exercise), cardio: plan.cardio.machine },
      };
    }
    const entry = data.workouts[date];
    if (entry.status !== "in_progress" && entry.status !== "completed") {
      entry.status = "in_progress";
      if (!entry.day) entry.day = planFor(date).day;
    }
    return entry;
  };

  switch (cmd) {
    case "plan": {
      const plan = flags.write ? writeState() : planFor(date);
      console.log(flags.json ? JSON.stringify(plan, null, 2) : formatPlan(plan, data));
      const asked = data.preferences.requests || [];
      if (asked.length && !flags.json) console.log(`\nLift requests from the dashboard (handle these first, see CLAUDE.md): ${asked.map((r, i) => `${i}. "${r.text}"`).join("; ")}`);
      break;
    }
    case "start": {
      open();
      saveDay(data, date);
      console.log(formatPlan(planFor(date), data));
      break;
    }
    case "log": {
      const [word, ...tokens] = rest;
      const e = resolve(data.exercises, word);
      const sets = parseSets(tokens);
      const entry = open();
      let lift = entry.lifts.find((l) => l.exercise === e.id);
      if (!lift) entry.lifts.push((lift = { exercise: e.id, sets: [] }));
      lift.sets.push(...sets);
      saveDay(data, date);
      console.log(`${e.name}: ${fmtSets(lift.sets)}`);
      break;
    }
    case "undo": {
      const e = resolve(data.exercises, rest[0]);
      const entry = data.workouts[date];
      const lift = entry && entry.lifts.find((l) => l.exercise === e.id);
      if (!lift) throw new Error(`No ${e.name} logged on ${date}.`);
      lift.sets.pop();
      if (!lift.sets.length) entry.lifts = entry.lifts.filter((l) => l !== lift);
      saveDay(data, date);
      console.log(`${e.name}: ${lift.sets.length ? fmtSets(lift.sets) : "removed"}`);
      break;
    }
    case "cardio": {
      const [machine, minutes] = rest;
      if (!MACHINES.includes(machine)) throw new Error("Machine must be treadmill, bike or elliptical.");
      if (!(Number(minutes) > 0)) throw new Error("Minutes must be a number.");
      const entry = open();
      entry.cardio = Array.isArray(entry.cardio) ? entry.cardio : entry.cardio ? [entry.cardio] : [];
      entry.cardio.push({ machine, minutes: Number(minutes), ...(flags.notes ? { notes: flags.notes } : {}) });
      saveDay(data, date);
      console.log(`Cardio: ${entry.cardio.map((c) => `${c.minutes} min ${c.machine}`).join(" + ")}`);
      break;
    }
    case "note": {
      const entry = open();
      entry.notes = [entry.notes, rest.join(" ")].filter(Boolean).join(" ");
      saveDay(data, date);
      console.log(`Notes: ${entry.notes}`);
      break;
    }
    case "finish":
    case "skip":
    case "rest": {
      const status = { finish: "completed", skip: "skipped", rest: "rest" }[cmd];
      const entry = data.workouts[date] || (data.workouts[date] = { cardio: [], lifts: [] });
      if (status === "completed" && !entry.lifts.length && !(entry.cardio || []).length) throw new Error("Nothing logged today. Use skip or rest instead.");
      if (status === "completed") { entry.day = entry.day || planFor(date).day; entry.finished = now; }
      if (status !== "completed" && !entry.day) entry.day = planFor(date).day;   // the day that was skipped
      entry.status = status;
      saveDay(data, date);
      const next = writeState(addDays(date, 1));
      if (status === "completed") console.log(summarize(data, date), "\n");
      console.log(`Up next:\n${formatPlan(next, data)}`);
      break;
    }
    case "summary":
      console.log(summarize(data, date));
      break;
    case "find": {
      const found = findExercises(data.exercises, rest.join(" "));
      console.log(found.length ? found.map((e) => `${e.id}  (${e.name}, ${data.program.slots[e.slot].name})`).join("\n") : "No matches.");
      break;
    }
    case "add-exercise": {
      const e = JSON.parse(rest.join(" "));
      e.id = e.id || e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      e.secondary = e.secondary || [];
      e.type = e.type || "isolation";
      e.reps = e.reps || [8, 12];
      e.increment = e.increment || 5;
      e.custom = true;
      data.exercises.exercises.push(e);
      const prefs = data.preferences;
      if (flags.rank) {
        prefs.rankings = prefs.rankings || {};
        const list = (prefs.rankings[e.slot] = prefs.rankings[e.slot] || []);
        if (flags.rank === "first") list.unshift(e.id); else list.push(e.id);
      }
      if (flags.request !== undefined) takeRequest(prefs, flags.request);
      const problems = validate(data);
      if (problems.length) throw new Error(problems.join("\n"));
      writeJson("exercises.json", data.exercises);
      if (flags.rank || flags.request !== undefined) writeJson("preferences.json", prefs);
      console.log(`Added ${e.id} (${e.name}) to ${data.program.slots[e.slot].name}${flags.rank ? `, ranked ${flags.rank}` : ""}.`);
      break;
    }
    case "requests": {
      const list = data.preferences.requests || [];
      console.log(list.length ? list.map((r, i) => `${i}. "${r.text}" (asked ${r.at.slice(0, 10)})`).join("\n") : "No lift requests.");
      break;
    }
    case "drop-request": {
      const r = takeRequest(data.preferences, rest[0]);
      writeJson("preferences.json", data.preferences);
      console.log(`Cleared request "${r.text}".`);
      break;
    }
    case "validate": {
      const problems = validate(data);
      console.log(problems.length ? problems.join("\n") : "All good.");
      if (problems.length) process.exitCode = 1;
      break;
    }
    case "save": {
      const problems = validate(data);
      if (problems.length) throw new Error("Not saving, fix these first:\n" + problems.join("\n"));
      const git = (...a) => execFileSync("git", a, { cwd: ROOT, stdio: "pipe" }).toString();
      git("add", "-A");
      if (!git("status", "--porcelain").trim()) { console.log("Nothing to save."); break; }
      git("commit", "-m", rest.join(" ") || `Log ${date}`);
      for (let i = 0; ; i++) {
        try { git("pull", "--rebase", "origin", "main"); git("push", "origin", "HEAD:main"); break; }
        catch (err) { if (i >= 3) throw err; execFileSync("sleep", [String(2 ** (i + 1))]); }
      }
      console.log("Saved.");
      break;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 18).join("\n"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
