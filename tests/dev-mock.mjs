/**
 * The app in development against the test suites' mock music servers, for
 * working on it without a Navidrome or a Jellyfin:
 *
 *   npm run dev:mock            # http://localhost:5173
 *   npm run dev:mock -- --host  # and on the local network
 *
 * Sign in to "Mock Navidrome" as testuser / testpass (an administrator, with a
 * library of 40 artists), or to "Mock Jellyfin" as jfuser / jfpass. Every
 * track plays 30 seconds of silence. The data directory is `.dev-mock-data`,
 * kept between runs; delete it to start again.
 *
 * The mocks are the ones in `tests/e2e/mocks.mjs`: what they answer is what
 * the suites expect, not a full music server, so a page can show less than a
 * real one would.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { silentWav, startJellyfin, startSubsonic } from './e2e/mocks.mjs';

const subsonic = await startSubsonic({ artistCount: 40 });
const jellyfin = await startJellyfin();
subsonic.state.audio = { type: 'audio/wav', body: silentWav(30) };
subsonic.state.albumSongs = 4;

const dataDir = '.dev-mock-data';
mkdirSync(dataDir, { recursive: true });

console.log(`
  Mock Navidrome  ${subsonic.url}  testuser / testpass
  Mock Jellyfin   ${jellyfin.url}  jfuser / jfpass
`);

const vite = spawn('npx', ['vite', 'dev', ...process.argv.slice(2)], {
	stdio: 'inherit',
	env: {
		...process.env,
		// Fixed, so sign-ins outlive a restart; this data directory holds nothing real.
		HEDDOHON_SECRET: 'dev-mock-secret-not-for-anything-real-0123456789',
		HEDDOHON_SUBSONIC_URL: subsonic.url,
		HEDDOHON_SUBSONIC_LABEL: 'Mock Navidrome',
		HEDDOHON_JELLYFIN_URL: jellyfin.url,
		HEDDOHON_JELLYFIN_LABEL: 'Mock Jellyfin',
		HEDDOHON_DATA_DIR: dataDir,
		// Over plain http on the network (`--host`) a Secure cookie would not be kept.
		HEDDOHON_COOKIE_SECURE: 'false',
		HEDDOHON_LOG_LEVEL: process.env.HEDDOHON_LOG_LEVEL ?? 'info'
	}
});

async function stop(code) {
	await Promise.all([subsonic.close(), jellyfin.close()]);
	process.exit(code);
}
vite.on('exit', (code) => void stop(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => vite.kill(signal));
