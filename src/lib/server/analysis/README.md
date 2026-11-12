# Sound analysis

Heddohon measures how each song sounds (loudness, tempo, key, and a vector
for "sounds like") once, on its own server, and shares the result between
accounts. The plan, its decisions and the measurements behind them are in
[#312](https://github.com/zorcerer/heddohon/issues/312). This file is the map
for working on the code.

It is being built a piece at a time. Nothing here runs unless a server turns
sound analysis on, and the played audio is never touched: the analysis reads
a decoded copy of an excerpt.

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

The four take what they need as arguments (samples, a stream, a file path, an
adapter), so each is tested by importing it directly, without starting the
app. Keep new pieces that way where they can be. Imports between files in
this folder name the file with its extension (`./features.ts`), which is what
lets Node run them as they are.

How a song flows through them:

```
source.songs()            every song the analysis account can see, with a file key
store.settled(song)       already measured for this file by this analysis? skip
source.audio(id)          the original bytes, as a stream
decodeExcerpt(stream)     90 s from 30 s in, mono, 22.05 kHz
analyse(samples, rate)    the numbers
store.put(song, numbers)  or store.fail(song, why)
```

## Running the tests

```bash
node --test tests/e2e/analysis-features.test.mjs   # the measurements, on signals with known answers
node --test tests/e2e/analysis-store.test.mjs      # analysis.db
node --test tests/e2e/analysis-decode.test.mjs     # the source and the decode
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
