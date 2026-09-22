<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { applyArtworkColor, holdArtworkColor, randomArtworkColor } from '$lib/client/artwork';
	import { prefersReducedMotion } from '$lib/client/sleeve-transition.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import type { ActionData, PageData } from './$types';

	const SOURCE_URL = 'https://github.com/zorcerer/heddohon';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Seeded once: after that the radio group owns the value.
	let selected = $state(untrack(() => form?.backend ?? data.servers[0]?.kind ?? 'subsonic'));
	let submitting = $state(false);

	/*
	 * Where this page is in its own coming and going. It starts covered, which
	 * is what the server renders, so a fresh load fades up rather than appearing
	 * whole. Signing out is a form post to an endpoint, so it arrives here as a
	 * browser navigation and gets the same treatment.
	 */
	let phase = $state<'arriving' | 'idle' | 'leaving'>('arriving');
	const leaving = $derived(phase === 'leaving');

	const selectedServer = $derived(data.servers.find((server) => server.kind === selected));

	/*
	 * Going out.
	 *
	 * The page blurs and fades before the navigation is applied, rather than
	 * across it. Doing it across would mean a view transition, and the root
	 * cross-fade is switched off in `app.css` on purpose: a glass surface
	 * painted from a snapshot of itself has no backdrop to blur, which is what
	 * put black rectangles over the rail on iPadOS and Windows. Nothing here is
	 * worth re-opening that.
	 *
	 * So the dissolve finishes first and the app is what is underneath when it
	 * does. The ambient field is deliberately not part of it: the app paints the
	 * same one, at the colour this page chose, so leaving it alone is what makes
	 * the two pages read as one room rather than two screens.
	 */
	const LEAVE_MS = 380;

	async function leave(): Promise<void> {
		phase = 'leaving';
		// The animation is already reduced to nothing by the global motion rule,
		// so waiting for it would only be a delay with nothing on screen.
		if (prefersReducedMotion()) return;
		await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
	}

	/*
	 * A different colour every time this page is opened.
	 *
	 * The app takes its colour from whatever is playing, written onto the
	 * document root as `--art-*`. Nothing is playing here, so the room would sit
	 * at the same idle frost on every visit. Drawing a hue instead makes the
	 * login page show what the app does rather than describe it, and costs
	 * nothing to wire: the ambient field, the crest and the accent on the button
	 * already read those properties.
	 *
	 * It goes on the document root and not on anything in this component because
	 * `--accent` is composed at `:root`, and a custom property inherits its
	 * substituted value. An override further down the tree reaches the ambience
	 * and the glass, which compose their own hsl() where they are read, and
	 * leaves every control behind.
	 *
	 * The root carries a 900ms transition on those properties, so the page
	 * blooms into its colour rather than starting there.
	 */
	onMount(() => {
		const root = document.documentElement;
		holdArtworkColor(root, randomArtworkColor());
		// What was actually written, which is not the hue that was drawn: the
		// applier unwinds it so the fade takes the short way round the wheel.
		const held = root.style.getPropertyValue('--art-h');

		return () => {
			/*
			 * Put the room back to frost on the way out, but only if it is still
			 * showing this page's colour.
			 *
			 * Signing in destroys this component and tints from the restored
			 * queue's cover in the same update, and the order between those two is
			 * not worth relying on. If the cover got there first, the colour on the
			 * root belongs to a record and is not this page's to reset.
			 */
			if (root.style.getPropertyValue('--art-h') === held) applyArtworkColor(root, null);
		};
	});

	/*
	 * Quick Connect. The server starts the request and keeps its secret; this
	 * page only ever holds the code, and asks every 3 seconds whether it has been
	 * approved. Jellyfin expires a request after 10 minutes, and the page stops
	 * asking at the same point.
	 */
	const POLL_MS = 3000;
	type QuickConnectView =
		| { step: 'idle' }
		| { step: 'starting' }
		| { step: 'waiting'; code: string }
		| { step: 'expired' }
		| { step: 'signed-in' };
	let quickConnect = $state<QuickConnectView>({ step: 'idle' });
	let quickConnectError = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;

	function stopPolling() {
		clearTimeout(pollTimer);
		clearTimeout(expiryTimer);
		pollTimer = expiryTimer = undefined;
	}

	$effect(() => stopPolling);

	async function startQuickConnect() {
		stopPolling();
		quickConnectError = null;
		quickConnect = { step: 'starting' };
		let body: { code?: string; expiresIn?: number; error?: string } | null = null;
		try {
			const response = await fetch('/login/quick-connect', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ backend: selected })
			});
			body = await response.json().catch(() => null);
			if (!response.ok || !body?.code) throw new Error(body?.error ?? '');
		} catch (err) {
			quickConnectError =
				(err instanceof Error && err.message) || 'Could not start Quick Connect. Try again shortly.';
			quickConnect = { step: 'idle' };
			return;
		}
		const code = body.code;
		quickConnect = { step: 'waiting', code };
		expiryTimer = setTimeout(
			() => {
				stopPolling();
				quickConnect = { step: 'expired' };
			},
			(body.expiresIn ?? 600) * 1000
		);
		pollTimer = setTimeout(() => poll(code), POLL_MS);
	}

	async function poll(code: string) {
		let body: { state?: string; next?: string } | null = null;
		try {
			const response = await fetch('/login/quick-connect/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ code, next })
			});
			body = await response.json().catch(() => null);
		} catch {
			// A dropped request is asked again on the next tick.
		}
		// Cancelled or restarted while this request was out.
		if (quickConnect.step !== 'waiting' || quickConnect.code !== code) return;

		if (body?.state === 'signed-in') {
			stopPolling();
			quickConnect = { step: 'signed-in' };
			await leave();
			await goto(body.next ?? '/', { invalidateAll: true });
			return;
		}
		if (body?.state === 'expired') {
			stopPolling();
			quickConnect = { step: 'expired' };
			return;
		}
		pollTimer = setTimeout(() => poll(code), POLL_MS);
	}

	function cancelQuickConnect() {
		stopPolling();
		quickConnect = { step: 'idle' };
		quickConnectError = null;
		// Drops the sealed request from this browser. Jellyfin expires its own copy.
		fetch('/login/quick-connect', { method: 'DELETE' }).catch(() => undefined);
	}

	// Preserves the page the user was trying to reach before being redirected
	// here. Parsed against a throwaway origin and kept only if it stayed there:
	// a prefix test admits `/\evil.example`, which the URL parser resolves to
	// `evil.example`. The server re-checks this, the same way, on submit.
	const next = $derived.by(() => {
		const raw = page.url.searchParams.get('next');
		if (!raw) return '/';
		try {
			const url = new URL(raw, 'http://heddohon.invalid');
			if (url.origin !== 'http://heddohon.invalid') return '/';
			// `/.//evil.example` stays on the origin and parses to `//evil.example`.
			if (url.pathname.startsWith('//')) return '/';
			return `${url.pathname}${url.search}${url.hash}`;
		} catch {
			return '/';
		}
	});
