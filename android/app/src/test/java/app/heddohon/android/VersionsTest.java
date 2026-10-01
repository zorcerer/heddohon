package app.heddohon.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class VersionsTest {
	@Test
	public void aLaterReleaseIsNewer() {
		assertTrue(Versions.newer("0.5.1", "0.5.0"));
		assertTrue(Versions.newer("v0.10.0", "0.9.9"));
		assertTrue(Versions.newer("1.0.0", "0.99.99"));
	}

	@Test
	public void theSameOrAnEarlierOneIsNot() {
		assertFalse(Versions.newer("0.5.0", "0.5.0"));
		assertFalse(Versions.newer("0.4.1", "0.5.0"));
		assertFalse(Versions.newer("not a version", "0.5.0"));
		assertFalse(Versions.newer(null, "0.5.0"));
	}

	@Test
	public void aBuildWithoutAVersionIsNotARelease() {
		assertTrue(Versions.isRelease("0.5.0"));
		assertTrue(Versions.isRelease("v1.2.3"));
		assertFalse(Versions.isRelease("0.0.0"));
		assertFalse(Versions.isRelease("dev"));
		assertFalse(Versions.isRelease(null));
	}
}
