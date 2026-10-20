<!--
  The rules of a smart playlist: all or any of a list of rules, each a field,
  an operator and a value, then a sort, an order and a limit. Used to make one
  (with `naming`, which adds the name) and to change one's rules. The rules
  are checked here as they are typed, with the same `checkRules` the server
  applies, so Save is offered only for rules the server will take.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import {
		FIELDS,
		MAX_DAYS,
		MAX_LIMIT,
		MAX_RULES,
		MAX_TEXT,
		OPS_BY_KIND,
		OP_LABELS,
		RULE_FIELDS,
		SORT_FIELDS,
		SORT_LABELS,
		checkRules,
		defaultValue,
		type RuleField,
		type RuleOp,
		type SmartRules
	} from '$lib/smartrules';

	let {
		initial,
		naming = false,
		busy = false,
		error = null,
		saveLabel = 'Save rules',
		onsave,
		oncancel
	}: {
		initial: SmartRules;
		naming?: boolean;
		busy?: boolean;
		error?: string | null;
		saveLabel?: string;
		onsave: (rules: SmartRules, name: string) => void;
		oncancel: () => void;
	} = $props();

	// A copy to edit: the page's own stays as it was until the save is done.
	let draft = $state<SmartRules>(untrack(() => structuredClone(initial)));
	let name = $state('');
	let nameField = $state<HTMLInputElement | null>(null);

	const checked = $derived(checkRules($state.snapshot(draft)));
	const problem = $derived('error' in checked ? checked.error : null);

	$effect(() => {
		if (naming) untrack(() => nameField?.focus());
	});

	function setField(index: number, field: RuleField) {
		const rule = draft.rules[index];
		const ops = OPS_BY_KIND[FIELDS[field].kind];
		const op = ops.includes(rule.op) ? rule.op : ops[0];
		draft.rules[index] = { field, op, value: defaultValue(field, op) };
	}

	function setOp(index: number, op: RuleOp) {
		const rule = draft.rules[index];
		// A range and a single number are different values; anything else carries over.
		const reshaped = FIELDS[rule.field].kind === 'number' && (op === 'inTheRange') !== (rule.op === 'inTheRange');
		draft.rules[index] = { ...rule, op, value: reshaped ? defaultValue(rule.field, op) : rule.value };
	}

	/** An emptied number field is NaN, which the check refuses, rather than 0. */
	const numberOf = (input: HTMLInputElement) => (input.value === '' ? NaN : Number(input.value));

	function setRange(index: number, end: 0 | 1, input: HTMLInputElement) {
		const value = draft.rules[index].value;
		const range: [number, number] = Array.isArray(value) ? [value[0], value[1]] : [NaN, NaN];
		range[end] = numberOf(input);
		draft.rules[index].value = range;
	}

	function addRule() {
		if (draft.rules.length >= MAX_RULES) return;
		draft.rules.push({ field: 'genre', op: 'contains', value: '' });
	}

	function removeRule(index: number) {
		if (draft.rules.length > 1) draft.rules.splice(index, 1);
	}

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy || 'error' in checked || (naming && !name.trim())) return;
		onsave(checked.rules, name.trim());
	}
</script>

