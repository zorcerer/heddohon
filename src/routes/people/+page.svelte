<script lang="ts">
	import { avatarUrl } from '$lib/client/listeners.svelte';
	import ProfileCover from '$lib/components/ProfileCover.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const initial = (name: string) => Array.from(name)[0]?.toUpperCase() ?? '?';
</script>

<svelte:head>
	<title>People · Heddohon</title>
</svelte:head>

<div class="page">
	<header>
		<h1 class="hh-display">People</h1>
		<p class="meta"><a href="/people/{data.ownHandle}">Your profile</a></p>
	</header>

	{#if data.people.length > 0}
		<ul class="people">
			{#each data.people as person (person.handle)}
				<li>
					<a class="card hh-card hh-glass" href="/people/{person.handle}">
						<span class="who">
							<span class="avatar" aria-hidden="true">
								{#if person.avatar}
									<img src={avatarUrl(person.handle, person.avatar)} alt="" />
								{:else}
									{initial(person.name)}
								{/if}
							</span>
							<span class="name hh-truncate">{person.name}</span>
						</span>
						<span class="four" aria-hidden="true">
							{#each [0, 1, 2, 3] as index (index)}
								<ProfileCover src={index < person.favourites ? `/api/people/${person.handle}/cover/f${index}?size=128` : null} />
							{/each}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="empty hh-muted">Nobody here shows a profile yet.</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-5);
		max-width: var(--grid-max);
	}

	header {
		display: grid;
		gap: 0.2rem;
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--border-hairline);
	}

	h1 {
		margin: 0.2rem 0 0;
		font-size: clamp(2.25rem, 1.4rem + 2.6vw, 3.5rem);
	}

	.meta {
		margin: var(--space-1) 0 0;
		font-size: 0.875rem;
	}

	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: var(--space-4);
	}

	.card {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		color: inherit;
		text-decoration: none;
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	.avatar {
		flex: none;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		overflow: hidden;
		display: grid;
		place-items: center;
		background: var(--field-face);
		font-weight: 600;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.name {
		font-weight: 600;
		color: var(--text-strong);
	}

	.four {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.empty {
		padding: var(--space-7);
		text-align: center;
	}
</style>
