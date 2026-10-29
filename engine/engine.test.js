import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlan, analyze, e1rm, weekStart, addDays, localDate, weightTrend } from "./engine.js";
import { load, parseSets, validate, findExercises, catchUp } from "./cli.js";

// The repo's own files, minus Alex's rankings so the tests don't change when he ranks lifts
const loaded = load();
const base = { ...loaded, preferences: { ...loaded.preferences, rankings: {}, never: [], requests: [] } };
const run = (workouts, preferences = base.preferences, date = "2026-11-02") =>
  computePlan({ ...base, preferences, workouts, date });
const done = (day, lifts = [], extra = {}) => ({ status: "completed", day, lifts, cardio: [], ...extra });
const lift = (exercise, ...sets) => ({ exercise, sets: sets.map(([weight, reps]) => ({ weight, reps })) });

test("the repo's own data is valid", () => {
  assert.deepEqual(validate(loaded), []);
});

test("rotation starts on push and only moves on completed workouts", () => {
  assert.equal(run({}).day, "push");
  assert.equal(run({ "2026-11-01": done("push") }).day, "pull");
  assert.equal(run({ "2026-10-31": done("push"), "2026-11-01": { status: "skipped", day: "pull" } }).day, "pull");
  assert.equal(run({ "2026-10-31": done("pull"), "2026-11-01": { status: "rest" } }).day, "legs");
  assert.equal(run({ "2026-11-01": done("legs") }).day, "push");
});

test("a skip is mentioned in the plan", () => {
  const plan = run({ "2026-10-30": done("push"), "2026-10-31": { status: "skipped", day: "pull" }, "2026-11-01": { status: "skipped", day: "pull" } });
  assert.equal(plan.day, "pull");
  assert.match(plan.notes.join(" "), /2 skipped/);
});

test("a workout in progress keeps its day, and a finished one plans the next", () => {
  const w = { "2026-11-01": done("push"), "2026-11-02": { status: "in_progress", day: "legs", lifts: [] } };
  assert.equal(run(w).day, "legs");
  w["2026-11-02"].status = "completed";
  assert.equal(run(w).day, "push");
});

test("always 25 minutes of cardio, on the least used machine", () => {
  const plan = run({
    "2026-10-30": done("push", [], { cardio: [{ machine: "treadmill", minutes: 25 }] }),
    "2026-11-01": done("pull", [], { cardio: [{ machine: "bike", minutes: 25 }] }),
  });
  assert.equal(plan.cardio.minutes, 25);
  assert.equal(plan.cardio.machine, "elliptical");
});

test("5 lifts from the day's slots, no repeats", () => {
  const plan = run({});
  assert.equal(plan.lifts.length, 5);
  assert.deepEqual(plan.lifts.slice(0, 4).map((l) => l.slot), ["h_press", "v_press", "chest_acc", "triceps"]);
  assert.equal(new Set(plan.lifts.map((l) => l.exercise)).size, 5);
  assert.equal(plan.lifts[0].exercise, "bench-press");
  assert.equal(plan.lifts[3].exercise, "tricep-pushdown");
});

test("4 lifts when the last two sessions of that day ran long", () => {
  const long = (d) => done("push", [], { started: `${d}T17:00:00Z`, finished: `${d}T18:30:00Z` });
  const w = { "2026-10-20": long("2026-10-20"), "2026-10-23": done("pull"), "2026-10-26": long("2026-10-26"), "2026-10-29": done("pull"), "2026-10-30": done("legs") };
  const plan = run(w);
  assert.equal(plan.day, "push");
  assert.equal(plan.lifts.length, 4);
});

