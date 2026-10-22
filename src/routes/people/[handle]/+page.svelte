<script lang="ts">
	import { avatarUrl } from '$lib/client/listeners.svelte';
	import ProfileEditor from '$lib/components/ProfileEditor.svelte';
	import ProfileView from '$lib/components/ProfileView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** The owner's editor, a dialog over the page as others see it. */
	let editing = $state(false);
</script>

<svelte:head>
	<title>{data.page.name} · Heddohon</title>
</svelte:head>

{#snippet edit()}
	<button class="hh-button" type="button" onclick={() => (editing = true)}>Edit profile</button>
{/snippet}

<div class="page">
	<ProfileView
		page={data.page}
		coverBase="/api/people/{data.page.handle}/cover"
		avatarSrc={avatarUrl(data.page.handle, data.page.avatar)}
		linked={data.linked}
		actions={data.own && data.settings ? edit : undefined}
	/>

	{#if data.own && data.settings}
		<ProfileEditor bind:open={editing} page={data.page} settings={data.settings} maxBio={data.maxBio} username={data.account?.username ?? ''} />
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-6);
		max-width: var(--grid-max);
	}
</style>
