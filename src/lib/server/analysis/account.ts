/**
 * The account sound analysis reads the library as (issue #317, part of #312).
 *
 * An administrator makes an ordinary account for it on the music server and
 * gives its name and password here, under Settings, Server. It is not a
 * Heddohon account, and in Heddohon it can do one thing: be read by the
 * analysis, through an `AnalysisSource`, which lists songs and reads audio.
 *
 * - **Kept apart.** Its login is a row in `meta`, sealed with a key of its own
 *   purpose (`PURPOSE`), not a row in `accounts`. It never makes a session,
 *   and nothing that takes a session's credential can be given it.
 * - **Opened in one place.** `openSource` below is the only reader of the
 *   sealed login, and hands out an `AnalysisSource`, never the credential.
 *   `tests/e2e/analysis-account.test.mjs` fails if another module names the
 *   purpose.
 * - **Not for signing in.** Signing in to Heddohon with its name is refused at
 *   the sign-in form before the music server is asked, with the answer a
 *   wrong password gets, so the form does not say which name it is
 *   (`login/+page.server.ts`); and after the music server answers, for Quick
 *   Connect (`isAnalysisAccount`).
 * - **Dedicated.** A name that has a Heddohon account already is refused, so
 *   it has no sessions, tokens, shared links or single sign-on link to
 *   inherit, and a name that is the analysis account cannot gain them later.
 * - **Little it may do.** On saving, the music server is asked what the
 *   account may do: an administrator is refused, as is an account that may
 *   not play, or one the server will not say about; anything beyond listing
 *   and playing is named for the administrator to take away.
 *
 * What Heddohon cannot stop is that account signing in to the music server's
 * own interface, or another app, with its password. Settings says so, and
 * offers a long random password, made in the browser, which is kept only
 * sealed here once saved.
 *
 * Recorded in SECURITY.md, Sound analysis, with invariants 2 and 10.
 */
import { accountIdByName } from '../auth';
import { backendFor, UpstreamError, type AccountRights, type StoredCredential } from '../backends';
import { config } from '../config';
import { openJson, sealJson } from '../crypto';
import { store } from '../db';
import { log } from '../log';
import { foldName } from '../names';
import { sourceFor, type AnalysisSource } from './source.ts';
import type { BackendKind } from '#lib/types.ts';

/** The sealing purpose of the analysis account's login. Named nowhere else. */
const PURPOSE = 'analysis-account';
const KEY = (kind: BackendKind) => `analysis-account:${kind}`;

/** What is kept in `meta`: who the account is in the clear, its login sealed. */
interface Kept {
	username: string;
	sealed: string;
	savedBy: string;
	savedAt: number;
	extra: string[];
}

/** What Settings shows of the account. Never the password or a token. */
export interface AnalysisAccountStatus {
	username: string;
	savedBy: string;
	savedAt: number;
	/** What the music server said it may do beyond listing and playing, when it was saved. */
	extra: string[];
}

/** Why an account was not taken, in words for the administrator. */
export class AnalysisAccountRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AnalysisAccountRefused';
	}
}

async function kept(kind: BackendKind): Promise<Kept | null> {
	const row = await (await store()).get<{ value: string }>('SELECT value FROM meta WHERE key = ?', KEY(kind));
	if (!row) return null;
	try {
		return JSON.parse(row.value) as Kept;
	} catch {
		return null;
	}
}

/**
 * Whether `username` is the analysis account on `kind`, matched as the music
 * servers match names. Asked whether or not analysis is on: a saved account
 * stays refused at sign-in while the feature is off.
 */
export async function isAnalysisAccount(kind: BackendKind, username: string): Promise<boolean> {
	const account = await kept(kind);
	return account !== null && foldName(account.username) === foldName(username);
}

export async function analysisAccountStatus(kind: BackendKind): Promise<AnalysisAccountStatus | null> {
	const account = await kept(kind);
	return account && { username: account.username, savedBy: account.savedBy, savedAt: account.savedAt, extra: account.extra };
}

/**
 * Signs in to the music server as the account, checks what it may do, and
 * keeps its login sealed. Throws `AnalysisAccountRefused` with what to change.
 */
export async function saveAnalysisAccount(kind: BackendKind, username: string, password: string, by: string): Promise<AnalysisAccountStatus> {
	if (!config().analysis) throw new AnalysisAccountRefused('Sound analysis is off on this server.');
	const name = username.trim();
	if (!name || !password) throw new AnalysisAccountRefused('Give the account\'s name and password.');
	if (await accountIdByName(kind, name)) {
		throw new AnalysisAccountRefused(
			`${name} has signed in to Heddohon, so it has settings, sign-ins and perhaps links of its own. Make an account on the music server for the analysis alone.`
		);
	}

	const backend = backendFor(kind);
	let credential: StoredCredential;
	try {
		({ credential } = await backend.login(name, password));
	} catch (err) {
		if (err instanceof UpstreamError && err.kind === 'auth') throw new AnalysisAccountRefused('The music server did not accept that name and password.');
		throw new AnalysisAccountRefused('The music server could not be asked. Try again shortly.');
	}

	let rights: AccountRights;
	try {
		rights = await backend.accountRights(credential);
	} catch {
		throw new AnalysisAccountRefused('The music server would not say what the account may do, so it cannot be checked.');
	}
	if (rights.admin !== false) {
		throw new AnalysisAccountRefused(
			rights.admin
				? 'That account administers the music server. Give the analysis an ordinary account: it only lists songs and plays them.'
				: 'The music server would not say whether that account is an administrator, so it cannot be checked.'
		);
	}
	if (rights.stream === false) throw new AnalysisAccountRefused('The music server does not let that account play audio, which the analysis needs.');

	const account: Kept = {
		username: credential.username,
		sealed: sealJson(credential, PURPOSE),
		savedBy: by,
		savedAt: Date.now(),
		extra: rights.extra
	};
	await (await store()).run(
		'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
		KEY(kind),
		JSON.stringify(account)
	);
	log.warn('analysis-account-saved', { backend: kind, username: account.username, by, extra: account.extra.join(',') || 'none' });
	return { username: account.username, savedBy: by, savedAt: account.savedAt, extra: account.extra };
}

export async function removeAnalysisAccount(kind: BackendKind, by: string): Promise<void> {
	const account = await kept(kind);
	await (await store()).run('DELETE FROM meta WHERE key = ?', KEY(kind));
	if (account) log.warn('analysis-account-removed', { backend: kind, username: account.username, by });
}

/**
 * The library as the analysis account reads it, or null: analysis off, no
 * account saved, or a login that no longer opens (the secret changed). The
 * only reader of the sealed login, for the analysis job.
 */
export async function openSource(kind: BackendKind): Promise<AnalysisSource | null> {
	if (!config().analysis) return null;
	const account = await kept(kind);
	if (!account) return null;
	let credential: StoredCredential;
	try {
		credential = openJson<StoredCredential>(account.sealed, PURPOSE);
	} catch {
		log.error('analysis-account-unreadable', { backend: kind, username: account.username });
		return null;
	}
	return sourceFor(backendFor(kind), credential);
}
