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

	/**
	 * `SIGN_IN` is a proxy in front of the server asking who is asking first
	 * (Authelia, Authentik, Cloudflare Access, basic auth). The app cannot
	 * answer it: the sign-in is the browser's, which keeps what it is given.
	 * So the address is offered as it stands, to be opened and signed in to
	 * there.
	 */
	enum Answer { HEDDOHON, SIGN_IN, NOT_HEDDOHON, UNREACHABLE }

	private Server() {}

	static String saved(Context context) {
		return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
	}

	static void save(Context context, String origin) {
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, origin).apply();
	}

	/**
	 * What an answer to `/healthz` says: a redirect, a 401 or a 403 is how a
	 * proxy that authenticates answers someone it does not know.
	 */
	static Answer classify(int status, String body) {
		if ((status >= 300 && status < 400) || status == 401 || status == 403) return Answer.SIGN_IN;
		if (status != 200 || body == null) return Answer.NOT_HEDDOHON;
		return body.replace(" ", "").contains("\"status\":\"ok\"") ? Answer.HEDDOHON : Answer.NOT_HEDDOHON;
	}

	/** Whether `/healthz` says ok and there is a manifest. Call off the main thread. */
	static Answer check(String origin) {
		try {
			Reply health = get(origin + "/healthz");
			Answer answer = classify(health.status, health.body);
			if (answer != Answer.HEDDOHON) return answer;
			return get(origin + "/manifest.webmanifest").status == 200 ? Answer.HEDDOHON : Answer.NOT_HEDDOHON;
		} catch (IOException err) {
			return Answer.UNREACHABLE;
		}
	}

	private static final class Reply {
		final int status;
		final String body;

		Reply(int status, String body) {
			this.status = status;
			this.body = body;
		}
	}

	/** The status, and the body of a 200 up to `MAX_BODY` bytes. Redirects are not followed. */
	private static Reply get(String address) throws IOException {
		HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
		try {
			connection.setConnectTimeout(TIMEOUT_MS);
			connection.setReadTimeout(TIMEOUT_MS);
			connection.setInstanceFollowRedirects(false);
			connection.setRequestProperty("Accept", "application/json, */*");
			int status = connection.getResponseCode();
			if (status != 200) return new Reply(status, null);
			try (InputStream in = connection.getInputStream()) {
				ByteArrayOutputStream out = new ByteArrayOutputStream();
				byte[] buffer = new byte[1024];
				int read;
				while (out.size() < MAX_BODY && (read = in.read(buffer)) != -1) out.write(buffer, 0, read);
				return new Reply(200, new String(out.toByteArray(), StandardCharsets.UTF_8));
			}
		} finally {
			connection.disconnect();
		}
	}
}
