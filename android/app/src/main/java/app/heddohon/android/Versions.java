package app.heddohon.android;

/** Version numbers as Heddohon's releases write them: `0.5.0`, with or without a `v`. Plain Java, for the tests. */
final class Versions {
	private Versions() {}

	/** Whether `candidate` is a later release than `current`, by their first three numbers. */
	static boolean newer(String candidate, String current) {
		int[] a = parts(candidate);
		int[] b = parts(current);
		for (int i = 0; i < 3; i++) {
			if (a[i] != b[i]) return a[i] > b[i];
		}
		return false;
	}

	/** A release's version, or false for anything that is not three numbers: a build without one is `0.0.0`. */
	static boolean isRelease(String version) {
		int[] numbers = parts(version);
		return version != null && version.replaceFirst("^v", "").matches("\\d+\\.\\d+\\.\\d+.*") && (numbers[0] | numbers[1] | numbers[2]) != 0;
	}

	private static int[] parts(String version) {
		int[] numbers = new int[3];
		if (version == null) return numbers;
		String[] pieces = version.trim().replaceFirst("^v", "").split("[.-]");
		for (int i = 0; i < 3 && i < pieces.length; i++) {
			try {
				numbers[i] = Integer.parseInt(pieces[i]);
			} catch (NumberFormatException err) {
				numbers[i] = 0;
			}
		}
		return numbers;
	}
}
