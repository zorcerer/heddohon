<script lang="ts">
	/**
	 * The views of the listening history, as tabs at the head of each: the
	 * plays one by one, the summary of them, and a recap of a year or a month.
	 * The same control as the favourites page's.
	 */
	import { page } from '$app/state';
	import Segment from './Segment.svelte';

	const TABS = [
		{ value: '/history', href: '/history', label: 'Recently played' },
		{ value: '/stats', href: '/stats', label: 'Your listening' },
		{ value: '/stats/recap', href: '/stats/recap', label: 'Recap' }
	];
</script>

<div class="tabs">
	<Segment items={TABS} value={page.url.pathname} label="Listening history" />
</div>

<style>
	.tabs {
		margin-top: var(--space-2);
	}
</style>
