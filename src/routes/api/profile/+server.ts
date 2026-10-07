import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { cleanName, getProfile, saveProfile, type Profile } from '$lib/server/listening';

/** A profile as its own account is sent it. The picture is fetched by the handle and its version. */
const view = (profile: Profile) => ({
	id: profile.handle,
	name: profile.name,
	shown: profile.shown,
	avatar: profile.avatarAt
});

/** What this account shows of itself to the others on this server; see `listening.ts`. */
export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const cfg = config();
	if (!cfg.listeners || !cfg.remoteControl) error(404, 'Not found');
	return json(view(await getProfile(session.account.id)));
};

/** Sets the display name, whether the account is shown, or both. A field left out keeps its value. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const cfg = config();
	if (!cfg.listeners || !cfg.remoteControl) error(404, 'Not found');

	const body = (await request.json().catch(() => null)) as { name?: unknown; shown?: unknown } | null;
	if (typeof body !== 'object' || body === null) error(400, 'Expected a JSON body');

	const patch: { name?: string | null; shown?: boolean } = {};
	if ('name' in body) {
		const name = cleanName(body.name);
		if (name === undefined) error(400, 'name must be a string or null');
		patch.name = name;
	}
	if ('shown' in body) {
		if (typeof body.shown !== 'boolean') error(400, 'shown must be a boolean');
		patch.shown = body.shown;
	}
	if (!('name' in patch) && !('shown' in patch)) error(400, 'name or shown is required');

	const saved = await saveProfile(session.account, patch);
	if (saved === 'name_taken') error(409, 'That is the user name of another account here.');
	return json(view(saved));
};
