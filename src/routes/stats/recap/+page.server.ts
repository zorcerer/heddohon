import type { PageServerLoad } from './$types';
import { historySpan, listeningStats } from '$lib/server/history';

/**
 * A recap of a calendar year (`?year=2025`) or a month of one
 * (`?year=2025&month=10`), the current year unless asked, against the year
 * or month before. The bounds are in UTC, as the stats page's "This year" is:
 * the server does not know the listener's time zone. Read from this server's
 * database alone.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const accountId = locals.session!.account.id;
	const now = new Date();
	const asked = (name: string, low: number, high: number) => {
		const value = Number(url.searchParams.get(name));
		return url.searchParams.has(name) && Number.isInteger(value) && value >= low && value <= high ? value : null;
	};
	const year = asked('year', 1970, 9999) ?? now.getUTCFullYear();
	// 1 to 12 in the address, 0 to 11 as `Date` counts them.
	const month = asked('month', 1, 12);
	const index = month === null ? null : month - 1;

	const from = index === null ? Date.UTC(year, 0, 1) : Date.UTC(year, index, 1);
	const to = index === null ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, index + 1, 1);
	const previous = index === null ? Date.UTC(year - 1, 0, 1) : Date.UTC(year, index - 1, 1);

	const [stats, span] = await Promise.all([
		listeningStats(accountId, from, { from: previous, to: from }, to),
		historySpan(accountId)
	]);
	const years: number[] = [];
	if (span) for (let y = new Date(span.last).getUTCFullYear(); y >= new Date(span.first).getUTCFullYear(); y--) years.push(y);
	return { year, month, from, to, stats, years, now: now.getTime() };
};
