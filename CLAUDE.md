# fitness-data

Alex's private workout log and the plan engine behind the daily workout session and the dashboard at alexanderk.dev/private/fitness-tracking. This repo is private: never copy its data into any public repo, issue, or page.

## Files

- `program.json`: Push/Pull/Legs rotation, the lift slots for each day, volume targets.
- `exercises.json`: the lift catalog. Each lift has one `slot`.
- `preferences.json`: Alex's rankings per slot and "never" list, edited from the dashboard. Timezone and cardio target. `requests`: lifts Alex typed into the dashboard's "Add a lift" box, waiting for a session to add them.
- `workouts/<year>.json`: one entry per date: `status` (`in_progress`, `completed`, `skipped`, `rest`), `day`, `started`, `finished`, `cardio` (list of `{machine, minutes, notes?}`), `lifts` (list of `{exercise, sets: [{weight, reps}]}`), `recommended`, `notes`. Weights in lb; bodyweight is 0 (or the added weight).
- `state.json`: the next session's plan, written on finish, skip and rest.
- `engine/engine.js`: plan and analysis logic (pure, also loaded by the dashboard). `engine/cli.js`: the commands below.

## Running the daily session

Always use the CLI rather than editing workout JSON by hand, and run `node engine/cli.js save "<what changed>"` after every change so nothing is lost if the session ends early. `save` validates, commits and pushes to main.

1. `git pull`, then `node engine/cli.js plan`. If it lists lift requests, handle each one first. A request is free text from Alex (e.g. "landmine press, love it for shoulders"). Work out the lift's name, slot, main and helper muscles, type, rep range and increment. Add it with `add-exercise '<json>' --request N`, and add `--rank first` if Alex says it's a favorite or asks for it to be suggested. If it's already in the catalog, or it's a variation of one that's there, use `drop-request N` instead, and rank the existing lift if that's what Alex wanted. Requests are numbered, and the numbers shift as you clear them, so run `requests` again between clears. Then `save`, run `plan` again (the new lift can change it), and tell Alex in one line per request what you added and where.
2. Post the plan to Alex: the day and number, 25 min cardio and the suggested machine, each lift with sets × reps @ weight and its one-line note. Keep it skimmable on a phone.
3. As Alex reports sets, in any wording and in any batch size, turn them into commands:
   - `node engine/cli.js log <lift-id> <sets...>`: `185x8` (one set), `185x8x3` (three sets of 8), `185x8,7,6` (three sets), `bwx10`, `bw+25x6`.
   - `node engine/cli.js cardio <treadmill|bike|elliptical> <minutes> [--notes "..."]`
   - `node engine/cli.js note "..."` for anything else worth keeping (pain, energy, gym crowded).
   - `node engine/cli.js undo <lift-id>` to drop the last set, then re-log the right numbers for corrections.
   - Use `node engine/cli.js find <words>` to get a lift id. If several match, pick the one that fits what Alex said (e.g. "bench" alone means `bench-press`); ask only if it's truly unclear.
   - A lift that isn't in the catalog: add it with `node engine/cli.js add-exercise '{"name":"...","slot":"...","primary":[...],"secondary":[...],"type":"compound|isolation","reps":[8,12],"increment":5}'` (slots and muscles are listed in program.json; lower-body compounds use increment 10), tell Alex which slot you filed it under, then log it.
   - Then `save`, and reply with one short line confirming what was recorded (e.g. "Bench: 185 × 8, 7, 7"). Don't re-post the whole plan.
4. "finished" / "done": `node engine/cli.js finish`, `save`, and reply with the summary it prints (new bests, volume vs last time, cardio vs 25 min) and what's up next.
5. "skipped": `node engine/cli.js skip`. "rest": `node engine/cli.js rest`. Then `save`. The rotation doesn't move, so the same day stays up next; say so in one line.
6. If Alex asks to change a lift (its slot, muscles, rep range), edit it in `exercises.json`, run `validate`, then `save`. If it moved slots, take it out of its old slot's ranking in `preferences.json`.
7. If Alex gives a date ("log yesterday's legs"), add `--date YYYY-MM-DD` to every command.

Never invent sets Alex didn't report. If a message is ambiguous (e.g. weight missing), ask before logging.

## Tests

`node --test` (Node 20+, no install). Run it after changing anything in `engine/`.
