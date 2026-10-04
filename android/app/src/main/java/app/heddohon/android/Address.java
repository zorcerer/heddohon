package app.heddohon.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * The server address someone typed, read as an origin. Plain Java, so the
 * rules are tested without a device.
 */
final class Address {
	/** What went wrong with an address, for the message under the field. */
	enum Problem { NOT_AN_ADDRESS, NEEDS_HTTPS }

	final String origin;
	final Problem problem;

	private Address(String origin, Problem problem) {
		this.origin = origin;
		this.problem = problem;
	}

	/**
	 * `music.example.com` is read as https. A path, a query and a fragment are
	 * dropped: the app opens the server, not a page of it. Anything but https
	 * is refused: a Trusted Web Activity is for a secure origin, and on plain
	 * http the browser shows its address bar and a warning.
	 */
	static Address parse(String typed) {
		String text = typed == null ? "" : typed.trim();
		if (text.isEmpty()) return new Address(null, Problem.NOT_AN_ADDRESS);
		// `host:8443/x` is a host and a port, not a scheme called `host`.
		boolean hasScheme = text.matches("(?i)^[a-z][a-z0-9+.-]*://.*");
		URI uri;
		try {
			uri = new URI(hasScheme ? text : "https://" + text);
		} catch (URISyntaxException err) {
			return new Address(null, Problem.NOT_AN_ADDRESS);
		}
		String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
		String host = uri.getHost();
		if (host == null || host.isEmpty() || uri.getUserInfo() != null) return new Address(null, Problem.NOT_AN_ADDRESS);
		if (scheme.equals("http")) return new Address(null, Problem.NEEDS_HTTPS);
		if (!scheme.equals("https")) return new Address(null, Problem.NOT_AN_ADDRESS);
		int port = uri.getPort();
		String origin = "https://" + host.toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
		return new Address(origin, null);
	}
}
