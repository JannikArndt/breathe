# Recordings

Exported sessions go here.

**Working on the signal chain? Read `CLAUDE.md` in this folder first.** It says what
each file has already proved, what has been measured from it, and which constants were
set against which recording. This page is only about getting a session off a phone and
into the repository.

## Getting one here

On the phone: end a session, tap **Export** on the summary, or open a recording under
Recordings on the home screen and export it there. Safari saves the `.json` to Files.
Drop it in this folder and push, and the next session can read it directly.

## Reading one back

```bash
node tools/analyze.mjs recordings/breathe-20260903-2033.json   # describe it
node tools/replay.mjs  recordings/breathe-20260903-2033.json   # re-run the tracker
node tools/onset.mjs   recordings/breathe-20260903-2033.json   # timing against the body
node tools/replay.mjs  bundle.json --session <id>              # an "Export all" file
node tools/replay.mjs  s.json --from 40 --to 200               # one stretch
```

`replay.mjs` and `onset.mjs` import the tracker that ships, so they measure the code
that actually runs. That is the point of recording: an algorithm change can be checked
against real breathing instead of synthetic tilt.

## What is here

Fourteen sessions, thirteen of them with full raw 60 Hz motion. The table in
`CLAUDE.md` says what each one is and why it stays. In short: one negative control
(a phone on a table, then waved), a handful of short sessions that pin down settling
and axis direction, and seven real breathing sessions from one body.

There is no labelling and no trim any more. The tracker finds the usable stretch
itself — `onset.mjs` derives it from `Breath.settled` and confidence over 0.45, and it
comes out better than the hand-marked interval did. **Do not label a recording before
exporting it.** Older versions of this page told you to, and on older builds that is
what destroyed the raw motion of `breathe-20260831-0853.json`.

## Privacy

Nothing here is uploaded by the app, and nothing here should leave the repository.
Committing a file is a deliberate act — a recording is accelerometer data from a phone
on someone's belly, so treat it as personal.
