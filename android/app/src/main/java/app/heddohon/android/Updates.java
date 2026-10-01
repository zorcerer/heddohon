package app.heddohon.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Whether a newer release of the app exists.
 *
 * The app is not in a store, so nothing tells the phone there is a newer
 * APK. Once a day, when the app is opened, it asks GitHub for Heddohon's
 * latest release and keeps the version. When that is later than this build,
 * the next start says so once, with the way to the release page; the app does
 * not download or install anything itself.
 *
 * What GitHub learns is the phone's address and that this app asked. A build
 * without a release version (`0.0.0`, from a checkout) does not ask.
 */
final class Updates {
	static final String RELEASES = "https://github.com/zorcerer/heddohon/releases/latest";
	private static final String LATEST = "https://api.github.com/repos/zorcerer/heddohon/releases/latest";
	private static final String PREFS = "heddohon";
	private static final String KEY_LATEST = "latest_version";
	private static final String KEY_CHECKED = "latest_checked_at";
	private static final String KEY_TOLD = "latest_told";
	private static final long DAY_MS = 24L * 60 * 60 * 1000;
	private static final int TIMEOUT_MS = 8000;
	/** The answer is about 5 KB of JSON, and the tag is near its start. */
	private static final int MAX_BODY = 64 * 1024;
	private static final Pattern TAG = Pattern.compile("\"tag_name\"\\s*:\\s*\"v?(\\d+\\.\\d+\\.\\d+)\"");

	private Updates() {}

	/** The later release this build has not said anything about yet, or null. */
	static String toAnnounce(Context context) {
		if (!Versions.isRelease(BuildConfig.VERSION_NAME)) return null;
		SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
		String latest = prefs.getString(KEY_LATEST, null);
		if (latest == null || !Versions.newer(latest, BuildConfig.VERSION_NAME)) return null;
		return latest.equals(prefs.getString(KEY_TOLD, null)) ? null : latest;
	}

	/** Said once per release, whichever button was pressed. */
	static void told(Context context, String version) {
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOLD, version).apply();
	}

	/** Asks GitHub in the background, at most once a day. The answer is for the next start. */
	static void checkSoon(Context context) {
		if (!Versions.isRelease(BuildConfig.VERSION_NAME)) return;
		Context app = context.getApplicationContext();
		SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
		long now = System.currentTimeMillis();
		if (now - prefs.getLong(KEY_CHECKED, 0) < DAY_MS) return;
		// Marked before the answer, so a phone that is offline asks again tomorrow and not at every start.
		prefs.edit().putLong(KEY_CHECKED, now).apply();
		Thread thread = new Thread(() -> {
			String latest = fetch();
			if (latest != null) prefs.edit().putString(KEY_LATEST, latest).apply();
		}, "heddohon-update-check");
		thread.setDaemon(true);
		thread.start();
	}

	private static String fetch() {
		HttpURLConnection connection = null;
		try {
			connection = (HttpURLConnection) new URL(LATEST).openConnection();
			connection.setConnectTimeout(TIMEOUT_MS);
			connection.setReadTimeout(TIMEOUT_MS);
			connection.setRequestProperty("Accept", "application/vnd.github+json");
			connection.setRequestProperty("User-Agent", "Heddohon-Android/" + BuildConfig.VERSION_NAME);
			if (connection.getResponseCode() != 200) return null;
			try (InputStream in = connection.getInputStream()) {
				ByteArrayOutputStream out = new ByteArrayOutputStream();
				byte[] buffer = new byte[4096];
				int read;
				while (out.size() < MAX_BODY && (read = in.read(buffer)) != -1) out.write(buffer, 0, read);
				Matcher tag = TAG.matcher(new String(out.toByteArray(), StandardCharsets.UTF_8));
				return tag.find() ? tag.group(1) : null;
			}
		} catch (Exception err) {
			return null;
		} finally {
			if (connection != null) connection.disconnect();
		}
	}
}
