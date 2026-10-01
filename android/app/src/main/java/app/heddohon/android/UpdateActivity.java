package app.heddohon.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;

/**
 * Says, once per release, that a newer APK exists. Get it opens the release
 * page in the browser; Later carries on to the server. Either way the same
 * release is not mentioned again.
 */
public class UpdateActivity extends Activity {
	static final String VERSION = "version";

	@Override
	protected void onCreate(Bundle state) {
		super.onCreate(state);
		String version = getIntent().getStringExtra(VERSION);
		if (version == null) {
			finish();
			return;
		}
		setContentView(R.layout.update);
		((TextView) findViewById(R.id.update_title)).setText(getString(R.string.update_title, version));
		((TextView) findViewById(R.id.update_body)).setText(getString(R.string.update_body, BuildConfig.VERSION_NAME));
		Updates.told(this, version);

		findViewById(R.id.update_get).setOnClickListener((view) -> {
			try {
				startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(Updates.RELEASES)));
			} catch (ActivityNotFoundException err) {
				// No browser: nothing to open it with, and the server could not be opened either.
			}
			finish();
		});
		findViewById(R.id.update_later).setOnClickListener((view) -> {
			startActivity(new Intent(this, MainActivity.class));
			finish();
		});
	}
}
