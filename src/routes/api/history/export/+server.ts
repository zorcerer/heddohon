import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { EXPORT_FORMATS, exportHistory, type ExportFormat } from '$lib/server/historyexport';

/** The latest time a JavaScript date holds, in epoch millis. */
const LATEST = 8.64e15;

/** An epoch-millis bound from the query, or `fallback` where it is absent. */
function bound(value: string | null, fallback: number): number {
	if (value === null) return fallback;
	const at = Number(value);
	if (!/^\d{1,16}$/.test(value) || at > LATEST) error(400, 'from and to must be epoch milliseconds');
	return at;
}

/**
 * The account's listening history as a download: `format` is `csv` or `json`
 * (ListenBrainz listens), and `from` and `to` (epoch millis, `to` excluded)
 * narrow it to a range. The browser works the range out from the dates picked,
 * in its own time zone. See `historyexport.ts`.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	const session = locals.session;
	if (!session) error(401, 'Not signed in');

	const format = url.searchParams.get('format') ?? 'csv';
	if (!EXPORT_FORMATS.includes(format as ExportFormat)) error(400, `format must be one of ${EXPORT_FORMATS.join(', ')}`);
	const from = bound(url.searchParams.get('from'), 0);
	const to = bound(url.searchParams.get('to'), LATEST);
	if (from >= to) error(400, 'from must be before to');

	const body = exportHistory(session.account.id, format as ExportFormat, from, to);

	const day = new Date().toISOString().slice(0, 10);
	return new Response(body, {
		headers: {
			'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="heddohon-listening-${day}.${format}"`,
			'cache-control': 'private, no-store'
		}
	});
};
