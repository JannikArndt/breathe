# Recordings

Exported sessions go here.

On the phone: end a session, tap **Export** on the summary (or open a recording under
Adjust → Recordings and export it there). Safari saves the `.json` to Files. Drop it in
this folder and push, and the next session can read it directly.

Replay one through the tracker the app actually runs:

```bash
node tools/replay.mjs recordings/20260828T0730Z-a3f1.json
node tools/replay.mjs recordings/tide-sessions-20260828.json --session <id>
node tools/replay.mjs recordings/one.json --from 40 --to 200
```

## What is here

Three files, and each one is here for a reason that has not expired. Two others were
deleted: a session from before the app was renamed, and one whose raw motion the labelling
bug destroyed — neither could be replayed, and neither said anything the remaining three do
not say better.

| file | what it is | why it stays |
|---|---|---|
| `breathe-20260829T115717-bogus.json` | phone on a table, then waved by hand | The negative control, and the only one that cannot go out of date: a table is still a table. `tools/dsp-harness.mjs` replays it and asserts confidence stays under 0.35. Deleting it removes a check. |
| `breathe-20260830T223632.json` | 9:32 at ~3 breaths/min with long holds, **full raw motion** | The only recording with raw samples, so the only one `replay.mjs` and `onset.mjs` can say anything about. Four fixes came out of it: the baseline turning a hold into a ramp, the rest gate's reference, the period ceiling, and the audio's rate floor. |
| `breathe-20260831-0853.json` | 7:00 on 0.10.0, derived channels only | The evidence for the reward curve: it descends 6.2 → 2.5 breaths a minute over seven minutes and `rich` sat pinned at 1.00 for 86% of it. Carries the `rest` channel. Its raw motion was destroyed by the labelling bug. |

**What would be worth recording next:** one session on 0.12.0 or later, with the usable part
marked, exported *without* being labelled on an older version. Two of the three files above
have no raw motion, which means no future DSP change can be checked against them — only the
0830 session can do that, and it is one body on one evening.

Label a recording before exporting it. The first half-minute is always you getting
settled, and a `lay-down` marker is the difference between data that can be trusted and
data that has to be guessed at.

Nothing here is uploaded by the app. Committing a file is a deliberate act — a recording
is accelerometer data from a phone on someone's belly, so treat it as personal.
