import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';

/** The Android app in `android/`, as its `applicationId`. */
const PACKAGE = 'app.heddohon.android';

/**
 * Digital Asset Links: this server vouching for the Android app.
 *
 * The app opens the server as a Trusted Web Activity, in the phone's browser,
 * which hides its address bar only when the site names the app: its package
 * and the SHA-256 of its signing certificate. Every Heddohon is a different
 * site, so each says it here.
 *
 * It grants this origin, shown by that app, without an address bar. The app
 * holds no session and reads nothing the browser does not show. It names the
 * released app's key (`ANDROID_RELEASE_KEY` in `config.ts`) and any in
 * `HEDDOHON_ANDROID_FINGERPRINTS`, for an app someone built and signed.
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
