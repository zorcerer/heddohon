# Architecture

How the code is arranged, what it is built with, and one piece of upstream
behaviour that shapes it.

[← back to the README](../README.md)

---

## Why SvelteKit and TypeScript

The repository does not record how the stack was first chosen. This section
records what the code relies on each of them for, so a proposal to replace
either one can be weighed against a list rather than a preference.

### SvelteKit

Heddohon needs a server process: the browser must never learn the music
server's address or credential, so every library call, stream and cover is made
by Node. SvelteKit puts that server and the pages it renders in one project,
one build and one process (`@sveltejs/adapter-node`, `node build/index.js`),
which keeps the deployment to one container and a volume.

What the code uses from it:

- **Server-only data loading.** Every route loads through `+page.server.ts` or
  `+layout.server.ts`; there is no `+page.ts` in the tree. The credential is
  opened in the loader and never serialised, and the browser receives only the
  data the page returns.
- **Server-side rendering with one hook around it.** `handle` in
  `src/hooks.server.ts` sees every request before any route: the config guard,
  the origin check, session resolution, the route gate and the response
  headers are each written once. `transformPageChunk` writes the account's
  theme and interface scale into the first byte of HTML, so there is no flash
  of the wrong theme.
- **Streamed promises.** The album and artist pages return their
  recommendation shelves as promises. SvelteKit sends the track list at once
  and the shelves down the same response when the music server answers, so a
  slow Last.fm lookup does not delay the page.
- **Form actions with progressive enhancement.** Sign-in and the settings
  forms work as plain HTML form posts and are enhanced with `use:enhance`.
- **Endpoints beside pages.** The JSON API and the media proxy are
  `+server.ts` files under the same router, behind the same hook.
- **A nonced Content-Security-Policy.** SvelteKit emits an inline bootstrap
  script in every page and adds the nonce for it when the policy is configured
  through the plugin (`csp` in `vite.config.ts`). That is what allows
  `script-src 'self'` without `unsafe-inline`.
- **Client-side navigation after the first load.** The player lives in the
  root layout, and navigating between pages does not reload the document, so
  playback continues across pages.

Svelte 5 compiles components to direct DOM updates, and runes (`$state`,
`$derived`, `$effect`) are forced on for every file in `src/`. Shared state
such as the player is a class in a `.svelte.ts` module rather than a store.
The client JavaScript for every route together is 263KB, 89KB gzipped, in 44
chunks, measured on the 0.2.0 build; a page loads only the chunks it uses.

What it has cost, from `SECURITY.md` and the release notes: SvelteKit's CSRF check
covers form content types only, so JSON writes needed an origin check of their
own; its trailing-slash redirects are answered before the hook and lack the
hardening headers; and Svelte rendered `onload` and `onerror` as inline
attributes, which the policy refused, until the listeners were attached from
script.

### TypeScript

`tsconfig.json` sets `strict`, and `npm run check` runs `svelte-check`, which
type-checks the `.svelte` templates as well as the `.ts` files and fails on any
warning. What the code relies on it for:

- **One contract for two music servers.** `MediaBackend` in
  `src/lib/server/backends/types.ts` is implemented by `subsonic.ts` and
  `jellyfin.ts`. A method added to the interface fails the check until both
  adapters implement it.
- **Credentials that cannot be mixed up.** `StoredCredential` is a union on
  `kind`: a Subsonic credential holds a password, a Jellyfin one a token and a
  user id. Code that reads a token has to have narrowed to Jellyfin first.
- **Allowlists that the types follow.** Values such as the transcode codecs are
  `as const` arrays, and the type is derived from the array, so the accepted
  values and the type cannot disagree.
- **Loader data typed into the page.** SvelteKit generates `./$types` for each
  route, so a page's `data` has the shape its loader returned, and a renamed
  field fails the check in the component that reads it.
- **Type-only imports across the server boundary.** Client code imports server
  types with `import type`, which is erased at build, while a value import from
  `$lib/server` into client code fails the build.

Type checking catches a contract broken at compile time. What the code does at
run time is covered by the HTTP and browser suites in `tests/`, which run the
built app against mock music servers (`npm run test:e2e` and
`npm run test:browser`, after `npm run build`).

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
      listings.ts         whole-library listings remembered per account for 30s
      ratelimit.ts        sign-in throttling, per username and per address
      shares.ts           song links: tokens, digests, expiry, withdrawal
      backends/
        types.ts          the MediaBackend contract
        http.ts           the one fetch every upstream call goes through
        subsonic.ts       Navidrome / Subsonic adapter
        navidrome.ts      Navidrome's own API: linking Last.fm and ListenBrainz
        jellyfin.ts       Jellyfin adapter
    client/
      player.svelte.ts    the playback engine
      artwork.ts          cover-art colour extraction for the glass tint
      ambience.svelte.ts  which cover the room takes its colour from
      lyrics.svelte.ts    lyrics state, fetching and line syncing
      playlists.svelte.ts the add-to-playlist picker's state
      share.svelte.ts     the share dialog's state, and withdrawing a link
      sleeve-transition.svelte.ts  per-card transition tokens, both directions
      handoff.ts          moves focus when a control it was on goes away
      actions.ts          favourite and playlist calls shared by the pages
      format.ts           duration, quality and byte formatting
    components/
      Sleeve.svelte       the floating cover plate that morphs between pages
      LyricsView.svelte   lyrics in the player panel's stage
      QualityBadge.svelte what is being decoded, and the transcoding switch
      Pager.svelte        shared pagination control
      FeaturedRelease.svelte the lead release on the home and artist pages
      MediaShelf.svelte   a numbered section of cards in one sideways line
      AlbumTile.svelte    an album at list size, for "Jump back in"
      ...                 the rest of the UI
    styles/app.css        design tokens
  routes/
    api/                  stream, cover, lyrics, settings, playback, play-state,
                          songs, star, tracks, playlists, shares
    login/, albums/, artists/, playlists/, favourites/, search/, settings/
    share/[token]/        a shared song, public; its own stream and cover routes
templates/                the Unraid Community Applications template
tests/
  e2e/                    HTTP suite; mock Subsonic and Jellyfin servers; app harness
  browser/                Chromium suite: console errors per page, the card play button
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

---

## Jellyfin's artist list

The artists page needs every album artist, and Jellyfin has an endpoint for
exactly that, `/Artists/AlbumArtists`, which Heddohon does not use.

Measured on Jellyfin 12.1.0 with 5000 album artists, it took 9.8 to 11.2
seconds per request whatever `Limit` was set to, including 100, and whichever
of the other parameters were dropped. Paging it would pay that once per page.
Heddohon used it with `Limit: 2000`, so on that library the artists page took
10.4 seconds and listed 2000 of the 5001 album artists.

`/Items` answers the same question in two parts: every `MusicArtist` (0.28s)
and every `MusicAlbum` (0.30 to 0.33s), in parallel. The artist list alone also
holds artists that only appear on tracks, such as a guest on one song or each
name on a compilation, so it is filtered down to the artists some album names
as an album artist. The same pass counts each artist's albums, which Jellyfin
does not report on an artist. The artists page now takes 496ms on that library
and lists all 5001, the same set `/Artists/AlbumArtists` returns.
