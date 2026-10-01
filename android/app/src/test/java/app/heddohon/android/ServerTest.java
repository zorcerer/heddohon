package app.heddohon.android;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ServerTest {
	@Test
	public void aHeddohonSaysOk() {
		assertEquals(Server.Answer.HEDDOHON, Server.classify(200, "{\"status\":\"ok\",\"version\":\"0.5.0\"}"));
		assertEquals(Server.Answer.HEDDOHON, Server.classify(200, "{ \"status\": \"ok\" }"));
	}

	@Test
	public void aProxyThatAsksWhoIsAskingIsASignIn() {
		for (int status : new int[] {301, 302, 303, 307, 401, 403}) {
			assertEquals(String.valueOf(status), Server.Answer.SIGN_IN, Server.classify(status, null));
		}
	}

	@Test
	public void anythingElseIsNotAHeddohon() {
		assertEquals(Server.Answer.NOT_HEDDOHON, Server.classify(200, "<html>"));
		assertEquals(Server.Answer.NOT_HEDDOHON, Server.classify(200, "{\"status\":\"down\"}"));
		assertEquals(Server.Answer.NOT_HEDDOHON, Server.classify(404, null));
		assertEquals(Server.Answer.NOT_HEDDOHON, Server.classify(500, null));
	}
}
