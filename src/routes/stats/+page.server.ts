import type { PageServerLoad } from './$types';
import { listeningStats, periodBefore, periodStart, STATS_PERIODS, type StatsPeriod } from '$lib/server/history';
import { getSettings } from '$lib/server/settings';

export const load: PageServerLoad = async ({ locals, url }) => {
	const accountId = locals.session!.account.id;
	const requested = url.searchParams.get('period');
	const period: StatsPeriod = STATS_PERIODS.includes(requested as StatsPeriod) ? (requested as StatsPeriod) : 'month';
	const now = Date.now();
	const from = periodStart(period, now);
	// Read from this server's database alone; no upstream call.
	const [stats, settings] = await Promise.all([
		listeningStats(accountId, from, periodBefore(period, now)),
		getSettings(accountId)
	]);
	// `to` is the moment the figures were read at: the charts end on its day.
	return { period, from, to: now, stats, historyDays: settings.historyDays };
};
