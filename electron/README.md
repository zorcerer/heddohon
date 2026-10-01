# Heddohon for the Linux desktop

A window around a Heddohon server you run. Nothing of the web app is in the
package: the first start asks for the server's address, checks that a Heddohon
answers there, and from then on the window shows that server. A server upgrade
needs no new app.

What it adds over a browser tab: a launcher entry, a window of its own, and
the desktop's media controls. Chromium's Media Session is MPRIS on Linux, so
media keys, the GNOME and KDE controls and `playerctl` work.

Each release of Heddohon carries an AppImage and a `.deb`, for x64 and arm64.
The app asks GitHub once per start for the latest release. A newer one is
said once in a dialog, with **Get it** opening its page, and stays listed in
the menu (press Alt, then Heddohon). The app does not update itself.
`HEDDOHON_DESKTOP_NO_UPDATE_CHECK=1` in its environment stops it asking.

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

## A sign-in in front of the server

A server behind a proxy that asks who you are first (Authelia, Authentik,
oauth2-proxy, Cloudflare Access, basic auth) is reached three ways.

- **Its sign-in pages are shown in the window.** An origin the server, or
  another sign-in page, redirects the window to is treated as a sign-in page,
  and the window may move between those and back. The cookie the proxy sets is
  kept in the app's profile, so the next start is signed in for as long as the
  proxy keeps it. A link on one of the server's own pages to anywhere else
  still opens in the default browser. **View, Go to the server** (Alt+Home)
  is the way back from a sign-in page that led somewhere else. An identity
  provider that refuses embedded browsers (Google's sign-in does) cannot be
  used this way.
- **Request headers**, under "A sign-in in front of the server" at the
  address screen, one `Name: value` to a line, up to ten. They are sent with
  every request to the server's address and to no other: a service token, for
  a proxy that takes one in place of a sign-in (Cloudflare Access's
  `CF-Access-Client-Id` and `CF-Access-Client-Secret`, or a header your proxy
  checks). They are kept sealed with the desktop's keyring where there is one,
  and otherwise in the profile's `config.json`, which only its owner can
  read. `Host`, `Cookie` and the headers the browser owns cannot be set.
- **Basic auth** is asked for in a prompt. The name and password go to the
  server and are not kept by the app, so they are asked for at each start.

An address is saved only once a Heddohon has answered behind the sign-in.
Until then its page is given no permissions.
