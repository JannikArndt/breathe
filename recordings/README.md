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

| file | what it is |
|---|---|
| `tide-20260828T100652.json` | the first session, before the export carried raw motion |
| `breathe-20260829T001709.json` | 7:35 that worked well, labelled — derived channels only |
| `breathe-20260829T115717-bogus.json` | phone on a table, then waved by hand. Not breathing. The app once read 248 breaths at 26/min from it |
| `breathe-20260830T223632.json` | 9:32 at ~3 breaths/min with long holds, full raw motion. The recording that showed the baseline filter was turning a hold into a ramp |

Two of these are not a sample. Use them to find bugs, not to set constants — the
sensitivity control exists because where the line falls between a shallow breather and a
still phone depends on the body, and no two recordings can settle it.

Label a recording before exporting it. The first half-minute is always you getting
settled, and a `lay-down` marker is the difference between data that can be trusted and
data that has to be guessed at.

Nothing here is uploaded by the app. Committing a file is a deliberate act — a recording
is accelerometer data from a phone on someone's belly, so treat it as personal.
