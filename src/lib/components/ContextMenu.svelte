<script lang="ts">
	/**
	 * The menu a right click opens on a song or an album: what the row's and
	 * the album page's buttons do, in one list at the pointer. Mounted once in
	 * the root layout; see `context-menu.svelte.ts`.
	 *
	 * It is a `menu` for a screen reader and the keyboard: the arrow keys, Home
	 * and End move through it, Escape leaves it and returns the focus to what
	 * it was opened on, and the menu key or Shift+F10 on a focused row or card
	 * opens it there.
	 */
	import type { ComponentProps } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { fetchTracks, playContainer, playInstantMix, queueContainer } from '$lib/client/actions';
	import { contextMenu } from '$lib/client/context-menu.svelte';
	import { isStarred, setStarred } from '$lib/client/favourites.svelte';
	import { ratingOf, setRating } from '$lib/client/ratings.svelte';
	import { player } from '$lib/client/player.svelte';
	import { addSongsToPlaylist } from '$lib/client/playlists.svelte';
	import { selection, selectionActions } from '$lib/client/selection.svelte';
	import { shareComposer } from '$lib/client/share.svelte';
	import { together } from '$lib/client/together.svelte';
	import Icon from './Icon.svelte';

	type IconName = ComponentProps<typeof Icon>['name'];
	type Item =
		| { kind: 'rule' }
		| { kind: 'link'; label: string; icon: IconName; href: string }
		/** Five stars in one row; see `rate`. */
		| { kind: 'rating'; id: string; current: number }
		| {
				kind: 'action';
				label: string;
				icon: IconName;
				run: () => unknown;
				danger?: boolean;
				/** Stays open and reports in its own line; see `mix`. */
				stays?: boolean;
		  };

	const subject = $derived(contextMenu.subject);

	/*
	 * An instant mix can come back empty (on Navidrome without an external
	 * agent every one does) or not at all. The menu is the only place to say
	 * so, as the button on the album page is there: the item stays, says what
	 * happened for four seconds, and the menu closes on a mix that started.
	 */
	let mix = $state<'idle' | 'busy' | 'empty' | 'failed'>('idle');
	let mixTimer: ReturnType<typeof setTimeout> | undefined;
	const mixLabel = $derived(
		mix === 'busy'
			? 'Finding similar music…'
			: mix === 'empty'
				? 'Nothing similar on your music server'
				: mix === 'failed'
					? 'The music server did not answer'
					: 'Start instant mix'
	);

	async function startMix(of: 'song' | 'album', id: string) {
		if (mix === 'busy') return;
		clearTimeout(mixTimer);
		const asked = subject;
		mix = 'busy';
		let outcome: 'idle' | 'empty' | 'failed';
		try {
			outcome = (await playInstantMix(of, id)) ? 'idle' : 'empty';
		} catch {
			outcome = 'failed';
		}
		// Closed, or opened on something else, while the answer was out.
		if (contextMenu.subject !== asked) return;
		mix = outcome;
		if (outcome === 'idle') contextMenu.close();
		else mixTimer = setTimeout(() => (mix = 'idle'), 4000);
	}

	// A menu opened on something else starts with nothing to report.
	$effect.pre(() => {
		void subject;
		clearTimeout(mixTimer);
		mix = 'idle';
	});

	/** An album's tracks, then something done with them. The menu has closed by then. */
	async function withTracks(id: string, then: (songs: Awaited<ReturnType<typeof fetchTracks>>) => unknown) {
		const songs = await fetchTracks('album', id);
		if (songs.length > 0) await then(songs);
	}

	const items = $derived.by((): Item[] => {
		if (!subject) return [];
		const sharing = page.data.sharing === true;
		const here = page.url.pathname;
		const list: Item[] = [];

		if (subject.kind === 'selection') {
			const actions = selectionActions();
			const removal = actions.findIndex((action) => action.danger);
			for (const [index, action] of actions.entries()) {
				// The same groups as a single song's.
				if (index === 3 || index === removal) list.push({ kind: 'rule' });
				list.push({ kind: 'action', ...action });
			}
			return list;
		}

		if (subject.kind === 'song') {
			const { song, play, remove } = subject;
			const playing = player.current?.id === song.id && player.playing;
			const starred = isStarred('song', song.id, song.starred);
			list.push(
				{ kind: 'action', label: playing ? 'Pause' : 'Play', icon: playing ? 'pause' : 'play', run: play },
				{ kind: 'action', label: 'Play next', icon: 'skip', run: () => player.playNext([song]) },
				{ kind: 'action', label: 'Add to queue', icon: 'queue', run: () => player.addToQueue([song]) }
			);
			// A radio station stands in the queue as a track, and is none of what follows.
			if (!song.live) {
				list.push(
					{ kind: 'rule' },
					{ kind: 'action', label: 'Add to playlist…', icon: 'plus', run: () => addSongsToPlaylist([song], song.title) },
					{
						kind: 'action',
						label: starred ? 'Remove from favourites' : 'Add to favourites',
						icon: starred ? 'heart-filled' : 'heart',
						run: () => setStarred('song', song.id, !starred)
					},
					{ kind: 'action', label: mixLabel, icon: 'radio', run: () => startMix('song', song.id), stays: true }
				);
				// Where the music server keeps ratings, as the player's stars are.
				if (page.data.ratings) list.push({ kind: 'rating', id: song.id, current: ratingOf('song', song.id, song.rating ?? 0) });
				if (together.joined) {
					list.push({ kind: 'action', label: 'Add to listen together', icon: 'radio', run: () => together.add(song) });
				}
				if (sharing) list.push({ kind: 'action', label: 'Share…', icon: 'share', run: () => shareComposer.open(song) });
				const album = song.albumId ? `/albums/${song.albumId}` : null;
				const artist = song.artistId ? `/artists/${song.artistId}` : null;
				if ((album && album !== here) || (artist && artist !== here)) list.push({ kind: 'rule' });
				if (album && album !== here) list.push({ kind: 'link', label: 'Go to album', icon: 'album', href: album });
				if (artist && artist !== here) list.push({ kind: 'link', label: 'Go to artist', icon: 'artist', href: artist });
			}
			if (remove) {
				list.push({ kind: 'rule' }, { kind: 'action', label: remove.label, icon: 'close', run: remove.run, danger: true });
			}
			return list;
		}

		const { album } = subject;
		const starred = album.starred === undefined ? null : isStarred('album', album.id, album.starred);
		list.push(
			{ kind: 'action', label: 'Play', icon: 'play', run: () => playContainer('album', album.id) },
			{ kind: 'action', label: 'Shuffle', icon: 'shuffle', run: () => withTracks(album.id, (songs) => player.playShuffled(songs)) },
			{ kind: 'action', label: 'Play next', icon: 'skip', run: () => withTracks(album.id, (songs) => player.playNext(songs)) },
			{ kind: 'action', label: 'Add to queue', icon: 'queue', run: () => queueContainer('album', album.id) },
			{ kind: 'rule' },
			{
				kind: 'action',
				label: 'Add to playlist…',
				icon: 'plus',
				run: () => withTracks(album.id, (songs) => addSongsToPlaylist(songs, album.name))
			},
			...(starred === null
				? []
				: [
						{
							kind: 'action' as const,
							label: starred ? 'Remove from favourites' : 'Add to favourites',
							icon: (starred ? 'heart-filled' : 'heart') as IconName,
							run: () => setStarred('album', album.id, !starred)
						}
					]),
			{ kind: 'action', label: mixLabel, icon: 'radio', run: () => startMix('album', album.id), stays: true }
		);
		if (sharing) {
			list.push({
				kind: 'action',
				label: 'Share…',
				icon: 'share',
				run: () =>
					shareComposer.open({ kind: 'album', id: album.id, title: album.name, subtitle: album.artist, coverArt: album.coverArt })
			});
		}
		const albumPage = `/albums/${album.id}`;
		const artistPage = album.artistId ? `/artists/${album.artistId}` : null;
		if (albumPage !== here || (artistPage && artistPage !== here)) list.push({ kind: 'rule' });
		if (albumPage !== here) list.push({ kind: 'link', label: 'Go to album', icon: 'album', href: albumPage });
		if (artistPage && artistPage !== here) list.push({ kind: 'link', label: 'Go to artist', icon: 'artist', href: artistPage });
		return list;
	});

	const heading = $derived(
		subject?.kind === 'selection'
			? { kind: 'Selection', name: `${selection.count} ${selection.count === 1 ? 'song' : 'songs'}`, by: null }
			: subject?.kind === 'song'
				? { kind: 'Song', name: subject.song.title, by: subject.song.artist }
				: subject
					? { kind: 'Album', name: subject.album.name, by: subject.album.artist }
					: null
	);

	function choose(item: Extract<Item, { kind: 'action' }>) {
		// Closed first: an action that opens a dialog moves the focus there, and
		// the menu's own return of it would take it back.
		if (!item.stays) contextMenu.close();
		void item.run();
	}

	/*
	 * Placed at the pointer, then moved to fit: left of it where it would pass
	 * the right edge, above it where it would pass the foot, and never closer
	 * than 8px to an edge. Measured and moved in the effect, which runs before
	 * the frame is drawn, so it is not seen at the first place.
	 */
	const EDGE = 8;
	let menu = $state<HTMLDivElement | null>(null);
	let left = $state(0);
	let top = $state(0);

	$effect(() => {
		if (!menu || !subject) return;
		const { x, y, keyboard } = contextMenu;
		const width = menu.offsetWidth;
		const height = menu.offsetHeight;
		left = Math.max(EDGE, x + width > innerWidth - EDGE ? x - width : x);
		top = Math.max(EDGE, y + height > innerHeight - EDGE ? Math.min(y - height, innerHeight - EDGE - height) : y);
		// The menu holds the focus while it is open, so its keys reach it. From
		// the keyboard the first item has it; after a click the menu itself, with
		// nothing marked until an arrow key is pressed.
		const first = keyboard ? menu.querySelector<HTMLElement>('[role="menuitem"]') : null;
		(first ?? menu).focus({ preventScroll: true });
	});

	/** Sets a song's rating from the menu's stars, and closes it. The star that is the rating clears it, as in the player. */
	function rate(id: string, stars: number, current: number) {
		contextMenu.close(true);
		void setRating('song', id, stars === current ? 0 : stars, current);
	}

	function starKey(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (step === 0) return;
		event.preventDefault();
		event.stopPropagation();
		const star = event.currentTarget as HTMLElement;
		const next = step > 0 ? star.nextElementSibling : star.previousElementSibling;
		if (next instanceof HTMLElement) next.focus();
	}

	/*
	 * The stops the up and down arrows move through: each item, and the five
	 * stars of the rating as one, entered at the star that is the rating (or
	 * the first). Left and right move between the stars (`starKey`).
	 */
	function step(event: KeyboardEvent) {
		if (!menu) return;
		const all = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [data-stop]')];
		let active = document.activeElement as HTMLElement | null;
		if (active?.getAttribute('role') === 'menuitemradio') active = menu.querySelector<HTMLElement>('[data-stop]');
		const at = active ? all.indexOf(active) : -1;
		let to: number | null = null;
		if (event.key === 'ArrowDown') to = at < 0 ? 0 : (at + 1) % all.length;
		else if (event.key === 'ArrowUp') to = at < 0 ? all.length - 1 : (at - 1 + all.length) % all.length;
		else if (event.key === 'Home') to = 0;
		else if (event.key === 'End') to = all.length - 1;
		else if (event.key === 'Escape') {
			event.preventDefault();
			// Not on to the dialog or the sheet under it.
			event.stopPropagation();
			contextMenu.close(true);
			return;
		} else if (event.key === 'Tab') {
			// A menu is one stop: Tab leaves it for what it was opened on.
			event.preventDefault();
			contextMenu.close(true);
			return;
		}
		if (to === null) return;
		event.preventDefault();
		all[to]?.focus();
	}

	/*
	 * Anything outside it closes it: a press, the page scrolling under it, the
	 * window changing size or losing the focus. The press is caught on its way
	 * down, so a right click on another row closes this menu and that row's
	 * `contextmenu` opens the next.
	 *
	 * Only a scroll that moves what it was opened on. The lyrics scroll
	 * themselves at every line, and closed a menu on any page within a line's
	 * length while a track played.
	 */
	$effect(() => {
		if (!subject) return;
		const outside = (event: Event) => {
			if (menu && event.target instanceof Node && menu.contains(event.target)) return;
			contextMenu.close();
		};
		const away = () => contextMenu.close();
		const scrolled = (event: Event) => {
			if (event.target instanceof Node && contextMenu.isIn(event.target)) contextMenu.close();
		};
		addEventListener('pointerdown', outside, true);
		addEventListener('scroll', scrolled, { capture: true, passive: true });
		addEventListener('resize', away);
		addEventListener('blur', away);
		return () => {
			removeEventListener('pointerdown', outside, true);
			removeEventListener('scroll', scrolled, true);
			removeEventListener('resize', away);
			removeEventListener('blur', away);
		};
	});

	// A menu for a selection that has ended (its list changed under it) has nothing to act on.
	$effect(() => {
		if (subject?.kind === 'selection' && selection.count === 0) contextMenu.close();
	});

	beforeNavigate(() => contextMenu.close());
