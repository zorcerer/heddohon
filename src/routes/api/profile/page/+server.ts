import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { destroyAllSessions } from '$lib/server/auth';
import { UpstreamError } from '$lib/server/backends';
import {
	cleanBio,
	FAVOURITE_SLOTS,
	makeProfileLink,
	MAX_BIO,
	ownPage,
	pageSettings,
	savePage,
	withdrawProfileLink
} from '$lib/server/profilepage';

/** This account's profile page and what it has chosen about it; see `profilepage.ts`. */
export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const [page, settings] = await Promise.all([ownPage(session.account.id), pageSettings(session.account.id)]);
	return json({ page, settings, maxBio: MAX_BIO });
};

/**
 * Changes the page: `bio` (a string or null), `albums` (four album ids or
 * nulls), and the switches `listed`, `recent` and `top`. A field left out
 * keeps its value.
 */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (typeof body !== 'object' || body === null) error(400, 'Expected a JSON body');

	const patch: Parameters<typeof savePage>[2] = {};
	if ('bio' in body) {
		// Over the cap by more than a little is not a typed bio.
		if (typeof body.bio === 'string' && body.bio.length > MAX_BIO * 4) error(400, `A bio is at most ${MAX_BIO} characters`);
		const bio = cleanBio(body.bio);
		if (bio === undefined) error(400, 'bio must be a string or null');
		patch.bio = bio;
	}
	if ('albums' in body) {
		const albums = body.albums;
		if (
			!Array.isArray(albums) ||
			albums.length !== FAVOURITE_SLOTS ||
			!albums.every((id) => id === null || (typeof id === 'string' && id.length > 0 && id.length < 256))
		) {
			error(400, `albums must be ${FAVOURITE_SLOTS} album ids or nulls`);
		}
		const ids = albums.filter((id): id is string => id !== null);
		if (new Set(ids).size !== ids.length) error(400, 'An album is on the page once');
		patch.albums = albums as (string | null)[];
	}
	for (const key of ['listed', 'recent', 'top'] as const) {
		if (key in body) {
			if (typeof body[key] !== 'boolean') error(400, `${key} must be a boolean`);
			patch[key] = body[key] as boolean;
		}
	}
	if (Object.keys(patch).length === 0) error(400, 'Nothing to change');

	try {
		const failed = await savePage(session.account, session.credential, patch);
		if (failed) return json({ error: 'That album is not in your library.', slot: failed.slot }, { status: 404 });
	} catch (err) {
		if (err instanceof UpstreamError) {
			// A rejected credential ends the sessions, as `library()` does.
			if (err.kind === 'auth') {
				await destroyAllSessions(session.account.id);
				error(401, 'Your music server credentials are no longer valid. Sign in again.');
			}
			error(502, 'The music server did not answer. Try again.');
		}
		throw err;
	}
	const [page, settings] = await Promise.all([ownPage(session.account.id), pageSettings(session.account.id)]);
	return json({ page, settings, maxBio: MAX_BIO });
};

/** Makes the public link, replacing the one there was. The token is in this answer alone. */
export const POST: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const token = await makeProfileLink(session.account);
	return json({ url: `${url.origin}/p/${token}`, settings: await pageSettings(session.account.id) });
};

/** Withdraws the public link. */
export const DELETE: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	await withdrawProfileLink(session.account.id);
	return json({ settings: await pageSettings(session.account.id) });
};
