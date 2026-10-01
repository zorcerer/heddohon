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

Each release of Heddohon carries `heddohon-<version>.apk`, signed with the
release key. Obtainium can install it from the releases page and keep it up
to date. It is not on the Play Store.

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
