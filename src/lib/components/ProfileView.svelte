<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ProfileView } from '$lib/server/profilepage';
	import Avatar from './Avatar.svelte';
	import ProfileCover from './ProfileCover.svelte';

	/**
	 * A profile page as anyone allowed to see it sees it: the picture, the name
	 * and the bio, the four albums, and what was played lately and most where
	 * the owner shows those. Used by `/people/<handle>` and the public link
	 * (`/p/<token>`), which differ in where the covers and the picture come
	 * from and whether albums lead anywhere.
	 */
	let {
		page,
		coverBase,
		avatarSrc,
		linked,
		slot,
		actions
	}: {
		page: ProfileView;
		/** The page's cover route, without the slot. */
		coverBase: string;
		avatarSrc: string | null;
		/** Whether album and artist ids lead to the viewer's library pages. */
		linked: boolean;
		/** Under each empty place, for the owner's editor. */
		slot?: Snippet<[number]>;
		/** At the end of the header: the owner's button that opens the editor. */
		actions?: Snippet;
	} = $props();

</script>

<header class="who">
	<Avatar name={page.name} src={avatarSrc} size={6} />
	<div class="names">
		<h1 class="hh-display">{page.name}</h1>
		{#if page.bio}
			<p class="bio">{page.bio}</p>
		{/if}
	</div>
	{#if actions}
		<div class="actions">{@render actions()}</div>
	{/if}
</header>

<section aria-labelledby="favourites">
	<h2 id="favourites" class="hh-eyebrow">Four favourites</h2>
	<ol class="favourites">
		{#each page.favourites as album, index (index)}
			<li>
				{#if album}
					{@const body = { title: album.title, artist: album.artist, year: album.year }}
					{#if linked}
						<a class="tile" href="/albums/{encodeURIComponent(album.id)}">
							<ProfileCover src={album.cover ? `${coverBase}/f${index}?size=384` : null} alt="" />
							<span class="title hh-truncate">{body.title}</span>
							<span class="sub hh-truncate hh-muted">{body.artist ?? ''}{body.year ? ` · ${body.year}` : ''}</span>
						</a>
					{:else}
						<span class="tile">
							<ProfileCover src={album.cover ? `${coverBase}/f${index}?size=384` : null} alt="" />
							<span class="title hh-truncate">{body.title}</span>
							<span class="sub hh-truncate hh-muted">{body.artist ?? ''}{body.year ? ` · ${body.year}` : ''}</span>
						</span>
					{/if}
				{:else}
					<span class="tile empty">
						<span class="hole" aria-hidden="true"></span>
						{#if slot}{@render slot(index)}{:else}<span class="sub hh-muted">Not picked</span>{/if}
					</span>
				{/if}
			</li>
		{/each}
	</ol>
</section>

{#if page.recent && page.recent.length > 0}
	<section aria-labelledby="recent">
		<h2 id="recent" class="hh-eyebrow">Listened to lately</h2>
		<ul class="recent">
			{#each page.recent as album, index (album.id)}
				<li title="{album.title}{album.artist ? ` · ${album.artist}` : ''}">
					{#if linked}
						<a href="/albums/{encodeURIComponent(album.id)}" aria-label="{album.title}{album.artist ? `, ${album.artist}` : ''}">
							<ProfileCover src={album.cover ? `${coverBase}/r${index}?size=192` : null} />
						</a>
					{:else}
						<ProfileCover src={album.cover ? `${coverBase}/r${index}?size=192` : null} alt={album.title} />
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if page.top && page.top.length > 0}
	<section aria-labelledby="top">
		<h2 id="top" class="hh-eyebrow">Most played, last 30 days</h2>
		<ol class="top">
			{#each page.top as artist (artist.id)}
				<li>
					{#if linked}
						<a href="/artists/{encodeURIComponent(artist.id)}" class="hh-truncate">{artist.name}</a>
					{:else}
						<span class="hh-truncate">{artist.name}</span>
					{/if}
					<span class="hh-numeric hh-muted">{artist.plays.toLocaleString()} play{artist.plays === 1 ? '' : 's'}</span>
				</li>
			{/each}
		</ol>
	</section>
{/if}

<style>
	.who {
		display: flex;
		gap: var(--space-5);
		align-items: center;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	.names {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
		flex: 1;
	}

	.actions {
		flex: none;
		align-self: flex-start;
	}

	/* On a phone the button takes a line of its own under the name. */
	@media (max-width: 40rem) {
		.who {
			flex-wrap: wrap;
		}

		.actions {
			width: 100%;
		}
	}

	h1 {
		margin: 0.2rem 0 0;
		font-size: clamp(2rem, 1.4rem + 2vw, 3rem);
		overflow-wrap: anywhere;
	}

	.bio {
		margin: var(--space-2) 0 0;
		max-width: 60ch;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	section {
		display: grid;
		gap: var(--space-3);
	}

	h2 {
		margin: 0;
	}

	.favourites {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-4);
	}

	@media (max-width: 40rem) {
		.favourites {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.tile {
		display: grid;
		gap: 0.3rem;
		color: inherit;
		text-decoration: none;
		min-width: 0;
	}

	.title {
		font-weight: 600;
		color: var(--text-strong);
	}

	.sub {
		font-size: 0.8125rem;
	}

	.hole {
		display: block;
		aspect-ratio: 1;
		border-radius: var(--r-md);
		border: 1px dashed var(--border-hairline);
	}

	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
		gap: var(--space-3);
	}

	.recent a {
		display: block;
	}

	.top {
		margin: 0;
		padding-left: 1.5rem;
		display: grid;
		gap: var(--space-1);
		max-width: 32rem;
	}

	.top li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.top a {
		color: inherit;
	}
</style>
