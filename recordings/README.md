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
| `breathe-20260829T001709.json` | 7:35 that worked well, labelled. Its raw motion was destroyed by the labelling bug below |
| `breathe-20260829T115717-bogus.json` | phone on a table, then waved by hand. Not breathing. The app once read 248 breaths at 26/min from it |
| `breathe-20260830T223632.json` | 9:32 at ~3 breaths/min with long holds, full raw motion. The recording that showed the baseline filter was turning a hold into a ramp, and the two constants set for someone breathing three times faster |
| `breathe-20260831-0853.json` | 7:00 on 0.10.0, labelled. Raw motion destroyed by the same bug |

**Every labelled recording in this folder has lost its raw motion, and the unlabelled one
has kept it.** That is not a coincidence: until 0.10.1, adding a label wrote the whole
recording back from the object on screen, and that object is fetched without the sample
channels because materialising tens of thousands of rows to draw a summary is not worth
the pause. So the one action taken to make a recording more useful was the action that
threw most of it away — silently, on disk, permanently. Two things stop it now: labelling
edits the metadata row and nothing else, and the store refuses any write that would replace
samples with nothing.

Two of these are not a sample. Use them to find bugs, not to set constants — the
sensitivity control exists because where the line falls between a shallow breather and a
still phone depends on the body, and no two recordings can settle it.

That said, the one real session with raw motion in it has now produced four fixes that
nothing else would have found: the baseline turning a hold into a ramp, the rest gate
comparing velocity against the wrong reference, a period ceiling that discarded its longest
breath, and an audio clamp that under-scaled every velocity-fed layer by a quarter at that
person's rate. Finding a bug in one recording and setting a threshold from one recording
are different things.

## Reading one

The `derived` block names its own columns, so read the index out of `columns` rather than
assuming a position — the list has grown. As of `breathe-session/1` with a `rest` channel
it is `t, s, level, phase, bpm, quality, rich, hr, hrConf, rest`. A recording made before a
column existed simply does not list it. `motion` is always `t, x, y, z` in m/s², at
whatever rate the device produced.

`rest` is the gate the audio engine multiplies velocity by: 1 while you are moving, 0 while
the app reads you as holding. Under 0.5 is what the summary, the review lanes and
`tools/onset.mjs` all call "held".

Label a recording before exporting it. The first half-minute is always you getting
settled, and a `lay-down` marker is the difference between data that can be trusted and
data that has to be guessed at.

Nothing here is uploaded by the app. Committing a file is a deliberate act — a recording
is accelerometer data from a phone on someone's belly, so treat it as personal.
