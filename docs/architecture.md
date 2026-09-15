# Architecture

How the code is arranged, and one piece of upstream behaviour that shapes it.

[← back to the README](../README.md)

---

## Project layout

```
src/
  lib/
    server/
      config.ts           admin configuration, the only source of upstream URLs
      crypto.ts           AES-256-GCM sealing, session token digests
      auth.ts             sign-in, sessions, the 72-hour ceiling
      db.ts               SQLite schema and connection
      settings.ts         per-account preferences and persisted queue
      proxy.ts            range-aware media proxying
      covercache.ts       on-disk cover art, swept to a byte cap
      log.ts              levelled key=value logging, request ids
      library.ts          uniform upstream error handling for page loaders
      paging.ts           the 100-per-page slice shared by artists and favourites
      ratelimit.ts        sign-in throttling, per username and per address
      backends/
        types.ts          the MediaBackend contract
        http.ts           the one fetch every upstream call goes through
        subsonic.ts       Navidrome / Subsonic adapter
        jellyfin.ts       Jellyfin adapter
    client/
      player.svelte.ts    the playback engine
      artwork.ts          cover-art colour extraction for the glass tint
      ambience.svelte.ts  which cover the room takes its colour from
      lyrics.svelte.ts    lyrics state, fetching and line syncing
      playlists.svelte.ts the add-to-playlist picker's state
      sleeve-transition.svelte.ts  per-card transition tokens, both directions
      handoff.ts          moves focus when a control it was on goes away
      actions.ts          favourite and playlist calls shared by the pages
      format.ts           duration, quality and byte formatting
    components/
      Sleeve.svelte       the floating cover plate that morphs between pages
      LyricsView.svelte   lyrics in the player panel's stage
      QualityBadge.svelte what is being decoded, and the transcoding switch
      Pager.svelte        shared pagination control
      FeaturedRelease.svelte
      ...                 the rest of the UI
    styles/app.css        design tokens
  routes/
    api/                  stream, cover, lyrics, settings, playback, play-state,
                          songs, star, tracks, playlists
    login/, albums/, artists/, playlists/, favourites/, search/, settings/
  templates/              the Unraid Community Applications template
```

---

## Playlist editing, and one wrinkle in it

Creating, renaming, deleting and adding tracks map cleanly onto both APIs.
Removal does not, and the difference is worth knowing about if you read the code:

- **Subsonic** removes by zero-based index within the playlist.
- **Jellyfin** removes by an opaque per-entry id that only exists on the playlist
  listing, not on the track itself.

Heddohon's interface therefore removes **by position**, which is the only identity
both servers agree on. The Jellyfin adapter resolves positions to entry ids with
a fresh read of the playlist. Song id would have been the obvious third option and
is the wrong one: the same track can legitimately appear twice in a playlist, so
"remove this song" is ambiguous in a way that "remove the third entry" is not.

Renaming on Jellyfin uses `POST /Playlists/{id}`, which needs a reasonably current
server (10.9 or newer). Older versions will report the rename as failed while the
rest of the editing still works.
