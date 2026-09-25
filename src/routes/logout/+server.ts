import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { destroySession } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies, url }) => {
	await destroySession({ cookies, url });
	redirect(303, '/login');
};
