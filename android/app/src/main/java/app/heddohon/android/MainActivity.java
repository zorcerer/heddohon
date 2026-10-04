package app.heddohon.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;

import com.google.androidbrowserhelper.trusted.TwaLauncher;

/**
 * Heddohon for Android: the server someone runs, opened as a Trusted Web
 * Activity.
 *
 * Nothing of the web app is in this package. The page runs in the phone's own
 * browser, full screen, so playback with the screen off, the media
 * notification, the lock-screen controls and the codecs are the browser's, as
 * in a tab. A WebView would stop the audio soon after the app left the screen.
 *
 * The browser hides its address bar only for a server that vouches for this
 * app: `/.well-known/assetlinks.json` on the server, naming this package and
 * its signing key, which Heddohon serves itself. A server that does not, or an
 * app built with another key, still opens, in a Custom Tab with the address
 * bar showing.
 */
public class MainActivity extends Activity {
	private TwaLauncher launcher;

	@Override
	protected void onCreate(Bundle state) {
		super.onCreate(state);
		String server = Server.saved(this);
		if (server == null) {
			startActivity(new Intent(this, SetupActivity.class));
			finish();
			return;
		}

		// A newer release found by an earlier start is mentioned once, before the
		// server opens. Later comes back here with it marked as told.
		String newer = Updates.toAnnounce(this);
		if (newer != null) {
			startActivity(new Intent(this, UpdateActivity.class).putExtra(UpdateActivity.VERSION, newer));
			finish();
			return;
		}
		Updates.checkSoon(this);

		int ground = getColor(R.color.ground);
		CustomTabColorSchemeParams colours =
				new CustomTabColorSchemeParams.Builder().setToolbarColor(ground).setNavigationBarColor(ground).build();
		// The query tells the page it is inside this app, so it does not offer the
		// app. The referrer says the same, and is replaced where a reverse proxy's
		// sign-in page comes first.
		Uri start = Uri.parse(server).buildUpon().path("/").appendQueryParameter("app", "android").build();
		TrustedWebActivityIntentBuilder builder = new TrustedWebActivityIntentBuilder(start).setDefaultColorSchemeParams(colours);
		try {
			launcher = new TwaLauncher(this);
			// Once the browser has it, this activity has nothing left to show.
			launcher.launch(builder, null, null, this::finish, TwaLauncher.CCT_FALLBACK_STRATEGY);
		} catch (RuntimeException err) {
			// No browser that can show a page at all.
			Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
			finish();
		}
	}

	@Override
	protected void onDestroy() {
		super.onDestroy();
		if (launcher != null) launcher.destroy();
	}
}
