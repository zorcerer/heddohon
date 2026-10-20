<script lang="ts">
	import Icon from './Icon.svelte';

	/**
	 * A cover on a profile page. The address is the page's own cover route
	 * (`/api/people/<handle>/cover/<slot>`, or the public link's), which reads
	 * it through the page owner's credential; `Cover` builds the viewer's own
	 * `/api/cover` address and cannot reach those.
	 */
	let { src, alt = '' }: { src: string | null; alt?: string } = $props();

	let failedSrc = $state<string | null>(null);

	// A listener, not `onerror`: for that Svelte writes an inline handler into
	// the server-rendered markup, which the Content-Security-Policy refuses (as
	// in `Avatar.svelte`).
	function watch(image: HTMLImageElement) {
		const fail = () => (failedSrc = image.getAttribute('src'));
		if (image.complete && image.naturalWidth === 0 && image.currentSrc) fail();
		image.addEventListener('error', fail);
		return () => image.removeEventListener('error', fail);
	}
</script>

<span class="cover">
	{#if src && failedSrc !== src}
		<img {src} {alt} loading="lazy" decoding="async" {@attach watch} />
	{:else}
		<span class="none" aria-hidden="true"><Icon name="album" size={28} /></span>
	{/if}
</span>

<style>
	.cover {
		display: block;
		aspect-ratio: 1;
		width: 100%;
		border-radius: var(--r-md);
		overflow: hidden;
		background: var(--field-face);
	}

	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.none {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		color: var(--text-muted);
	}
</style>
