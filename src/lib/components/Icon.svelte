<script lang="ts">
	/**
	 * A single inline sprite. Icons are drawn on a 24-unit grid with a 1.6 stroke
	 * and rounded caps, so they sit alongside the type without shouting. Keeping
	 * them here rather than pulling an icon package keeps the bundle honest and
	 * means the whole set shares one visual language.
	 */
	type IconName =
		| 'play'
		| 'pause'
		| 'next'
		| 'previous'
		| 'shuffle'
		| 'repeat'
		| 'repeat-one'
		| 'volume'
		| 'volume-low'
		| 'mute'
		| 'heart'
		| 'heart-filled'
		| 'queue'
		| 'home'
		| 'album'
		| 'artist'
		| 'playlist'
		| 'search'
		| 'settings'
		| 'close'
		| 'plus'
		| 'more'
		| 'logout'
		| 'chevron-left'
		| 'chevron-right'
		| 'waveform'
		| 'trash'
		| 'expand'
		| 'collapse'
		| 'lyrics'
		| 'info';

	let {
		name,
		size = 20,
		strokeWidth = 1.6,
		label
	}: { name: IconName; size?: number; strokeWidth?: number; label?: string } = $props();

	const PATHS: Record<IconName, string> = {
		play: 'M8 5.2v13.6a.7.7 0 0 0 1.07.6l11-6.8a.7.7 0 0 0 0-1.2l-11-6.8A.7.7 0 0 0 8 5.2Z',
		pause: 'M9 5v14M15 5v14',
		next: 'M6 5.5v13l9-6.5-9-6.5ZM18 5v14',
		previous: 'M18 5.5v13L9 12l9-6.5ZM6 5v14',
		shuffle: 'M17 4l3 3-3 3M17 14l3 3-3 3M4 7h3.5l9 10H20M20 7h-3.5l-2 2.2M4 17h3.5l2-2.2',
		repeat: 'M17 3l3 3-3 3M7 21l-3-3 3-3M20 6H8a4 4 0 0 0-4 4v1M4 18h12a4 4 0 0 0 4-4v-1',
		'repeat-one': 'M17 3l3 3-3 3M7 21l-3-3 3-3M20 6H8a4 4 0 0 0-4 4v1M4 18h12a4 4 0 0 0 4-4v-1M12 10.5l1.5-1v4',
		volume: 'M11 5.5 6.5 9H3.5v6h3L11 18.5v-13ZM15 9.5a3.5 3.5 0 0 1 0 5M17.8 7a7 7 0 0 1 0 10',
		'volume-low': 'M11 5.5 6.5 9H3.5v6h3L11 18.5v-13ZM15 9.5a3.5 3.5 0 0 1 0 5',
		mute: 'M11 5.5 6.5 9H3.5v6h3L11 18.5v-13ZM16 10l5 4M21 10l-5 4',
		heart: 'M12 20s-7.5-4.4-7.5-9.4A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.5 2.6C19.5 15.6 12 20 12 20Z',
		'heart-filled': 'M12 20s-7.5-4.4-7.5-9.4A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.5 2.6C19.5 15.6 12 20 12 20Z',
		queue: 'M4 6h11M4 11h11M4 16h7M17.5 11v8M17.5 19a1.9 1.9 0 1 1-2 -1.9M20.5 8l-3 1',
		home: 'M4 10.5 12 4l8 6.5V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19v-8.5ZM9.5 20.4v-6h5v6',
		album: 'M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4ZM12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z',
		artist: 'M12 3.5a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
		playlist: 'M4 6h13M4 11h13M4 16h6M18 9.5v8.2M18 17.7a1.9 1.9 0 1 1-2-1.9',
		search: 'M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM15.8 15.8 20 20',
		settings:
			'M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6ZM12 3.5l1.4 2.2 2.6-.4.6 2.5 2.3 1.3-1 2.4 1 2.4-2.3 1.3-.6 2.5-2.6-.4L12 20.5l-1.4-2.2-2.6.4-.6-2.5-2.3-1.3 1-2.4-1-2.4 2.3-1.3.6-2.5 2.6.4L12 3.5Z',
		close: 'M6 6l12 12M18 6 6 18',
		plus: 'M12 5v14M5 12h14',
		more: 'M6 12h.01M12 12h.01M18 12h.01',
		logout: 'M15 5.5h3.1A1.4 1.4 0 0 1 19.5 7v10a1.4 1.4 0 0 1-1.4 1.4H15M11 8l-4 4 4 4M7 12h9',
		'chevron-left': 'M14.5 5.5 8 12l6.5 6.5',
		'chevron-right': 'M9.5 5.5 16 12l-6.5 6.5',
		waveform: 'M4 11v2M8 7.5v9M12 4.5v15M16 8.5v7M20 10.5v3',
		lyrics:
			'M4.5 6.5h9M4.5 11h11M4.5 15.5h6M17.5 14.2V7.4l3-.9v6.8M17.5 15.8a1.6 1.6 0 1 1-1.7-1.6M20.5 13.3a1.6 1.6 0 1 1-1.7-1.6',
		trash: 'M5 7h14M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7M6.8 7l.8 11.2A1.4 1.4 0 0 0 9 19.5h6a1.4 1.4 0 0 0 1.4-1.3L17.2 7',
		// Arrows out of / into opposite corners: the pair reads as one control
		// that flips, rather than two unrelated buttons.
		expand: 'M14 4.5h5.5V10M19.5 4.5 13.8 10.2M10 19.5H4.5V14M4.5 19.5l5.7-5.7',
		collapse: 'M19.5 9.5H14V4M14 9.5l5.5-5.5M4.5 14.5H10V20M10 14.5 4.5 20',
		// The dot is drawn as a hairline stroke rather than a fill, so it keeps
		// the same weight as every other glyph in the set.
		info: 'M12 4.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6ZM12 10.8v5.4M12 7.9v.5'
	};

	const FILLED = new Set<IconName>(['play', 'heart-filled', 'next', 'previous']);
</script>

<!--
	Sized in rem rather than px so the glyphs follow the interface scale, which
	is a root font-size. The prop stays in pixels, since that is what every call
	site reads as, and is divided by the 16px root the design was drawn against.
	The size goes in `style` rather than the `width` attribute: SVG presentation
	attributes do not take rem everywhere, CSS does.
-->
<svg
	style="width: {size / 16}rem; height: {size / 16}rem"
	viewBox="0 0 24 24"
	fill={FILLED.has(name) ? 'currentColor' : 'none'}
	stroke="currentColor"
	stroke-width={FILLED.has(name) ? 0 : strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : 'presentation'}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	{#if name === 'pause' || name === 'more'}
		<!-- These two are drawn from bare strokes rather than closed shapes, so
		     they need more weight than the outline icons to match them. A caller
		     asking for something heavier still is honoured. -->
		<path d={PATHS[name]} stroke-width={Math.max(strokeWidth, name === 'more' ? 2.4 : 2)} />
	{:else}
		<path d={PATHS[name]} />
	{/if}
</svg>

<style>
	svg {
		flex: none;
		display: block;
	}
</style>
