/**
 * The days a listening chart shows, in this browser's time zone
 * (`ListeningCharts.svelte`). Its own module, with no imports, so
 * `tests/e2e/period-days.test.mjs` runs it in a time zone of its choosing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const dayStart = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate());
export const nextDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);

/**
 * The first day of a period that starts at `from` and was read at `to`, as
 * a date: the period's length in whole days counted back from `to`'s date.
 *
 * Not `from`'s own date. The server takes the last 30 days as `to` less 30
 * times 24 hours (`periodStart` in `history.ts`), and a 25-hour day at the
 * end of summer time inside them moved that an hour later: between 23:00
 * and midnight it fell on the next date, and the chart showed 30 days. A
 * 23-hour day did the opposite after midnight, and it showed 32 (#341).
 *
 * Only for a period of whole days (30 or 90). The year starts at a fixed
 * moment, 1 January in UTC, and keeps that moment's date. `from` of 0 is
 * everything kept, which starts at the first play, `first`.
 */
export function firstDay(from: number, to: number, first: Date): Date {
	if (from <= 0) return dayStart(first);
	const span = (to - from) / DAY_MS;
	if (!Number.isInteger(span)) return dayStart(new Date(from));
	const end = dayStart(new Date(to));
	return new Date(end.getFullYear(), end.getMonth(), end.getDate() - span);
}

/** Every date from the period's first day to `to`'s, stepped by the date: a day is 23 or 25 hours at a clock change. */
export function periodDays(from: number, to: number, first: Date): Date[] {
	const days: Date[] = [];
	const end = dayStart(new Date(to));
	for (let at = firstDay(from, to, first); at <= end; at = nextDay(at)) days.push(at);
	return days;
}
