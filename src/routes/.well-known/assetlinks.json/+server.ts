import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';

/** The Android app in `android/`, as its `applicationId`. */
const PACKAGE = 'app.heddohon.android';

/**
 * Digital Asset Links: this server vouching for the Android app.
 *
 * The app opens the server as a Trusted Web Activity, in the phone's own
 * browser. The browser hides its address bar only when the site it shows
 * names the app: its package, and the SHA-256 of the certificate it is signed
 * with. Every Heddohon is a different site, so each has to say it, and it is
 * said here so that nobody running one has to.
 *
 * What it grants is that: this origin, shown by that app, without an address
 * bar. The app holds no session and reads nothing the browser does not show.
 * It names the key the released app is signed with (`ANDROID_RELEASE_KEY` in
 * `config.ts`) and any others in `HEDDOHON_ANDROID_FINGERPRINTS`, for an app
 * someone built and signed themselves.
 *
 * Public, like the manifest: the browser fetches it without cookies.
 */
export const GET: RequestHandler = () => {
	const statements = [
		{
			relation: ['delegate_permission/common.handle_all_urls'],
			target: {
				namespace: 'android_app',
				package_name: PACKAGE,
				sha256_cert_fingerprints: config().androidFingerprints
			}
		}
	];
	return new Response(JSON.stringify(statements), {
		headers: {
			'content-type': 'application/json',
			// Changes only with the configuration, which takes a restart.
			'cache-control': 'public, max-age=3600'
		}
	});
};