</script>

{#if subject && heading}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={menu}
		class="menu hh-glass"
		role="menu"
		tabindex="-1"
		aria-label="{heading.kind}: {heading.name}"
		style:left="{left}px"
		style:top="{top}px"
		onkeydown={step}
		oncontextmenu={(event) => event.preventDefault()}
	>
		<div class="head" aria-hidden="true">
			<span class="name hh-truncate">{heading.name}</span>
			{#if heading.by}<span class="by hh-truncate">{heading.by}</span>{/if}
		</div>
		{#each items as item, index (index)}
			{#if item.kind === 'rule'}
				<div class="rule" role="separator"></div>
			{:else if item.kind === 'rating'}
				<div class="rating" role="group" aria-label="Rating">
					<Icon name="star" size={16} />
					<span class="label" aria-hidden="true">Rate</span>
					<span class="stars">
						{#each [1, 2, 3, 4, 5] as stars (stars)}
							<button
								class="star"
								class:lit={stars <= item.current}
								role="menuitemradio"
								tabindex="-1"
								type="button"
								aria-checked={stars === item.current}
								aria-label={stars === item.current ? `${stars} of 5, press to clear` : `Rate ${stars} of 5`}
								data-stop={stars === Math.max(1, item.current) ? '' : undefined}
								onclick={() => rate(item.id, stars, item.current)}
								onkeydown={starKey}
							>
								<Icon name={stars <= item.current ? 'star-filled' : 'star'} size={16} />
							</button>
						{/each}
					</span>
				</div>
			{:else if item.kind === 'link'}
				<a class="item" role="menuitem" tabindex="-1" href={item.href} onclick={() => contextMenu.close()}>
					<Icon name={item.icon} size={16} />
					<span class="label">{item.label}</span>
				</a>
			{:else}
				<button
					class="item"
					class:danger={item.danger}
					class:quiet={item.stays && (mix === 'empty' || mix === 'failed')}
					role="menuitem"
					tabindex="-1"
					type="button"
					aria-busy={item.stays ? mix === 'busy' : undefined}
					onclick={() => choose(item)}
				>
					<Icon name={item.icon} size={16} />
					<span class="label" aria-live={item.stays ? 'polite' : undefined}>{item.label}</span>
				</button>
			{/if}
		{/each}
	</div>
{/if}

<style>
	/*
	 * Over the page, the rail, the player and the phone's dock (60), and under
	 * a dialog, which is in the browser's top layer. It fades in by its own
	 * opacity: a transform would be on glass.
	 */
	.menu {
		position: fixed;
		z-index: 70;
		display: grid;
		min-width: 13.5rem;
		max-width: min(19rem, calc(100vw - 1rem));
		max-height: calc(100dvh - 1rem);
		overflow-y: auto;
		padding: var(--space-1);
		border: 1px solid var(--border-strong);
		border-radius: var(--r-md);
		box-shadow: var(--float-shadow);
		outline: none;
		animation: menu-in var(--dur-hover) var(--ease-out);
	}

	@keyframes menu-in {
		from {
			opacity: 0;
		}
	}

	/* What it is a menu for, so a click that landed on the wrong row shows. */
	.head {
		display: grid;
		padding: var(--space-2) var(--space-3);
		margin-bottom: var(--space-1);
		border-bottom: 1px solid var(--border-hairline);
	}

	.name {
		color: var(--text-strong);
		font-size: 0.875rem;
		font-weight: 600;
	}

	.by {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.item {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: 0.45rem var(--space-3);
		border-radius: var(--r-sm);
		color: var(--text-default);
		font-size: 0.875rem;
		text-align: left;
		text-decoration: none;
		white-space: nowrap;
		cursor: default;
	}

	.item :global(svg) {
		flex: none;
		color: var(--text-muted);
	}

	/* The item under the pointer and the one the arrow keys are on look the
	   same, and the keys' own ring is not drawn over it. */
	.item:hover,
	.item:focus-visible {
		background: var(--bg-hover);
		color: var(--text-strong);
		outline: none;
	}

	.item:hover :global(svg),
	.item:focus-visible :global(svg) {
		color: var(--accent);
	}

	.item.danger,
	.item.danger :global(svg) {
		color: var(--danger);
	}

	.item.quiet {
		color: var(--text-muted);
	}

	.item[aria-busy='true'] {
		cursor: progress;
	}

	/* The rating: a row laid out as an item, whose stars are the items. */
	.rating {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.2rem 0.25rem 0.2rem var(--space-3);
		color: var(--text-default);
		font-size: 0.875rem;
	}

	.rating > :global(svg) {
		flex: none;
		color: var(--text-muted);
	}

	.stars {
		display: inline-flex;
		margin-left: auto;
	}

	.star {
		display: grid;
		place-items: center;
		padding: 0.25rem;
		border-radius: var(--r-sm);
		color: var(--text-faint);
		cursor: default;
	}

	.star.lit {
		color: var(--glow-color);
	}

	/* As in the player: pointing at a star lights it and those before it. */
	.stars:hover .star {
		color: var(--glow-color);
	}

	.stars .star:hover ~ .star {
		color: var(--text-faint);
	}

	.star:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	.rule {
		height: 1px;
		margin: var(--space-1) var(--space-2);
		background: var(--border-hairline);
	}

	@media (prefers-reduced-motion: reduce) {
		.menu {
			animation: none;
		}
	}

	/* ── Terminal ────────────────────────────────────────────────────────────── */

	/* In lower case, as its buttons are, and the chosen item is the accent on
	   the pane: there is no lighter face to raise it to. */
	:global([data-theme='terminal']) .item {
		text-transform: lowercase;
	}

	:global([data-theme='terminal']) .item:hover,
	:global([data-theme='terminal']) .item:focus-visible {
		background: var(--accent);
		color: var(--accent-contrast);
	}

	:global([data-theme='terminal']) .item:hover :global(svg),
	:global([data-theme='terminal']) .item:focus-visible :global(svg) {
		color: var(--accent-contrast);
	}
</style>
