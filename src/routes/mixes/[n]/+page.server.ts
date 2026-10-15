import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { library } from '$lib/server/library';
import { dailyMixes } from '$lib/server/mixes';

export const load: PageServerLoad = async (event) => {
	const mixes = await library(event, (ctx) => dailyMixes(ctx));
	const mix = mixes.find((entry) => String(entry.n) === event.params.n);
	if (!mix) error(404, 'There is no such mix today');
	// `name` for the path strip, which reads it from whichever loader ran.
	return { mix: { ...mix, name: mix.title } };
};
