# Heddohon for Android (experimental)

A window around a Heddohon server you run. Nothing of the web app is in the
package: the first start asks for the server's address, checks that a
Heddohon answers there, and from then on the app opens that server.

It opens it as a **Trusted Web Activity**: the page runs in the phone's own
browser, full screen. Playback with the screen off, the media notification,
the lock-screen controls and the codecs are the browser's, the same as in a
tab. A WebView would stop the audio soon after the app left the screen.

- **https only.** A plain http address is turned down with a message.
- **The address bar.** The browser hides it only for a server that vouches
  for the app: `/.well-known/assetlinks.json`, naming this package and the
  key the app is signed with. Heddohon 0.5.0 and later serves that file for
  the released app. An older server, or an app signed with another key,
  still opens, in a Custom Tab with the address bar showing.
- **A browser is needed** that supports Trusted Web Activities: Chrome, Edge,
  Samsung Internet, Brave. With none, the server opens in whatever browser
  there is.
- **Changing the server.** Press and hold the app's icon and choose Change
  server.
- **A sign-in in front of the server** (Authelia, Authentik, Cloudflare
  Access, basic auth). The app cannot tell whether a Heddohon is behind it,
  says so, and offers to open the address as it stands. The sign-in then
  happens in the browser, which keeps it. Custom request headers, such as a
  service token, are not possible here: the requests are the browser's, and
  an app cannot add headers to them.

Each release of Heddohon carries `heddohon-<version>.apk`, signed with the
release key. Obtainium can install it from the releases page and keep it up
to date. It is not on the Play Store.

The app is in no store, so it looks for a newer release itself: once a day,
when it is opened, it asks GitHub for Heddohon's latest release. When that is
later than the app, the next start says so once, with **Get it** opening the
releases page and **Later** carrying on to the server. It downloads and
installs nothing itself.

## Building it

Android SDK 36 and JDK 17 or later.

```
./gradlew testDebugUnitTest lintDebug assembleDebug
```

`app/build/outputs/apk/debug/app-debug.apk` is signed with the debug key of
the machine. For the address bar to go, give your server that key's
fingerprint:

```
keytool -list -v -keystore ~/.android/debug.keystore -storepass android | grep SHA256
HEDDOHON_ANDROID_FINGERPRINTS=AA:BB:...
```

A release build reads its key from the environment
(`HEDDOHON_ANDROID_KEYSTORE`, `HEDDOHON_ANDROID_KEYSTORE_PASSWORD`,
`HEDDOHON_ANDROID_KEY_ALIAS`), as the release workflow sets it.
