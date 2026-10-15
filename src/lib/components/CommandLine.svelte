<script lang="ts">
	import { page } from '$app/state';
	import {
		COMMANDS,
		PLACES,
		SCHEMES,
		THEMES,
		commandNamed,
		label,
		parse,
		ranked,
		run,
		scoped,
		type Found
	} from '$lib/client/commands';
	import type { SearchResults } from '$lib/types';

	/*
	 * Terminal's command line, in the path strip: `:`, `;` (the same key
	 * without Shift) or Ctrl+K (Cmd+K) opens it, and the button on the strip for
	 * a screen without a keyboard. The commands are in `commands.ts`. Shown in
	 * Terminal alone, as the strip is.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();

	/*
	 * The button names the line and its shortcut, so it is found without the
	 * README. Until the line has been opened once in this browser it is drawn in
	 * the accent and glows three times; after that it is drawn as the strip is.
	 */
	const KNOWN_KEY = 'hh-command-known';
	let known = $state(true);
	let shortcut = $state('Ctrl K');

	$effect(() => {
		try {
			known = localStorage.getItem(KNOWN_KEY) === '1';
		} catch {
			known = true;
		}
		if (/Mac|iPhone|iPad/.test(navigator.userAgent)) shortcut = '⌘K';
	});

	interface Suggestion {
		/** What the line becomes when it is taken with Tab. */
		line: string;
		text: string;
		detail: string;
		found: Found | null;
	}

	let line = $state('');
	let field = $state<HTMLInputElement | null>(null);
	let suggestions = $state<Suggestion[]>([]);
	let selected = $state(-1);
	let busy = $state(false);
	/** What the last command did, shown in the strip for a few seconds, or what went wrong, shown under the line. */
	let said = $state<{ ok: boolean; text: string } | null>(null);
	let saidTimer: ReturnType<typeof setTimeout> | null = null;

	/** Lines run, newest last, kept in this browser. */
	const HISTORY_KEY = 'hh-command-history';
	const HISTORY_KEPT = 50;
	let history: string[] = [];
	let back = -1;

	function readHistory(): string[] {
		try {
			const kept = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
			return Array.isArray(kept) ? kept.filter((entry): entry is string => typeof entry === 'string') : [];
		} catch {
			return [];
		}
	}

	function remember(entry: string) {
		history = [...history.filter((kept) => kept !== entry), entry].slice(-HISTORY_KEPT);
		try {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
		} catch {
			// Private browsing: the history lasts the page.
		}
	}

	const terminal = () => document.documentElement.dataset.theme === 'terminal';

	function show() {
		if (open) return field?.focus();
		history = readHistory();
		back = -1;
		line = '';
		said = null;
		suggestions = [];
		selected = -1;
		open = true;
		if (!known) {
			known = true;
			try {
				localStorage.setItem(KNOWN_KEY, '1');
			} catch {
				// Private browsing: it glows again next time.
			}
		}
	}

	function hide() {
		open = false;
		suggestions = [];
		selected = -1;
	}

	$effect(() => {
		if (open) field?.focus();
	});

	function onWindowKeydown(event: KeyboardEvent) {
		if (open || !terminal()) return;
		const target = event.target as HTMLElement | null;
		if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
		const opener =
			((event.key === ':' || event.key === ';') && !event.ctrlKey && !event.metaKey && !event.altKey) ||
			((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k');
		if (!opener) return;
		event.preventDefault();
		show();
	}

	/*
	 * What the line suggests: the commands while the first word is typed, then
	 * what the command takes. A search waits 150ms after the last key, and an
	 * answer to an older line is dropped.
	 */
	let asked = 0;
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	async function search(words: string): Promise<SearchResults> {
		const response = await fetch(`/api/search?q=${encodeURIComponent(scoped(words).query)}`);
		if (!response.ok) return { songs: [], albums: [], artists: [] };
		const body = (await response.json()) as Partial<SearchResults>;
		return { songs: body.songs ?? [], albums: body.albums ?? [], artists: body.artists ?? [] };
	}

	function suggest() {
		const ask = ++asked;
		if (searchTimer) clearTimeout(searchTimer);
		said = null;
		selected = -1;
		const { name, arg } = parse(line);
		const typedName = !/\s/.test(line.replace(/^\s*:?\s*/, ''));
		if (typedName) {
			const lower = name.toLowerCase();
			suggestions = COMMANDS.filter((command) => command.name.startsWith(lower) || command.aliases?.some((alias) => alias.startsWith(lower))).map((command) => ({
				line: `${command.name} `,
				text: command.usage,
				detail: command.help,
				found: null
			}));
			return;
		}
		const command = commandNamed(name);
		const options = (list: readonly string[]) =>
			list
				.filter((option) => option.startsWith(arg.trim().toLowerCase()))
				.map((option) => ({ line: `${command!.name} ${option}`, text: option, detail: '', found: null }));
		if (command?.takes === 'place') suggestions = options(['~', '..', ...PLACES]);
		else if (command?.takes === 'theme') suggestions = options(THEMES);
		else if (command?.takes === 'scheme') suggestions = options(SCHEMES);
		else if (command?.takes === 'search' && scoped(arg).query.length >= 2) {
			searchTimer = setTimeout(async () => {
				const results = await search(arg).catch(() => null);
				if (ask !== asked || !results) return;
				suggestions = ranked(results, arg)
					.slice(0, 8)
					.map((found) => ({ line: `${command.name} ${label(found)}`, text: label(found), detail: found.kind, found }));
			}, 150);
		} else suggestions = [];
	}

	function say(ok: boolean, text: string) {
		said = { ok, text };
		if (saidTimer) clearTimeout(saidTimer);
		// A result fades from the strip; a refusal stays under the line until the next key.
		if (ok) saidTimer = setTimeout(() => (said = null), 3000);
	}

	async function submit() {
		if (busy) return;
		const chosen = selected >= 0 ? suggestions[selected] : null;
		// A command chosen from the list that takes an argument is put on the
		// line for it; one that takes none is run.
		if (chosen && !chosen.found && chosen.line.endsWith(' ') && commandNamed(chosen.line.trim())?.usage.includes('<')) {
			line = chosen.line;
			suggest();
			return;
		}
		const typed = chosen && !chosen.found ? chosen.line : line;
		if (!typed.trim()) return hide();
		busy = true;
		const result = await run(typed, {
			search,
			chosen: chosen?.found ?? null,
			path: page.url.pathname
		});
		busy = false;
		remember(chosen?.found ? chosen.line : typed.trim());
		say(result.ok, result.message);
		if (result.ok) hide();
	}


	/*
	 * Leaving the field closes the line, after a moment: a suggestion pressed
	 * with the pointer takes the focus first. The line that is open then is
	 * checked, not the one that was: a command that navigates closes the line
	 * itself, and a line opened again inside the 150ms was closed by the
	 * moment left over from the first.
	 */
	function leave() {
		setTimeout(() => {
			if (!busy && open && document.activeElement !== field) hide();
		}, 150);
	}
	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			hide();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void submit();
		} else if (event.key === 'Tab' && suggestions.length > 0) {
			event.preventDefault();
			line = suggestions[Math.max(0, selected)].line;
			suggest();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			if (suggestions.length > 0) {
				selected = (selected + step + suggestions.length + 1) % (suggestions.length + 1);
				if (selected === suggestions.length) selected = -1;
			} else if (history.length > 0) {
				// Up walks back through the lines run, down forward again.
				back = Math.min(history.length - 1, Math.max(-1, back - step));
				line = back < 0 ? '' : history[history.length - 1 - back];
			}
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<div class="line">
		<span class="prompt" aria-hidden="true">:</span>
		<input
			bind:this={field}
			bind:value={line}
			oninput={suggest}
			onkeydown={onKeydown}
			onblur={leave}
			class="field"
			type="text"
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
			role="combobox"
			aria-label="Command"
			aria-expanded={suggestions.length > 0}
			aria-controls="command-suggestions"
			aria-activedescendant={selected >= 0 ? `command-suggestion-${selected}` : undefined}
			placeholder="play kind of blue · cd albums · help"
		/>
		{#if busy}<span class="busy" aria-hidden="true">…</span>{/if}
	</div>
	{#if suggestions.length > 0 || (said && !said.ok)}
		<div class="panel">
			{#if said && !said.ok}
				<p class="refused" role="alert">{said.text}</p>
			{/if}
			{#if suggestions.length > 0}
				<ul id="command-suggestions" role="listbox" aria-label="Suggestions">
					{#each suggestions as suggestion, index (suggestion.line + index)}
						<li
							id="command-suggestion-{index}"
							role="option"
							aria-selected={index === selected}
							class:selected={index === selected}
							onmousedown={(event) => {
								// Before the field's blur, which closes the line.
								event.preventDefault();
								selected = index;
								void submit();
							}}
						>
							<span class="text hh-truncate">{suggestion.text}</span>
							{#if suggestion.detail}<span class="detail hh-truncate">{suggestion.detail}</span>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
{:else}
	{#if said?.ok}<span class="said hh-truncate" role="status">{said.text}</span>{/if}
	<button class="open" class:fresh={!known} type="button" onclick={show} aria-label="Command line" aria-keyshortcuts=": ; Control+K Meta+K">
		<span class="mark" aria-hidden="true">:</span><span class="word" aria-hidden="true">command</span><kbd aria-hidden="true">{shortcut}</kbd>
	</button>
{/if}

<style>
	.line {
		display: flex;
		align-items: center;
		gap: 0.5ch;
		flex: 1;
		min-width: 0;
	}

	.prompt {
		color: var(--accent);
		font-weight: 600;
	}

	.field {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-strong);
		font: inherit;
		outline: none;
		caret-color: var(--accent);
	}

	.field::placeholder {
		color: var(--text-faint);
	}

	.busy {
		color: var(--text-faint);
	}

	/* Under the strip, across the pane, as the strip is. */
	.panel {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 4;
		background: var(--bg-surface);
		border-bottom: 1px solid var(--border-strong);
	}

	.refused {
		margin: 0;
		padding: 0.4rem var(--space-4);
		color: var(--danger);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0.25rem 0;
		max-height: min(60vh, 22rem);
		overflow-y: auto;
	}

	li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
		gap: var(--space-4);
		padding: 0.3rem var(--space-4);
		cursor: pointer;
	}

	li.selected,
	li:hover {
		background: var(--accent);
		color: var(--bg-base);
	}

	.text {
		color: inherit;
	}

	.detail {
		color: var(--text-faint);
	}

	li.selected .detail,
	li:hover .detail {
		color: inherit;
		opacity: 0.8;
	}

	.said {
		flex: 1;
		min-width: 0;
		text-align: right;
		color: var(--accent);
	}

	.open {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.6ch;
		padding: 0.1rem 0.3rem 0.1rem 0.6ch;
		border: 1px solid var(--border-strong);
		border-radius: var(--r-sm);
		background: none;
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
		transition:
			color var(--transition),
			border-color var(--transition);
	}

	.mark {
		color: var(--accent);
		font-weight: 600;
	}

	kbd {
		padding: 0 0.5ch;
		border: 1px solid var(--border-hairline);
		border-radius: calc(var(--r-sm) - 2px);
		background: var(--bg-base);
		color: var(--text-faint);
		font: inherit;
		font-size: 0.6875rem;
	}

	.open:hover,
	.open.fresh {
		color: var(--accent);
		border-color: var(--accent);
	}

	.open:hover kbd,
	.open.fresh kbd {
		color: var(--text-muted);
	}

	/* Three slow pulses, a second after the page is drawn, then still. */
	.open.fresh {
		animation: hh-command-glow 1.6s var(--ease-colour) 1s 3;
	}

	@keyframes hh-command-glow {
		50% {
			box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.open.fresh {
			animation: none;
		}
	}
</style>
