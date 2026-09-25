# What "high-resolution" can and cannot mean in a browser

[← back to the README](../README.md)

---

Heddohon does the parts it controls properly: the original bytes are streamed
end to end with no transcoding unless you ask for it, and playback runs through
a plain `HTMLAudioElement` rather than a Web Audio graph. An `AudioContext` would
resample everything to its own rate, silently turning a 24/192 master into
whatever the context happened to open at.

What no browser-based player can do is claim bit-perfect output. The browser
hands decoded audio to the operating system mixer, which resamples to whatever
rate the output device is currently set to. There is no exclusive-mode or
WASAPI-style path from a web page. If you want true bit-perfect playback, you
need a native client with exclusive device access; Heddohon will get you the
untouched file and an honest label of what it is, which is the most a browser
can offer.

Similarly, "gapless" here means a **tight handoff**, not true gapless decoding.
The next track is buffered into a second audio element while the current one
plays, so the join does not wait on the network. The switch still happens at
the `ended` event, and `HTMLAudioElement` cannot decode across a track boundary
sample-accurately. A continuous DJ mix may still show a seam. An earlier version
started the second element a fraction of a second early to close that seam; what
that actually produced was two tracks at full volume at once, which is why it is
gone.

## Transcoding

The default is the file as it sits on disk. Settings can ask the music server to
convert it instead, to MP3, Opus or AAC at a chosen bitrate, and the quality
badge in the player turns that on and off. What arrives is then what the music
server produced: the badge stops reporting the file's own depth and rate and
names the codec and bitrate instead, since a `FLAC 24/96` label over a 192kbps
MP3 would be the one part of the interface that lies.

The conversion happens on the music server. Navidrome needs a converter
configured for the format asked for, and Jellyfin needs ffmpeg; a server that
cannot produce what was asked for answers with an error rather than with the
original, and the player reports that it could not load the track. The bitrate
is a ceiling rather than a promise, because a server configured lower will send
less.

Switching either way re-opens the current track at the position it had reached,
which means a short gap while the new stream is fetched. The URL carries the
mode for a reason: a browser caches a stream response per URL, so without it the
original file, already fetched and held, would answer the first request made
after transcoding was switched on. The server decides what to send from the
account's stored settings and never from that value.

**Crossfade** is the mode that does overlap them, and it is opt-in. The two gains
are `cos` and `sin` of the same quarter turn, so the sum of their squares is
constant across the fade: a linear pair would sum to one in *amplitude* instead,
which dips about 3 dB in the middle and is heard as a hole rather than a join.
The ramp runs on an interval rather than `requestAnimationFrame`, which is
throttled to a stop in a background tab, which is where an unattended queue
does its crossfading. The ramp only moves the two gains; advancing the queue
stays the job of the outgoing element's `ended` event, so the two cannot race.

On an iPhone or iPad there is no crossfade. iOS leaves the level to the
hardware buttons and ignores a volume set by the page, so a ramp would start
the next track at full level over the end of the current one. The player
detects this and makes the tight handoff instead, and Settings says so under
the crossfade length. Volume normalisation and the sleep timer's fade work
through the same volume, and do nothing there either.

Codec support is the browser's: Chromium and Firefox decode FLAC and ALAC
natively; DSD is not supported by any browser and will not play.
