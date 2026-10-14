<script lang="ts">
	import { page } from '$app/state';

	/*
	 * Terminal's line along the top of the page: where this is, written as a
	 * path under the library, and whose library it is. `~/albums/kind-of-blue`
	 * on an album, `miles@navidrome` at the other end.
	 *
	 * It is in the page in every theme and shown only in Terminal, so changing
	 * the theme in Settings needs nothing rendered again. Hidden with
	 * `display: none`, its links are out of the tab order.
	 */

	/** The name of what a detail page shows, from whichever loader ran. */
	const named = $derived.by(() => {
		const data = page.data as Record<string, { name?: unknown } | undefined>;
		for (const key of ['album', 'artist', 'playlist', 'genre', 'folder']) {
			const name = data[key]?.name;
			if (typeof name === 'string' && name) return name;
		}
		return null;
	});

	/** A name as a path segment: lower case, with a hyphen for each run of anything but letters and digits. */
	function slug(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-|-$/g, '');
	}

	/*
	 * The section from the address, then the name of the thing shown. The id in
	 * the address is the music server's and is not written. Settings shows its
	 * tab, which is in the query.
	 */
	const segments = $derived.by(() => {
		const [section] = page.url.pathname.split('/').filter(Boolean);
		if (!section) return [];
		const out = [{ label: section, href: `/${section}` }];
		const last = named ? slug(named) : section === 'settings' ? page.url.searchParams.get('tab') : null;
		if (last) out.push({ label: last, href: '' });
		return out;
	});

	const whose = $derived.by(() => {
		const account = page.data.account as { username?: string } | null;
		if (!account?.username) return '';
		const server = slug(String(page.data.serverLabel ?? ''));
		return server ? `${account.username}@${server}` : account.username;
	});
</script>

<nav class="strip" aria-label="Where this page is">
	<!--
		The last part is the page itself and is text, not a link. As a link to
		the page it is on, it navigated without loading anything, and a heart
		pressed since the page loaded went back to what the page had loaded.
	-->
	<span class="path hh-truncate">
		{#if segments.length === 0}<span class="here" aria-current="page">~</span>{:else}<a href="/">~</a>{/if}{#each segments as segment, index (index)}<span
				class="slash"
				aria-hidden="true">/</span
			>{#if index === segments.length - 1}<span class="here" aria-current="page">{segment.label}</span>{:else}<a href={segment.href}>{segment.label}</a>{/if}{/each}
	</span>
	<span class="whose">{whose}</span>
</nav>

<style>
	.strip {
		display: none;
	}

	/*
	 * Stuck to the top of the content pane, which scrolls under it, so it is
	 * opaque. The negative margins take it out to the pane's edges through the
	 * pane's own padding, and the negative `top` likewise: a sticky element is
	 * held inside the scroller's padding, which at `top: 0` left it 24px down.
	 */
	:global([data-theme='terminal']) .strip {
		position: sticky;
		top: calc(var(--space-5) * -1);
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin: calc(var(--space-5) * -1) calc(var(--space-5) * -1) var(--space-5);
		padding: 0.4rem var(--space-4);
		background: var(--bg-surface);
		border-bottom: 1px solid var(--border-strong);
		border-radius: var(--r-xl) var(--r-xl) 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	/* Not part of the page that rises into place after a navigation. */
	:global([data-theme='terminal'] .content.rising) > .strip {
		animation: none;
	}

	.path {
		min-width: 0;
	}

	.here {
		color: var(--text-strong);
	}

	.path a:hover {
		color: var(--accent);
	}

	.slash {
		color: var(--text-faint);
	}

	.whose {
		flex: none;
	}

	/*
	 * In Phosphor the strip is a display across the top of the pane: the path
	 * in the dot-matrix face, the way to the page dimmer than the page itself,
	 * under the display's control grid (`::after`).
	 */
	:global([data-theme='phosphor']) .strip {
		position: sticky;
		top: calc(var(--space-5) * -1);
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin: calc(var(--space-5) * -1) calc(var(--space-5) * -1) var(--space-5);
		padding: 0.55rem var(--space-4);
		background: var(--vfd-glass);
		box-shadow: var(--vfd-bezel);
		border-radius: var(--r-xl) var(--r-xl) 0 0;
		font-family: var(--font-readout);
		font-size: 0.8125rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 62%, transparent);
		text-shadow: var(--glow-text);
	}

	:global([data-theme='phosphor']) .strip::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: var(--vfd-mesh);
		pointer-events: none;
	}

	:global([data-theme='phosphor'] .content.rising) > .strip {
		animation: none;
	}

	:global([data-theme='phosphor']) .here,
	:global([data-theme='phosphor']) .path a:hover {
		color: var(--accent);
	}

	:global([data-theme='phosphor']) .slash {
		padding: 0 0.3em;
		color: color-mix(in srgb, var(--accent) 35%, transparent);
	}

	/* A phone has no pane to head: the document scrolls, under the status bar. */
	@media (max-width: 60rem) {
		:global([data-theme='terminal']) .strip,
		:global([data-theme='phosphor']) .strip {
			display: none;
		}
	}
</style>
