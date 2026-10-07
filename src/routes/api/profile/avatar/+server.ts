import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { jpegSize, MAX_AVATAR_BYTES, MAX_AVATAR_SIDE, setAvatar } from '$lib/server/listening';

/**
 * Sets this account's picture from the request's body: a JPEG of at most
 * `MAX_AVATAR_BYTES` and `MAX_AVATAR_SIDE` pixels a side. The browser sends
 * one it has cut square and scaled, and this route checks what it is sent
 * whoever made it.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const cfg = config();
	if (!cfg.listeners || !cfg.remoteControl) error(404, 'Not found');

	// Refused by its declared length before any of it is read.
	if (Number(request.headers.get('content-length') ?? 0) > MAX_AVATAR_BYTES) error(413, 'The picture is too large');
	const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
	if (bytes.length > MAX_AVATAR_BYTES) error(413, 'The picture is too large');

	const size = jpegSize(bytes);
	if (!size) error(400, 'The picture must be a JPEG');
	if (size.width > MAX_AVATAR_SIDE || size.height > MAX_AVATAR_SIDE) {
		error(400, `The picture may be at most ${MAX_AVATAR_SIDE} pixels a side`);
	}

	const profile = await setAvatar(session.account, bytes);
	return json({ id: profile.handle, avatar: profile.avatarAt });
};

/** Removes this account's picture. */
export const DELETE: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');
	const cfg = config();
	if (!cfg.listeners || !cfg.remoteControl) error(404, 'Not found');

	const profile = await setAvatar(session.account, null);
	return json({ id: profile.handle, avatar: profile.avatarAt });
};
