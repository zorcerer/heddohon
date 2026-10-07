# The Heddohon plugin for Navidrome

Navidrome tells this plugin of every track a user finishes, whichever app
played it, and the plugin tells Heddohon. With it:

- **Recently played and Your listening cover every app.** A play in Symfonium,
  DSub or Navidrome's own player is noted in Heddohon's history beside the
  plays made in Heddohon. A play made in Heddohon is noted once.
- **"Import play history" brings in every play.** Navidrome keeps a scrobble
  history that only a plugin can read. Without the plugin the import has one
  play per track, at the date it was last played.

It needs Navidrome 0.64 or later and a Heddohon that has
`HEDDOHON_NAVIDROME_PLUGIN_TOKEN` set.

## Install

1. **Choose a token**, at least 32 characters: `openssl rand -hex 32`. Set it
   as `HEDDOHON_NAVIDROME_PLUGIN_TOKEN` on the Heddohon server and restart it.
   It must not be the value of `HEDDOHON_SECRET`.
2. **Put `heddohon.ndp` in Navidrome's plugins folder**, which is `plugins`
   inside its data folder unless `Plugins.Folder` says otherwise. The file is
   attached to each Heddohon release. Keep the name: it is the plugin's id.
   Restart Navidrome, or run `navidrome plugin rescan`.
3. **In Navidrome, under Plugins, open Heddohon** and fill in:
   - **Heddohon address:** where Navidrome reaches Heddohon, such as
     `http://192.168.1.10:3000` or `https://music.example.com`.
   - **Plugin token:** the token from step 1.
   - **Heddohon's public address:** only where the address above is not the
     one Heddohon is opened at in a browser. Then it is the value of `ORIGIN`
     on the Heddohon server. Heddohon refuses a write that does not name its
     own address, and logs `cross-origin-blocked` with the address it expects.
4. **Choose the users** the plugin may act for, or all of them, and enable it.

From the command line the last two steps are:

```
navidrome plugin edit heddohon --all-users \
  --config '{"url":"http://192.168.1.10:3000","token":"<the token>"}'
navidrome plugin enable heddohon
```

Under Settings, Listening history, Heddohon then shows "Plays from other apps"
and says when the plugin has not been heard from in the last minute.

## Updating, and when nothing arrives

Navidrome turns a plugin off when its file changes. After replacing
`heddohon.ndp` with a newer one, enable it again under Plugins; its settings
are kept. A change made with `navidrome plugin` on the command line takes
effect when Navidrome restarts.

The plugin writes to Navidrome's log when Heddohon does not take a play, with
the status Heddohon answered:

- **401:** the token is not the value of `HEDDOHON_NAVIDROME_PLUGIN_TOKEN`.
- **403:** the address is not the one Heddohon knows itself by. Fill in
  "Heddohon's public address". Heddohon's log names the address it expects, in
  a `cross-origin-blocked` line, at `HEDDOHON_LOG_LEVEL=warn`.
- **404:** `HEDDOHON_NAVIDROME_PLUGIN_TOKEN` is not set on that Heddohon, or
  the address is another server's.
- **301, 302, 308:** the address redirects, usually from http to https. Give
  the address it redirects to; a redirect is not followed.

Navidrome keeps the plays meanwhile and sends them once the setting is right,
after up to 4 minutes.

## What it sends, and where

Only to the address in its settings, and it does not follow a redirect from
there:

- for each play Navidrome reports: the user name, the track's id and the time;
- every 15 seconds, a request with nothing in it, which Heddohon answers with
  the user names whose scrobble history it is waiting for;
- for such a user, that history: the track id and the time of each scrobble,
  1000 a request.

Heddohon looks each track up itself, as the account the play belongs to, and
drops a play for a user who has never signed in to it. A play Heddohon cannot
take while it is down is kept by Navidrome and sent again.

The permissions it asks Navidrome for are in `manifest.json`, each with its
reason. HTTP is asked for any host, since Heddohon is usually on a private
address, which Navidrome otherwise refuses a plugin.

What Heddohon does with a request, and what the token allows, is in
[`SECURITY.md`](../../SECURITY.md#plays-from-the-navidrome-plugin).

## Build

```
plugin/navidrome/build.sh
```

writes `heddohon.ndp` beside it, using TinyGo where it is installed and the
`tinygo/tinygo` image through Docker otherwise. `VERSION=1.2.3` sets the
version in the manifest.
