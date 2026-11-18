/**
 * The days the listening charts show around a clock change (#341), run in
 * Europe/Amsterdam whatever the machine's own time zone: Node reads `TZ`
 * again when it changes.
 *
 *   node --test tests/e2e/period-days.test.mjs
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.TZ = 'Europe/Amsterdam';

const typescript = Boolean(process.features.typescript);
const skip = typescript ? false : `Node ${process.version} does not strip TypeScript types (22.18 and later do)`;
const { periodDays } = typescript ? await import('../../src/lib/client/period-days.ts') : {};

const DAY_MS = 24 * 60 * 60 * 1000;
/** As `periodStart` in `history.ts` takes the last 30 or 90 days. */
const days = (period, to) => periodDays(to - period * DAY_MS, to, new Date(to));
const local = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

describe('the days of the last 30 and 90 days', { skip }, () => {
	test('are 31 at 23:30 after summer time ends inside them', () => {
		// 3 November 2026, 23:30 in Amsterdam (UTC+1); summer time ended on 25 October.
		const shown = days(30, Date.parse('2026-11-03T22:30:00Z'));
		assert.equal(shown.length, 31, `${local(shown[0])} to ${local(shown.at(-1))}`);
		assert.equal(local(shown[0]), '2026-10-04');
		assert.equal(local(shown.at(-1)), '2026-11-03');
	});

	test('are 31 at 00:30 after summer time starts inside them', () => {
		// 5 April 2026, 00:30 in Amsterdam (UTC+2); summer time started on 29 March.
		const shown = days(30, Date.parse('2026-04-04T22:30:00Z'));
		assert.equal(shown.length, 31, `${local(shown[0])} to ${local(shown.at(-1))}`);
		assert.equal(local(shown[0]), '2026-03-06');
		assert.equal(local(shown.at(-1)), '2026-04-05');
	});

	test('are 91 for the quarter across a clock change, and 31 on an ordinary day', () => {
		assert.equal(days(90, Date.parse('2026-11-03T22:30:00Z')).length, 91);
		assert.equal(days(30, Date.parse('2026-07-15T10:00:00Z')).length, 31);
	});

	test('the year starts on 1 January, at any hour', () => {
		for (const to of ['2026-11-03T22:30:00Z', '2026-11-03T23:30:00Z', '2026-04-04T22:30:00Z']) {
			const shown = periodDays(Date.UTC(2026, 0, 1), Date.parse(to), new Date(to));
			assert.equal(local(shown[0]), '2026-01-01', `read at ${to}`);
		}
	});

	test('start at the first play when everything kept is shown', () => {
		const first = new Date(Date.parse('2026-07-01T10:00:00Z'));
		const shown = periodDays(0, Date.parse('2026-07-03T10:00:00Z'), first);
		assert.deepEqual(shown.map(local), ['2026-07-01', '2026-07-02', '2026-07-03']);
	});
});
