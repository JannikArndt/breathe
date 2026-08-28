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

Label a recording before exporting it. The first half-minute is always you getting
settled, and a `lay-down` marker is the difference between data that can be trusted and
data that has to be guessed at.

Nothing here is uploaded by the app. Committing a file is a deliberate act — a recording
is accelerometer data from a phone on someone's belly, so treat it as personal.
