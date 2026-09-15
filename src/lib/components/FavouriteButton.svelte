<script lang="ts">
	import type { StarKind } from '$lib/types';
	import Icon from './Icon.svelte';

	let {
		id,
		kind,
		starred = false,
		size = 18
	}: { id: string; kind: StarKind; starred?: boolean; size?: number } = $props();

	// Optimistic: the star flips immediately and reverts if the server disagrees.
	// `override` is null until the user acts, so until then the prop is the truth.
	let override = $state<boolean | null>(null);
	let pending = $state(false);

	const active = $derived(override ?? starred);

	async function toggle(event: MouseEvent) {
		event.stopPropagation();
		event.preventDefault();
		if (pending) return;

		const nextValue = !active;
		override = nextValue;
		pending = true;
		try {
			const response = await fetch('/api/star', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id, kind, starred: nextValue })
			});
			if (!response.ok) override = !nextValue;
		} catch {
			override = !nextValue;
		} finally {
			pending = false;
		}
	}
</script>

<button
	class="fav"
	class:active
	onclick={toggle}
	aria-pressed={active}
	aria-label={active ? 'Remove from favourites' : 'Add to favourites'}
	title={active ? 'Remove from favourites' : 'Add to favourites'}
>
	<Icon name={active ? 'heart-filled' : 'heart'} {size} />
</button>

<style>
	.fav {
		display: grid;
		place-items: center;
		padding: 0.3rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		transition:
			color var(--transition),
			background var(--transition);
	}

	.fav:hover {
		color: var(--text-default);
		filter: var(--glow-icon);
	}

	.fav.active {
		color: var(--danger);
	}

	.fav.active:hover {
		color: var(--danger);
	}
</style>
