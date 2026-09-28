import type { PageServerLoad } from './$types';
import { listeningStats, periodStart, STATS_PERIODS, type StatsPeriod } from '$lib/server/history';
import { getSettings } from '$lib/server/settings';

export const load: PageServerLoad = async ({ locals, url }) => {
	const accountId = locals.session!.account.id;
	const requested = url.searchParams.get('period');
	const period: StatsPeriod = STATS_PERIODS.includes(requested as StatsPeriod) ? (requested as StatsPeriod) : 'month';
	const from = periodStart(period);
	// Read from this server's database alone; no upstream call.
	const [stats, settings] = await Promise.all([listeningStats(accountId, from), getSettings(accountId)]);
	return { period, from, stats, historyDays: settings.historyDays };
};
