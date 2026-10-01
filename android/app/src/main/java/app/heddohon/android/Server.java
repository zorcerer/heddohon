package app.heddohon.android;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** The saved server, and the check that a Heddohon answers at an address. */
final class Server {
	private static final String PREFS = "heddohon";
	private static final String KEY = "server";
	private static final int TIMEOUT_MS = 8000;
	/** `/healthz` is a few dozen bytes. Nothing longer is read. */
	private static final int MAX_BODY = 4096;

	enum Answer { HEDDOHON, NOT_HEDDOHON, UNREACHABLE }

	private Server() {}

	static String saved(Context context) {
		return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
	}

	static void save(Context context, String origin) {
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, origin).apply();
	}

	/** Whether `/healthz` says ok and there is a manifest. Call off the main thread. */
	static Answer check(String origin) {
		try {
			String health = get(origin + "/healthz");
			if (health == null || !health.replace(" ", "").contains("\"status\":\"ok\"")) return Answer.NOT_HEDDOHON;
			return get(origin + "/manifest.webmanifest") == null ? Answer.NOT_HEDDOHON : Answer.HEDDOHON;
		} catch (IOException err) {
			return Answer.UNREACHABLE;
		}
	}

	/** The body of a 200, up to `MAX_BODY` bytes; null for any other status. Redirects are not followed. */
	private static String get(String address) throws IOException {
		HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
		try {
			connection.setConnectTimeout(TIMEOUT_MS);
			connection.setReadTimeout(TIMEOUT_MS);
			connection.setInstanceFollowRedirects(false);
			connection.setRequestProperty("Accept", "application/json, */*");
			if (connection.getResponseCode() != 200) return null;
			try (InputStream in = connection.getInputStream()) {
				ByteArrayOutputStream out = new ByteArrayOutputStream();
				byte[] buffer = new byte[1024];
				int read;
				while (out.size() < MAX_BODY && (read = in.read(buffer)) != -1) out.write(buffer, 0, read);
				return new String(out.toByteArray(), StandardCharsets.UTF_8);
			}
		} finally {
			connection.disconnect();
		}
	}
}