</script>

<svelte:head>
	<title>Sign in · {data.appName}</title>
</svelte:head>

<!--
	The login page is the one view the layout renders bare, so the ambient field
	the rest of the app sits in is painted here. It reads the same `--art-*` the
	rest of the app does, which this page draws a hue for on mount.
-->
<div class="hh-ambience" aria-hidden="true"></div>

<!--
	The crest at the size of the page, sitting where the panel will cover most of
	it.

	This is here to give the glass a subject. Everywhere else in the app a pane
	is translucent over artwork, which is what makes the material read as glass
	rather than as a grey rectangle with a soft edge; the login page has no
	artwork, so the panel was blurring an even wash and there was nothing in it
	to see. A shape with real edges behind the panel is what the blur needs, and
	the mark is the one shape the page already owns.
-->
{#if phase !== 'idle'}
	<!--
		The veil. It repeats the page's own ground, so fading it out reveals the
		crest and the panel over a field that never moved, and fading it in takes
		them back into the same field.

		It carries the whole opacity change for both directions. The panel is
		glass, and an ancestor whose opacity is below 1 forms a backdrop root
		exactly as a filter does: fading the stage would strip the pane's blur and
		its brightness(0.5) on the first frame and hand them back on the last. A
		sibling laid over the top leaves every surface under it at opacity 1.
	-->
	<div
		class="veil hh-ambience"
		class:closing={leaving}
		aria-hidden="true"
		onanimationend={() => {
			if (phase === 'arriving') phase = 'idle';
		}}
	></div>
{/if}

<div class="crest-field" class:leaving aria-hidden="true">
	<Logo size={640} />
</div>

<main class="stage">
	<!-- The class goes on the column and not on the stage above it: the stage is
	     the panel's ancestor, and a filter there would form a backdrop root the
	     same way an opacity would. This column holds no glass. -->
	<aside class="intro" class:leaving>
		<!-- Crest and name set as one lockup rather than stacked. Stacked, the
		     mark read as an illustration sitting above a heading; on the line it
		     reads as the thing the name belongs to. -->
		<div class="lockup">
			<Logo size={52} />
			<h1 class="wordmark">{data.appName}</h1>
		</div>
		<p class="lede">Your music server, in a room lit by whatever is playing.</p>
		<!-- The session ceiling used to be stated here as well. The settings page
		     is where it is acted on, and it says so there. -->
		<p class="assurance">
			<span class="hh-eyebrow">Credentials</span>
			<span class="hh-muted">Passed straight to the music server. This browser stores none of it.</span>
		</p>
	</aside>

	<div class="panel hh-glass hh-float">
		<header>
			<h2>Sign in</h2>
			{#if data.servers.length === 1}
				<p class="hh-muted sub">to {data.servers[0].label}</p>
			{/if}
		</header>

		{#if quickConnectError ?? form?.error}
			<p class="alert" role="alert">{quickConnectError ?? form?.error}</p>
		{/if}

		{#if quickConnect.step === 'idle' || quickConnect.step === 'starting'}
			<form
				method="POST"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						// Only a redirect is on its way somewhere. A failed sign-in
						// stays on this page and has an error to show, so dissolving
						// it would blur out the thing the reader needs to read.
						if (result.type === 'redirect') await leave();
						await update({ reset: false });
						submitting = false;
					};
				}}
			>
				{#if data.servers.length > 1}
					<fieldset class="servers">
						<legend class="hh-eyebrow">Music server</legend>
						{#each data.servers as server (server.kind)}
							<label class="server" class:selected={selected === server.kind}>
								<input
									type="radio"
									name="backend"
									value={server.kind}
									bind:group={selected}
									class="hh-visually-hidden"
								/>
								<span class="server-name">{server.label}</span>
								<span class="hh-eyebrow">{server.kind}</span>
							</label>
						{/each}
					</fieldset>
				{:else if data.servers.length === 1}
					<!-- The server is named in the panel header instead, so this only
					     has to carry the value. -->
					<input type="hidden" name="backend" value={data.servers[0].kind} />
				{/if}

				<label class="field">
					<span class="hh-eyebrow label">Username</span>
					<input
						class="hh-input"
						name="username"
						autocomplete="username"
						required
						autocapitalize="none"
						spellcheck="false"
						value={form?.username ?? ''}
					/>
				</label>

				<label class="field">
					<span class="hh-eyebrow label">Password</span>
					<input
						class="hh-input"
						type="password"
						name="password"
						autocomplete="current-password"
						required
					/>
				</label>

				<input type="hidden" name="next" value={next} />

				<button
					class="hh-button hh-button--primary submit"
					class:busy={submitting}
					type="submit"
					disabled={submitting}
				>
					{submitting ? 'Checking with the server…' : 'Sign in'}
				</button>
			</form>

			{#if selectedServer?.quickConnect}
				<div class="divider" aria-hidden="true"><span class="hh-eyebrow">or</span></div>
				<button
					class="hh-button quick"
					class:busy={quickConnect.step === 'starting'}
					type="button"
					onclick={startQuickConnect}
					disabled={quickConnect.step === 'starting' || submitting}
				>
					{quickConnect.step === 'starting' ? 'Asking the server for a code…' : 'Sign in with Quick Connect'}
				</button>
			{/if}
		{:else}
			<section class="quick-connect" aria-live="polite">
				{#if quickConnect.step === 'waiting'}
					<span class="hh-eyebrow">Quick Connect code</span>
					<p class="code">{quickConnect.code}</p>
					<p class="hh-muted note">
						In {selectedServer?.label ?? 'Jellyfin'}, open your user settings, choose Quick Connect
						and enter this code. This page signs in once the code is approved.
					</p>
					<p class="hh-muted note">The code expires after 10 minutes.</p>
				{:else if quickConnect.step === 'expired'}
					<p class="alert" role="alert">The code expired before it was approved.</p>
					<button class="hh-button hh-button--primary submit" type="button" onclick={startQuickConnect}>
						Get a new code
					</button>
				{:else}
					<p class="hh-muted note">Signed in. Opening your library…</p>
				{/if}
				{#if quickConnect.step !== 'signed-in'}
					<button class="hh-button hh-button--ghost" type="button" onclick={cancelQuickConnect}>
						Use a password instead
					</button>
				{/if}
			</section>
		{/if}

		{#if data.hint}
			<footer>
				<p class="hh-muted note">{data.hint}</p>
			</footer>
		{/if}
	</div>

	<footer class="colophon">
		<!-- `noreferrer` as well as `noopener`: the referrer would otherwise carry
		     the `next` query parameter, which names a page inside this
		     deployment, to a third party. -->
		<a class="source" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
			<Icon name="github" size={18} />
			<span>Source on GitHub</span>
		</a>
	</footer>
</main>

<style>
	/*
	 * Two columns at rest: what the app is on the left, the way into it on the
	 * right. The form was a single centred card before, which left the panel
	 * carrying the name, the explanation, the fields and three footnotes at
	 * once. Splitting them lets the panel hold nothing but the controls.
	 *
	 * Both tracks are capped rather than fractional. A form field wider than
	 * about 26rem is harder to read back, not easier, and the stage is centred
	 * in whatever is left over.
	 */
	.stage {
		position: relative;
		z-index: 1;
		min-height: 100vh;
		display: grid;
		align-content: center;
		justify-content: center;
		gap: var(--space-6) var(--space-7);
		padding: var(--space-6) var(--space-5);
		grid-template-columns: minmax(0, 23rem) minmax(0, 25rem);
		grid-template-areas:
			'intro panel'
			'colophon colophon';
	}

	/*
	 * Fixed, and centred on the right-hand column so the panel lands over the
	 * middle of it. The interesting part of the crest is its edges, meaning the
	 * ring, the band and the two earcups, and those want to fall across the
	 * panel rather than beside it.
	 *
	 * Faint enough to read as a watermark at full strength, which also decides
	 * how much of it survives the panel's blur: the pane carries a brightness
	 * multiplier as well as the blur, so anything subtle enough to sit politely
	 * on the open page nearly vanishes behind the glass. This is the level where
	 * it is still legible through the panel.
	 */
	/*
	 * The dissolve on the way to the app.
	 *
	 * The blur goes on what sits behind the glass rather than on an ancestor of
	 * it. `filter` on an ancestor makes that ancestor the backdrop root, so the
	 * panel would stop sampling the crest and the ambient field the moment the
	 * animation started: it loses the brightness(0.5) its material carries and
	 * the crest snaps into focus through 48% of transparent fill, which is a
	 * flash on the first frame while the blur is still at zero. Softening the
	 * backdrop instead arrives at the same picture by the material's own route,
	 * since `backdrop-filter` samples whatever the crest layer has become.
	 *
	 * Nothing here uses a transform. The panel carries a `backdrop-filter`, and
	 * that pairing is what this codebase has had compositing artefacts from on
	 * iOS, which is also why `.hh-button:active` changes its surface rather than
	 * scaling.
	 */
	/*
	 * Resting at 0 and animated from 1, in both directions. The other way round,
	 * a browser that never ran the animation would hold an opaque sheet over the
	 * page. Both declarations have to outrank `.hh-ambience`, which sets its own
	 * z-index and leaves the ground transparent, hence naming both classes.
	 */
	.veil.hh-ambience {
		z-index: 60;
		background-color: var(--bg-base);
		opacity: 0;
		animation: veil-out 420ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
	}

	.veil.closing {
		animation: veil-in 380ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
	}

	@keyframes veil-out {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	@keyframes veil-in {
		to {
			opacity: 1;
		}
	}

	/* The two layers that carry the blur. Neither holds glass, so a filter on
	   them costs nothing. The panel is softened by the crest going out of focus
	   behind it, which its own `backdrop-filter` samples. */
	.crest-field.leaving,
	.intro.leaving {
		animation: soften 380ms cubic-bezier(0.4, 0, 0.2, 1) both;
	}

	@keyframes soften {
		to {
			filter: blur(16px);
		}
	}

	/* The wrapper is the viewport exactly, so the part of the crest that runs off
	   the right-hand edge is clipped rather than left to argue with the document
	   about whether it is scrollable. */
	.crest-field {
		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
		color: var(--accent);
		opacity: 0.14;
		/*
		 * Faded out before it reaches the left-hand column. At this strength the
		 * crest lifts the ground under it, and the text over there is the muted
		 * tone, which is defined by sitting close to its own background: a
		 * lighter ground costs it contrast exactly where it has least to give.
		 * Behind the panel none of that applies, since the pane is between the
		 * two. So the watermark blooms out of the right-hand side and is gone by
		 * the time there is type to read.
		 */
		-webkit-mask-image: linear-gradient(to right, transparent 0%, #000 38%);
		mask-image: linear-gradient(to right, transparent 0%, #000 38%);
	}

	/*
	 * The component writes its own width and height inline, from a pixel prop.
	 * That is right for an icon sized by its caller and wrong for a watermark
	 * measured against the viewport, and an inline style is only reachable from
	 * a stylesheet with `!important`. The `size` passed in the markup is what
	 * the server renders before this arrives.
	 */
	.crest-field :global(svg) {
		position: absolute;
		top: 50%;
		left: 68%;
		translate: -50% -50%;
		width: clamp(28rem, 62vw, 50rem) !important;
		height: auto !important;
	}

	/* On paper the mark is a dark shape on a pale ground, and the same opacity
	   reads considerably heavier. */
	:global([data-theme='light']) .crest-field {
		opacity: 0.09;
	}

	.intro {
		grid-area: intro;
		align-self: center;
		display: grid;
		justify-items: start;
		gap: var(--space-4);
	}

	/*
	 * The crest takes the accent, which is the artwork hue: on the login page
	 * there is no artwork, so it takes the idle tint from the tokens.
	 */
	.lockup {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		color: var(--accent);
	}

	.wordmark {
		margin: 0;
		font-family: var(--font-display);
		font-weight: var(--display-weight);
		letter-spacing: var(--display-tracking);
		font-size: clamp(2.5rem, 6vw, 3.5rem);
		line-height: 1;
		color: var(--text-strong);
	}

	.lede {
		margin: 0;
		max-width: 22rem;
		font-size: 1rem;
		color: var(--text-muted);
	}

	.assurance {
		margin: var(--space-2) 0 0;
		max-width: 22rem;
		display: grid;
		gap: var(--space-1);
		font-size: 0.8125rem;
		padding-left: var(--space-4);
		border-left: 1px solid var(--border-hairline);
	}

	/* The radius, the edge and the lift all come from `.hh-float`. */
	.panel {
		grid-area: panel;
		padding: var(--space-6);
	}

	header {
		margin-bottom: var(--space-5);
	}

	h2 {
		font-size: 1.375rem;
		margin: 0;
	}

	.sub {
		margin: var(--space-1) 0 0;
		font-size: 0.875rem;
	}

	.alert {
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-sunken));
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		border-radius: var(--r-sm);
		padding: var(--space-3) var(--space-4);
		font-size: 0.875rem;
		color: var(--text-strong);
		margin: 0 0 var(--space-4);
	}

	form {
		display: grid;
		gap: var(--space-4);
	}

	.servers {
		border: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-2);
	}

	.servers legend {
		margin-bottom: var(--space-2);
		padding: 0;
	}

	.server {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 0.625rem 0.875rem;
		border: 1px solid var(--field-edge);
		border-radius: var(--r-sm);
		background: var(--field-face);
		-webkit-backdrop-filter: var(--field-blur);
		backdrop-filter: var(--field-blur);
		cursor: pointer;
		transition:
			border-color var(--transition),
			background var(--transition);
	}

	.server:hover {
		border-color: var(--border-strong);
	}

	.server.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-sunken));
	}

	.server-name {
		font-weight: 600;
		color: var(--text-strong);
	}

	.field {
		display: grid;
		gap: var(--space-2);
	}

	/*
	 * The label takes the room's colour while the field has the caret. The
	 * input's own border already goes to the accent on focus, so this is the
	 * same event answered twice at opposite ends of the control, which is what
	 * makes the field read as one object rather than a caption and a box.
	 */
	.label {
		transition: color var(--transition);
	}

	.field:focus-within .label {
		color: var(--accent);
	}

	/*
	 * A ring that grows out of the border rather than a second edge drawn
	 * outside it. Transitioning the spread from zero is what animates it; at
	 * 20% of the accent it is a halo on the field, not a glow on the page.
	 *
	 * `box-shadow` and not `outline`: an outline is drawn outside the border box
	 * and would sit over the field below it in the grid.
	 */
	.field :global(.hh-input) {
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 20%, transparent);
		transition:
			border-color var(--transition),
			background var(--transition),
			box-shadow var(--transition);
	}

	.field :global(.hh-input:focus) {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.submit {
		margin-top: var(--space-2);
		padding: 0.7rem 1rem;
		border-radius: var(--r-md);
	}

	.submit:disabled {
		opacity: 0.65;
		cursor: progress;
	}

	/*
	 * Waiting on the server.
	 *
	 * An indeterminate bar along the bottom edge, because the page genuinely
	 * does not know how long the upstream will take. It is feedback rather than
	 * decoration: both buttons that carry it spend that time with their label
	 * changed and nothing else happening.
	 *
	 * Drawn on a pseudo-element and not the button, so the thing being animated
	 * is a plain opaque bar. Animating the button itself would put a transform
	 * on an element carrying a `backdrop-filter`, which is the combination this
	 * codebase has had artefacts from on iOS before.
	 */
	.busy {
		position: relative;
		overflow: hidden;
	}

	.busy::after {
		content: '';
		position: absolute;
		left: 0;
		bottom: 0;
		width: 40%;
		height: 2px;
		background: var(--accent);
		animation: sweep 1.15s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	/* On the primary button the bar sits on the accent itself, so it borrows the
	   colour the label is already using to stay legible against it. */
	.hh-button--primary.busy::after {
		background: var(--accent-contrast);
		opacity: 0.6;
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(350%);
		}
	}

	.divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: var(--space-4) 0;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--border-hairline);
	}

	.quick {
		width: 100%;
		padding: 0.7rem 1rem;
		border-radius: var(--r-md);
	}

	.quick:disabled {
		opacity: 0.65;
		cursor: progress;
	}

	.quick-connect {
		display: grid;
		gap: var(--space-3);
	}

	.code {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 2.25rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-strong);
		user-select: all;
	}

	footer {
		margin-top: var(--space-5);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border-hairline);
		display: grid;
		gap: var(--space-1);
	}

	.note {
		font-size: 0.8125rem;
		margin: 0;
	}

	/*
	 * The colophon spans both columns rather than sitting under one of them, so
	 * it stays put when the stage folds to a single column.
	 */
	.colophon {
		grid-area: colophon;
		margin: 0;
		padding: 0;
		border: none;
		justify-items: center;
	}

	.source {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.8125rem;
		color: var(--text-faint);
		text-decoration: none;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-pill);
		transition:
			color var(--transition),
			text-shadow var(--transition);
	}

	.source:hover,
	.source:focus-visible {
		color: var(--glow-color);
		text-shadow: var(--glow-text);
	}

	/*
	 * One column below the width where two 23rem tracks plus the gap still fit.
	 * The crest and the name stay above the panel, which is the order they are
	 * read in anyway. The assurance stays with them rather than being dropped:
	 * it is what the page is asking the reader to accept before typing a
	 * password into it.
	 */
	@media (max-width: 56rem) {
		.stage {
			grid-template-columns: minmax(0, 25rem);
			grid-template-areas:
				'intro'
				'panel'
				'colophon';
			gap: var(--space-5);
			align-content: start;
			padding-top: var(--space-6);
		}

		.wordmark {
			font-size: 2.25rem;
		}

		.lockup {
			gap: var(--space-3);
		}

		.lede {
			display: none;
		}

		.assurance {
			margin-top: 0;
		}

		/* One column puts the panel in the middle, so the crest goes with it. It
		   is also the whole background here rather than one side of a spread,
		   which is more of it than the watermark wants to be. The fade turns
		   with the layout: the type is above the panel now, not beside it. */
		.crest-field {
			opacity: 0.1;
			-webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 32%);
			mask-image: linear-gradient(to bottom, transparent 0%, #000 32%);
		}

		.crest-field :global(svg) {
			left: 50%;
			top: 46%;
			width: min(34rem, 128vw) !important;
		}
	}
</style>
