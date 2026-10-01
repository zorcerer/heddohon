# Heddohon for the Linux desktop

A window around a Heddohon server you run. Nothing of the web app is in the
package: the first start asks for the server's address, checks that a Heddohon
answers there, and from then on the window shows that server. A server upgrade
needs no new app.

What it adds over a browser tab: a launcher entry, a window of its own, and
the desktop's media controls. Chromium's Media Session is MPRIS on Linux, so
media keys, the GNOME and KDE controls and `playerctl` work.

Each release of Heddohon carries an AppImage and a `.deb`, for x64 and arm64.
The app checks GitHub once per start for a newer release and lists it in its
menu (press Alt, then Heddohon). It does not update itself.

## Running it from here

```
npm install
npm start
```

## Tests

The suite drives the shell with Playwright against the built server and the
mock music servers in `../tests/e2e`. It needs a display, and a D-Bus session
for the media controls test, which is skipped without one.

```
(cd .. && npm ci && npm run build)
npm install
dbus-run-session -- xvfb-run -a npm test
```

`HEDDOHON_DESKTOP_BINARY=dist/linux-unpacked/heddohon` runs the same suite
against the packaged app, after `npm run dist`.

## What the window is allowed

- The page is remote, so it has no Node, runs sandboxed with context
  isolation, and the preload gives its two calls to the address screen only.
- The window stays on the server's origin. Any other address opens in the
  default browser.
- Permissions are granted to the server's origin only, and only the ones the
  player uses: media (to name audio outputs), choosing a speaker, full screen,
  writing to the clipboard, and keeping the screen awake.
