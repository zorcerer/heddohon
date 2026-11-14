# Sound analysis

Heddohon measures how each song sounds (loudness, tempo, key, and a vector
for "sounds like") once, on its own server, and shares the result between
accounts. The plan, its decisions and the measurements behind them are in
[#312](https://github.com/zorcerer/heddohon/issues/312). This file is the map
for working on the code.

It is being built a piece at a time. Nothing here runs unless a server turns
sound analysis on, and the played audio is never touched: the analysis reads
a decoded copy of an excerpt.

## Turning it on and off

`HEDDOHON_ANALYSIS=true` in the environment, or the switch under Settings,
Server, Features (and the first-run setup), as for the other optional
features (`features.ts`). Set in the environment, it is decided there and the
switch is locked. Off:

- nothing of it runs, and `openSource` answers null;
- Settings shows no Sound analysis card, and naming an account is refused;
- an account already named stays sealed in `meta`, unused, and is still
  refused at sign-in;
- `analysis.db` stays where it is, and can be deleted.

New code that runs analysis work checks `config().analysis` first, or gets
its source from `openSource`, which does.

## The lines it stays inside

Heddohon is a player in front of the music server, and the analysis keeps to
that ([CONTRIBUTING](../../../../CONTRIBUTING.md), **What stays the music
server's**):

- It reads music through the music server's API, never from the music folder.
- It writes nothing to the library: tags and ReplayGain values stay the music
  server's.
- It stores numbers keyed by the server's song ids, and no titles.
- A result is shared by every account, but anything shown from it is looked up
  with the asking account's own login first.
- Everything it keeps can be deleted and made again.

## The pieces

| File | What it does | Imports the app's config |
| --- | --- | --- |
| `features.ts` | Samples in, numbers out: loudness, tempo, key, the vector. Pure. | no |
| `decode.ts` | A song's bytes to an excerpt of samples, through ffmpeg on a pipe. | no |
| `source.ts` | `AnalysisSource`: lists songs and reads one song's audio. Nothing else. | no |
| `store.ts` | `analysis.db`: one row a song, stale when the file or the analysis changes. | no |
| `account.ts` | The analysis account: kept sealed, checked, refused at sign-in. The only opener of its login. | yes |
| `queue.ts` | The job: what to measure next, the pace, pausing, the rule for listeners, the hours, the status. Everything it uses is passed in (`JobDeps`). | no |
| `worker.ts` | `analyse` in a worker thread, so a song's second of arithmetic never holds up a request. | no |
| `analyser.ts` | Starts that worker on first use, and again if it dies. | no |
| `job.ts` | The job as the server runs it: the app's parts given to `queue.ts`, its settings in `meta`, started and stopped with the server. | yes |

The four take what they need as arguments (samples, a stream, a file path, an
adapter), so each is tested by importing it directly, without starting the
app. Keep new pieces that way where they can be. Imports between files in
this folder name the file with its extension (`./features.ts`), which is what
lets Node run them as they are.

How a song flows through them, one at a time:

```
source.songs()            every song the analysis account can see, with a file key
store.settled(song)       already measured for this file by this analysis? skip
source.audio(id)          the original bytes, as a stream
decodeExcerpt(stream)     90 s from 30 s in, mono, 22.05 kHz
analyse(samples, rate)    the numbers
store.put(song, numbers)  or store.fail(song, why)
```

## The analysis account: rules not to break

The analysis runs with nobody's request behind it, so it reads the library as
an account of its own, which an administrator makes on the music server and
names under Settings, Server. [SECURITY.md](../../../../SECURITY.md), **Sound
analysis**, has the reasoning. In the code:

- **Only `account.ts` opens its login**, and only `openSource` does it, handing
  out an `AnalysisSource`. Do not export the credential, do not name the
  sealing purpose anywhere else, and do not build an `AnalysisSource` outside
  `account.ts`. `tests/e2e/analysis-account.test.mjs` fails if you do.
- **Do not give it a session**, a row in `accounts`, a token or a link. It is
  not a Heddohon account, and sign-in refuses it (`login/+page.server.ts`, and
  the Quick Connect poll). A new way of signing in has to refuse it too:
  check `isAnalysisAccount` before anything is stored.
- **Do not widen `AnalysisSource`.** Listing songs and reading one song's
  original bytes is all the analysis needs from the music server. Anything
  else it needs to show belongs to the asking account's own request.
- **What is shown is checked per account.** Results are shared; a song from
  them is looked up with the asking account's own login before it is shown.
- **Saving keeps the checks**: an administrator, an account that cannot play,
  one the server will not describe, and a name with a Heddohon account of its
  own are all refused.

## The job

`job.ts` starts it with the server (`init` in `hooks.server.ts`) and stops it
on shutdown. Each step looks, in order, at: the feature switch, `paused`, the
hours, whether anyone has listened in the last 60 seconds
(`listening-activity.ts`, noted by every route that sends a listener audio),
and whether an analysis account is named. Then it measures one song and
rests by its pace: `full` none, `gentle` as long as the song took, and
`background` up to 3 minutes a song.

States, as `status()` reports them and the log names them (`analysis-<state>`
when it changes): `off`, `no-account`, `listing`, `running`, `paused`,
`throttled` (someone listens), `outside-hours`, `done` (lists the library again
every 6 hours for new songs) and `stopped` (no ffmpeg, or the library would
not list; it tries again in 5 minutes). A song that fails is kept as failed
with its reason (`analysis-song-failed`) and the job goes on; a song whose
excerpt from 30 seconds in is empty, shorter than the music server reported,
is read once more from its start.

Settings call `wakeAnalysisJob` after a change that should be seen at once
(the feature switched, the account named or removed), so the job looks again
rather than finishing its rest.

### The worker in the build

A `worker_threads` worker runs a file, and the server is bundled into
`build/`. The `analysisWorker` plugin in `vite.config.ts` builds `worker.ts`
as `build/server/analysis-worker.js` and gives its address as
`import workerUrl from 'virtual:analysis-worker'`. In development the address
is `worker.ts` itself, which Node runs with its types stripped. So `worker.ts`
and what it imports use relative imports with the extension, and nothing that
needs the app's configuration.

## Running the tests

```bash
node --test tests/e2e/analysis-features.test.mjs   # the measurements, on signals with known answers
node --test tests/e2e/analysis-store.test.mjs      # analysis.db
node --test tests/e2e/analysis-decode.test.mjs     # the source and the decode
node --test tests/e2e/analysis-job.test.mjs        # the job, with stand-ins and a clock of its own
npm run build && node --test tests/e2e/analysis-account.test.mjs   # the account, against the built app
npm run build && node --test tests/e2e/analysis-run.test.mjs       # all of it in the built app, with ffmpeg and the worker
```

They need Node 22.18 or later, which runs TypeScript with its types stripped,
and skip on an older one. The decode tests need an ffmpeg: the one on your
path, or `HEDDOHON_TEST_FFMPEG=/path/to/ffmpeg`. `tests/docker/ffmpeg.sh`
builds the image's own, and leaves it at `HEDDOHON_FFMPEG_OUT` if that is
set. Without one the decode tests skip and say so.

## Changing a measurement

1. Change `features.ts`, and raise `FEATURES_VERSION`. Stored results from
   the earlier version then read as never measured, and are made again.
2. Add or adjust the known-answer test for it in
   `tests/e2e/analysis-features.test.mjs`. A measure is checked against a
   signal whose answer is known (a tone at a known level, a chord, clicks at a
   known tempo), not against another implementation.
3. If the vector's length changes, change `VECTOR_LENGTH` with it; the store
   refuses a vector of another length.
4. Say in the pull request what the change does on real music: #312 has the
   figures the current methods were chosen by.

`store.ts` has its own `SCHEMA_VERSION`. Raising it empties the table: the
file is disposable, so there are no migrations.

## The decoder

The image carries a static ffmpeg of about 3 MB with only the audio decoders
(the `ffmpeg` stage of the `Dockerfile`). A format it cannot read fails that
song with ffmpeg's own words, and the fix is adding its demuxer and decoder to
that stage's `--enable-` lists. Nothing about the music server reaches
ffmpeg's command line: the audio goes in on its standard input.
