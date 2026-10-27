# fitness-data

Private workout log and plan engine. A daily Claude session logs workouts here (see `CLAUDE.md`); the dashboard at alexanderk.dev/private/fitness-tracking reads it through the site's Worker.

- Push / Pull / Legs; the rotation only moves on a completed workout, so a skip or rest keeps the same day up next.
- Every session: 25 minutes of cardio (treadmill, bike or elliptical) and 4 to 5 lifts, chosen per slot by your rankings (`preferences.json`, editable on the dashboard) and by what you actually log.
- Weights and reps follow double progression from your last session of each lift.

`node engine/cli.js` lists the commands. `node --test` runs the tests.
