<script lang="ts">
	/**
	 * A profile's picture as a disc, or the first letter of its name where it
	 * has none or the picture does not load. See `server/listening.ts`.
	 */
	let { name, src, size = 2.75 }: { name: string; src: string | null; /** In rem. */ size?: number } = $props();

	let failedSrc = $state<string | null>(null);
	const initial = $derived(Array.from(name.trim())[0]?.toUpperCase() ?? '?');

	// A listener, not `onerror`: for that Svelte writes an inline handler into
	// the server-rendered markup, which the Content-Security-Policy refuses.
	function watch(image: HTMLImageElement) {
		const fail = () => (failedSrc = image.getAttribute('src'));
		if (image.complete && image.naturalWidth === 0 && image.currentSrc) fail();
		image.addEventListener('error', fail);
		return () => image.removeEventListener('error', fail);
	}
</script>

<span class="avatar" style:--size="{size}rem">
	{#if src && failedSrc !== src}
		<img {src} alt="" decoding="async" draggable="false" {@attach watch} />
	{:else}
		<span class="initial" aria-hidden="true">{initial}</span>
	{/if}
</span>

<style>
	.avatar {
		flex: none;
		display: grid;
		place-items: center;
		width: var(--size);
		height: var(--size);
		border-radius: 50%;
		overflow: hidden;
		background: var(--bg-active);
		color: var(--text-strong);
		user-select: none;
		-webkit-user-select: none;
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.initial {
		font-family: var(--font-display);
		font-weight: 700;
		font-size: calc(var(--size) * 0.42);
		line-height: 1;
	}
</style>
