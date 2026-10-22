<script lang="ts">
	import Icon from './Icon.svelte';
	import MediaShelf from './MediaShelf.svelte';
	import type { NewRelease } from '$lib/server/newreleases';

	/**
	 * The home page's "New releases": albums and EPs by the artists played
	 * most, from MusicBrainz, that the library does not have. Each is a link to
	 * its MusicBrainz page, in a new tab; there is nothing here to play, and
	 * no cover, since the page loads images from this server alone.
	 */
	let { releases, index }: { releases: NewRelease[]; index: number } = $props();

	/*
	 * The date as MusicBrainz gives it, in words. Read as UTC, so the server's
	 * render and the browser's agree.
	 */
	function when(release: NewRelease): string {
		const [year, month, day] = release.date.split('-').map(Number);
		const date = new Date(Date.UTC(year, month - 1, day || 1));
		const text = date.toLocaleDateString('en-GB', { day: day ? 'numeric' : undefined, month: 'long', year: 'numeric', timeZone: 'UTC' });
		return release.upcoming ? `Out ${text}` : text;
	}
</script>

<MediaShelf title="New releases" eyebrow="From the artists you play most, not in your library" {index}>
	{#each releases as release (release.id)}
		<a class="release" href={release.url} target="_blank" rel="noopener noreferrer">
			<span class="sleeve" aria-hidden="true">
				<span class="kind">{release.type}</span>
				{#if release.upcoming}<span class="soon">Soon</span>{/if}
				<Icon name="external" size={18} />
			</span>
			<span class="title hh-clamp-2">{release.title}</span>
			<span class="artist hh-truncate hh-muted">{release.artist}</span>
			<span class="date hh-muted hh-numeric">{when(release)}</span>
		</a>
	{/each}
</MediaShelf>

<style>
	.release {
		display: grid;
		align-content: start;
		gap: var(--space-1);
		min-width: 0;
		color: var(--text-default);
		text-decoration: none;
	}

	/* A plain sleeve in place of a cover: the kind of record, and where the link goes. */
	.sleeve {
		position: relative;
		display: grid;
		place-items: end start;
		aspect-ratio: 1;
		margin-bottom: var(--space-1);
		padding: var(--space-3);
		border: 1px dashed var(--border-strong);
		border-radius: var(--r-md);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		color: var(--text-muted);
		transition:
			border-color var(--transition),
			color var(--transition);
	}

	.sleeve :global(svg) {
		position: absolute;
		top: var(--space-3);
		right: var(--space-3);
	}

	.kind {
		font-size: 0.75rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.soon {
		position: absolute;
		top: var(--space-3);
		left: var(--space-3);
		padding: 0.1rem 0.45rem;
		border-radius: var(--r-pill);
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: 0.6875rem;
		font-weight: 600;
	}

	.release:hover .sleeve,
	.release:focus-visible .sleeve {
		border-color: var(--accent);
		color: var(--accent);
	}

	.title {
		color: var(--text-strong);
		font-weight: 600;
		font-size: 0.875rem;
	}

	.artist,
	.date {
		font-size: 0.8125rem;
	}
</style>