<form class="editor" onsubmit={save} aria-label="Smart playlist rules">
	{#if naming}
		<label class="field">
			<span>Name</span>
			<input
				class="hh-input"
				bind:this={nameField}
				bind:value={name}
				placeholder="Name your smart playlist"
				maxlength="200"
				autocomplete="off"
			/>
		</label>
	{/if}

	<p class="lead">
		Songs that match
		<select class="hh-input inline" bind:value={draft.match} aria-label="Match all or any of the rules">
			<option value="all">all</option>
			<option value="any">any</option>
		</select>
		of these rules
	</p>

	<ol class="rules">
		{#each draft.rules as rule, index (index)}
			{@const kind = FIELDS[rule.field].kind}
			<li>
				<select
					class="hh-input"
					value={rule.field}
					onchange={(event) => setField(index, event.currentTarget.value as RuleField)}
					aria-label="Field of rule {index + 1}"
				>
					{#each RULE_FIELDS as field (field)}
						<option value={field}>{FIELDS[field].label}</option>
					{/each}
				</select>
				<select
					class="hh-input"
					value={rule.op}
					onchange={(event) => setOp(index, event.currentTarget.value as RuleOp)}
					aria-label="Operator of rule {index + 1}"
				>
					{#each OPS_BY_KIND[kind] as op (op)}
						<option value={op}>{OP_LABELS[op]}</option>
					{/each}
				</select>
				<span class="value">
					{#if kind === 'text'}
						<input
							class="hh-input"
							type="text"
							value={rule.value}
							maxlength={MAX_TEXT}
							autocomplete="off"
							oninput={(event) => (draft.rules[index].value = event.currentTarget.value)}
							aria-label="Value of rule {index + 1}"
						/>
					{:else if kind === 'boolean'}
						<select
							class="hh-input"
							value={rule.value ? 'yes' : 'no'}
							onchange={(event) => (draft.rules[index].value = event.currentTarget.value === 'yes')}
							aria-label="Value of rule {index + 1}"
						>
							<option value="yes">yes</option>
							<option value="no">no</option>
						</select>
					{:else if kind === 'days'}
						<input
							class="hh-input hh-numeric number"
							type="number"
							min="1"
							max={MAX_DAYS}
							step="1"
							value={rule.value}
							oninput={(event) => (draft.rules[index].value = numberOf(event.currentTarget))}
							aria-label="Days of rule {index + 1}"
						/>
						<span class="unit hh-muted">days</span>
					{:else if rule.op === 'inTheRange' && Array.isArray(rule.value)}
						<input
							class="hh-input hh-numeric number"
							type="number"
							min={FIELDS[rule.field].min}
							max={FIELDS[rule.field].max}
							step="any"
							value={Number.isNaN(rule.value[0]) ? '' : rule.value[0]}
							oninput={(event) => setRange(index, 0, event.currentTarget)}
							aria-label="Lowest of rule {index + 1}"
						/>
						<span class="unit hh-muted">and</span>
						<input
							class="hh-input hh-numeric number"
							type="number"
							min={FIELDS[rule.field].min}
							max={FIELDS[rule.field].max}
							step="any"
							value={Number.isNaN(rule.value[1]) ? '' : rule.value[1]}
							oninput={(event) => setRange(index, 1, event.currentTarget)}
							aria-label="Highest of rule {index + 1}"
						/>
					{:else}
						<input
							class="hh-input hh-numeric number"
							type="number"
							min={FIELDS[rule.field].min}
							max={FIELDS[rule.field].max}
							step="any"
							value={typeof rule.value === 'number' && !Number.isNaN(rule.value) ? rule.value : ''}
							oninput={(event) => (draft.rules[index].value = numberOf(event.currentTarget))}
							aria-label="Value of rule {index + 1}"
						/>
						{#if FIELDS[rule.field].unit}
							<span class="unit hh-muted">{FIELDS[rule.field].unit}</span>
						{/if}
					{/if}
				</span>
				<button
					class="hh-button hh-button--ghost remove"
					type="button"
					onclick={() => removeRule(index)}
					disabled={draft.rules.length === 1}
					aria-label="Remove rule {index + 1}"
					title="Remove this rule"
				>
					<Icon name="close" size={16} />
				</button>
			</li>
		{/each}
	</ol>

	<button class="hh-button hh-button--ghost add" type="button" onclick={addRule} disabled={draft.rules.length >= MAX_RULES}>
		<Icon name="plus" size={16} />
		Add a rule
	</button>

	<div class="order">
		<label>
			<span>Sorted by</span>
			<select class="hh-input" bind:value={draft.sort}>
				{#each SORT_FIELDS as field (field)}
					<option value={field}>{SORT_LABELS[field]}</option>
				{/each}
			</select>
		</label>
		{#if draft.sort !== 'random'}
			<select class="hh-input" bind:value={draft.order} aria-label="Order">
				<option value="asc">ascending</option>
				<option value="desc">descending</option>
			</select>
		{/if}
		<label>
			<span>At most</span>
			<input
				class="hh-input hh-numeric number"
				type="number"
				min="1"
				max={MAX_LIMIT}
				step="1"
				placeholder="all"
				value={draft.limit ?? ''}
				oninput={(event) => (draft.limit = event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}
			/>
			<span class="hh-muted">songs</span>
		</label>
	</div>

	{#if problem}
		<p class="hint hh-muted" role="status">{problem}.</p>
	{/if}
	{#if error}
		<p class="alert" role="alert">{error}</p>
	{/if}

	<div class="actions">
		<button
			class="hh-button hh-button--primary"
			type="submit"
			disabled={busy || problem !== null || (naming && !name.trim())}
		>
			{busy ? 'Saving…' : saveLabel}
		</button>
		<button class="hh-button" type="button" onclick={oncancel} disabled={busy}>Cancel</button>
	</div>
</form>

<style>
	.editor {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
		max-width: 52rem;
		padding: var(--space-4);
		border: 1px solid var(--border-hairline);
		border-radius: var(--r-md);
		font-size: 0.875rem;
	}

	.field {
		display: grid;
		gap: var(--space-1);
		width: min(100%, 28rem);
	}

	.lead {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
	}

	.hh-input {
		width: auto;
		padding: 0.45rem 0.65rem;
		font-size: 0.875rem;
	}

	.inline {
		min-width: 5rem;
	}

	.rules {
		display: grid;
		gap: var(--space-2);
		width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rules li {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.value {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: 1 1 12rem;
		min-width: 0;
	}

	.value input[type='text'] {
		flex: 1;
		min-width: 0;
	}

	.number {
		width: 6.5rem;
	}

	.unit {
		white-space: nowrap;
	}

	.remove {
		padding: 0.4rem;
		border-radius: var(--r-sm);
	}

	/* On a phone a rule takes two or three lines; a rule between each keeps them apart. */
	@media (max-width: 40rem) {
		.rules {
			gap: var(--space-3);
		}

		.rules li + li {
			padding-top: var(--space-3);
			border-top: 1px solid var(--border-hairline);
		}
	}

	.remove:disabled,
	.add:disabled,
	.actions .hh-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.order {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	.order label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.hint {
		margin: 0;
	}

	.alert {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--danger) 14%, var(--bg-surface));
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--text-strong);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.actions .hh-button {
		border-radius: var(--r-md);
	}

	/* A glyph alone, so Terminal draws no brackets round it. */
	:global([data-theme='terminal']) .remove::before,
	:global([data-theme='terminal']) .remove::after {
		content: none;
	}
</style>
