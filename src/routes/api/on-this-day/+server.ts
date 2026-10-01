import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { onThisDay } from '$lib/server/history';

/** Albums on the home page's "On this day" shelf. */
const SHOWN = 12;

/**
 * The albums the account played on the browser's date in earlier years, from
 * this server's history alone. `date` is the browser's local date as
 * `YYYY-MM-DD`, and `offset` its time zone's minutes ahead of UTC, from -720
 * (UTC-12) to 840 (UTC+14). See `onThisDay`.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(url.searchParams.get('date') ?? '');
	const offset = Number(url.searchParams.get('offset'));
	if (!date || !Number.isInteger(offset) || offset < -720 || offset > 840) error(400, 'Invalid date or offset');
	const [year, month, day] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])];
	const check = new Date(Date.UTC(year, month, day));
	const valid = check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === day;
	// Within a year of the server's: each earlier year is a query.
	if (!valid || Math.abs(year - new Date().getUTCFullYear()) > 1) {
		error(400, 'Invalid date or offset');
	}

	return json({ albums: await onThisDay(session.account.id, { year, month, day }, offset, SHOWN) });
};
