<script lang="ts">
	/**
	 * A profile page by its public link, for anyone holding it: drawn bare, as
	 * a shared link is, with the covers and the picture from this link's own
	 * routes. Nothing on it leads into the library.
	 */
	import Logo from '$lib/components/Logo.svelte';
	import ProfileView from '$lib/components/ProfileView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const base = $derived(`/p/${encodeURIComponent(data.token)}`);
</script>

<svelte:head>
	<title>{data.page.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="hh-ambience" aria-hidden="true"></div>

<main class="page">
	<ProfileView page={data.page} coverBase="{base}/cover" avatarSrc={data.page.avatar ? `${base}/avatar?v=${data.page.avatar}` : null} linked={false} />
	<footer class="hh-muted">
		<Logo size={20} />
		<span>Heddohon</span>
	</footer>
</main>

<style>
	.page {
		position: relative;
		z-index: 1;
		display: grid;
		gap: var(--space-6);
		max-width: 60rem;
		margin: 0 auto;
		padding: var(--space-7) var(--space-5);
	}

	footer {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.8125rem;
	}
</style>
