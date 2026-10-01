package app.heddohon.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class AddressTest {
	@Test
	public void aBareHostIsHttps() {
		assertEquals("https://music.example.com", Address.parse("music.example.com").origin);
		assertEquals("https://music.example.com:8443", Address.parse(" music.example.com:8443/albums ").origin);
	}

	@Test
	public void aPathAndAQueryAreDropped() {
		assertEquals("https://music.example.com", Address.parse("https://Music.Example.com/albums?page=2#top").origin);
		assertEquals("https://music.example.com", Address.parse("https://music.example.com:443/").origin);
	}

	@Test
	public void plainHttpIsTurnedDownAsSuch() {
		Address typed = Address.parse("http://192.168.1.10:13000");
		assertNull(typed.origin);
		assertEquals(Address.Problem.NEEDS_HTTPS, typed.problem);
	}

	@Test
	public void whatIsNotAnAddressIsTurnedDown() {
		for (String text : new String[] {"", "   ", "file:///etc/passwd", "javascript://alert(1)", "https://", "https://user:pass@music.example.com", "music example"}) {
			Address typed = Address.parse(text);
			assertNull(text, typed.origin);
			assertEquals(text, Address.Problem.NOT_AN_ADDRESS, typed.problem);
		}
	}
}