test("rankings win, then what you actually log", () => {
  let plan = run({}, { ...base.preferences, rankings: { h_press: ["db-bench-press", "bench-press"] } });
  assert.equal(plan.lifts[0].exercise, "db-bench-press");
  assert.match(plan.lifts[0].why, /#1/);

  // Logged machine press several times without ranking anything: it learns
  const w = {};
  ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"].forEach((d) => { w[d] = done("push", [lift("machine-chest-press", [150, 10])]); });
  w["2026-10-27"] = done("pull"); w["2026-10-28"] = done("legs");
  plan = run(w);
  assert.equal(plan.lifts[0].exercise, "machine-chest-press");
  assert.match(plan.lifts[0].why, /logged 4×/);
});

test("lifts on the never list are not suggested", () => {
  const plan = run({}, { ...base.preferences, never: ["bench-press"] });
  assert.notEqual(plan.lifts[0].exercise, "bench-press");
  assert.equal(plan.lifts[0].slot, "h_press");
});

test("accessories rotate after two sessions in a row", () => {
  const w = {
    "2026-10-20": done("push", [lift("tricep-pushdown", [50, 12])]), "2026-10-21": done("pull"), "2026-10-22": done("legs"),
    "2026-10-23": done("push", [lift("tricep-pushdown", [50, 12])]), "2026-10-24": done("pull"), "2026-10-25": done("legs"),
  };
  const triceps = run(w, base.preferences, "2026-10-26").lifts.find((l) => l.slot === "triceps");
  assert.notEqual(triceps.exercise, "tricep-pushdown");
});

test("double progression: up a step after hitting the top of the range", () => {
  const w = { "2026-10-30": done("push", [lift("bench-press", [185, 10], [185, 10], [185, 10])]), "2026-10-31": done("pull"), "2026-11-01": done("legs") };
  const bench = run(w).lifts.find((l) => l.exercise === "bench-press");
  assert.equal(bench.weight, 190);

  w["2026-10-30"] = done("push", [lift("bench-press", [185, 9], [185, 8], [185, 7])]);
  const same = run(w).lifts.find((l) => l.exercise === "bench-press");
  assert.equal(same.weight, 185);
  assert.match(same.note, /185 × 9, 8, 7/);
});

test("lower body goes up 10 lb", () => {
  const w = { "2026-10-30": done("pull"), "2026-11-01": done("legs", [lift("back-squat", [225, 8], [225, 8], [225, 8])]), "2026-11-02": done("push"), "2026-11-03": done("pull") };
  const squat = run(w, base.preferences, "2026-11-04").lifts.find((l) => l.exercise === "back-squat");
  assert.equal(squat.weight, 235);
});

test("weights ease back about 10% after a week off", () => {
  const w = { "2026-10-20": done("legs"), "2026-10-19": done("push", [lift("bench-press", [200, 8], [200, 8])]) };
  const plan = run(w, base.preferences, "2026-10-30");
  assert.equal(plan.lifts.find((l) => l.exercise === "bench-press").weight, 180);
  assert.match(plan.notes.join(" "), /lighter/);
});

test("the flex slot goes to the weakest muscle once there's 2 weeks of history", () => {
  // Lots of chest and triceps, no side delts: push's flex slot should be lateral raises
  const w = {};
  ["2026-10-12", "2026-10-15", "2026-10-18", "2026-10-21", "2026-10-24", "2026-10-27", "2026-10-30"].forEach((d, i) => {
    w[d] = done(["push", "pull", "legs"].at(i % 3), i % 3 ? [] : [lift("bench-press", [185, 8], [185, 8], [185, 8]), lift("tricep-pushdown", [50, 12], [50, 12], [50, 12])]);
  });
  w["2026-10-31"] = done("pull"); w["2026-11-01"] = done("legs");
  const plan = run(w);
  const flex = plan.lifts.find((l) => l.flex);
  assert.equal(flex.slot, "side_delts");
  assert.match(flex.why, /side delts/);
});

test("a rest day is suggested after 6 training days in a row", () => {
  const w = {};
  for (let i = 1; i <= 6; i++) w[addDays("2026-11-02", -i)] = done(["push", "pull", "legs"].at(i % 3));
  assert.match(run(w).notes.join(" "), /rest day/);
});

test("analysis: volume, PRs and weak areas", () => {
  const w = {
    "2026-10-26": done("push", [lift("bench-press", [185, 8], [185, 8], [185, 8])]),
    "2026-11-01": done("push", [lift("bench-press", [190, 8])]),
  };
  const a = analyze({ ...base, workouts: w, date: "2026-11-02" });
  const chest = a.volume.find((v) => v.muscle === "chest");
  assert.equal(chest.avgWeekly, 1);
  assert.equal(chest.status, "low");
  assert.equal(a.strength["bench-press"].length, 2);
  assert.equal(a.strength["bench-press"][1].pr, true);
  assert.equal(a.strength["bench-press"][1].e1rm, Math.round(e1rm(190, 8) * 10) / 10);
  assert.ok(a.weakAreas.some((x) => x.kind === "volume" && x.muscle === "lats"));
  assert.equal(a.weekly.at(-1).week, "2026-11-02");
});

test("analysis flags a stalled lift and push/pull imbalance", () => {
  const w = {};
  ["2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01"].forEach((d, i) => {
    w[d] = done("push", [lift("bench-press", [i === 0 ? 200 : 195, 5], [195, 5], [195, 5]), lift("incline-db-press", [70, 10], [70, 10], [70, 10])]);
  });
  const a = analyze({ ...base, workouts: w, date: "2026-11-02" });
  assert.ok(a.weakAreas.some((x) => x.kind === "stall" && x.exercise === "bench-press"));
  assert.ok(a.weakAreas.some((x) => x.kind === "imbalance"));
});

test("dates and set parsing", () => {
  assert.equal(weekStart("2026-11-01"), "2026-10-26");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(localDate("America/Chicago", new Date("2026-10-28T03:00:00Z")), "2026-10-27");
  assert.deepEqual(parseSets(["185x8"]), [{ weight: 185, reps: 8 }]);
  assert.equal(parseSets(["185x8x3"]).length, 3);
  assert.deepEqual(parseSets(["185x8,7"]).map((s) => s.reps), [8, 7]);
  assert.deepEqual(parseSets(["bwx10", "bw+25x6"]), [{ weight: 0, reps: 10 }, { weight: 25, reps: 6 }]);
  assert.throws(() => parseSets(["eight reps"]));
  assert.deepEqual(findExercises(base.exercises, "incline db press").map((e) => e.id), ["incline-db-press"]);
});

test("body weight: a 7-day average trend and its change", () => {
  const bw = { "2026-01-01": 190, "2026-01-03": 188, "2026-01-08": 186, "2026-01-31": 182, "2026-02-07": 181 };
  const t = weightTrend(bw);
  assert.deepEqual(t.points.map((p) => p.trend), [190, 189, 187, 182, 181]);   // 01-08 averages 01-03 and 01-08 only
  assert.equal(t.latest.weight, 181);
  assert.equal(t.change7, -1);
  assert.equal(t.change30, -6);   // vs 01-08, the last point at least 30 days back
  assert.equal(weightTrend({}).latest, null);
  assert.equal(weightTrend(bw, "2026-01-03").points.length, 2);
  assert.ok(validate({ ...base, bodyweight: { "2026-01-01": "heavy" } }).some((p) => p.includes("bodyweight")));
});

test("days with no reply become skips, and the rotation stays put", () => {
  const data = { ...base, workouts: {
    "2026-11-01": done("push"),
    "2026-11-02": { status: "in_progress", day: "pull", lifts: [lift("lat-pulldown", [120, 10])], cardio: [] },   // never said finished
    "2026-11-03": { status: "in_progress", day: "legs", lifts: [], cardio: [] },                               // opened, nothing logged
  } };
  const filled = catchUp(data, "2026-11-06");
  assert.deepEqual(filled, [
    { date: "2026-11-02", status: "completed" }, { date: "2026-11-03", status: "skipped" },
    { date: "2026-11-04", status: "skipped" }, { date: "2026-11-05", status: "skipped" },
  ]);
  assert.equal(data.workouts["2026-11-04"].day, "legs");
  assert.equal(data.workouts["2026-11-05"].auto, true);
  assert.equal(data.workouts["2026-11-06"], undefined);   // today is left alone
  assert.equal(computePlan({ ...data, date: "2026-11-06" }).day, "legs");
  assert.deepEqual(validate(data), []);
  assert.deepEqual(catchUp(data, "2026-11-06"), []);   // nothing left to do
  assert.deepEqual(catchUp({ ...base, workouts: {} }, "2026-11-06"), []);   // no history: nothing to fill
});
