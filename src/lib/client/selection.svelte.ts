/**
 * Several rows of a song list picked at once, and what can be done with them
 * together. Shown by `SelectionBar`, mounted once in the root layout, and by
 * the menu a right click opens on a picked row (`ContextMenu`).
 *
 * One list holds the selection at a time: picking in another list (a second
 * list on the page, or the queue) starts a new one there. A selection is of
 * positions, since a playlist or the queue can hold one song twice, so it is
 * dropped whenever its list changes, and on a navigation.
 *
 * How rows are picked is `SelectableList`, one for each list:
 *
 * - With a mouse, Ctrl or Cmd and a click picks a row or puts it back, and
 *   Shift and a click picks the rows from the last one clicked. A plain click
 *   leaves a selection. A click on a link in the row is the link's.
 * - With a finger, a long press picks a row, and while there is a selection a
 *   tap anywhere on a row picks it or puts it back.
 * - From the keyboard, on a focused row: Space picks it or puts it back,
 *   Shift with the up and down arrows picks from where Shift was first held,
 *   the arrows alone move between rows, and Ctrl or Cmd and A picks the list.
 * - Escape leaves the selection (`SelectionBar`).
 */
import type { Song } from '$lib/types';
import { isStarred, setStarred } from './favourites.svelte';
import { player } from './player.svelte';
import { addSongsToPlaylist } from './playlists.svelte';

export interface SelectionSource {
	/** The list's songs, in its order, as they are now. */
	songs: () => Song[];
	/** Takes the picked rows out of the list, where the list allows that, under the words for it there. */
	remove: { label: string; run: (indexes: number[]) => unknown } | null;
	/** The queue in the player: on a phone the bar then shows over the player's sheet. */
	inPlayer?: boolean;
}

class Selection {
	/** The list that holds it, or null. */
	owner = $state.raw<SelectableList | null>(null);
	indexes = $state.raw<ReadonlySet<number>>(new Set());
	source = $state.raw<SelectionSource | null>(null);

	get count(): number {
		return this.owner ? this.indexes.size : 0;
	}

	/** The picked songs in the list's order, read at the time. */
	songs(): Song[] {
		if (!this.source) return [];
		const all = this.source.songs();
		return [...this.indexes].sort((a, b) => a - b).flatMap((index) => (all[index] ? [all[index]] : []));
	}

	set(owner: SelectableList, source: SelectionSource, indexes: Set<number>) {
		if (indexes.size === 0) {
			if (this.owner === owner) this.clear();
			return;
		}
		this.owner = owner;
		this.source = source;
		this.indexes = indexes;
	}

	clear() {
		if (!this.owner) return;
		this.owner = null;
		this.source = null;
		this.indexes = new Set();
	}

	/** Takes the picked rows out of their list, highest first, and ends the selection. */
	remove() {
		const remove = this.source?.remove;
		const indexes = [...this.indexes].sort((a, b) => b - a);
		this.clear();
		void remove?.run(indexes);
	}
}

export const selection = new Selection();

/** How long a finger rests on a row before it is picked, and how far it may move meanwhile. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

/**
 * Presses that stay with the element pressed: a link, for every pointer but a
 * finger while picking, and anything marked `data-select-skip` (a drag handle)
 * for every pointer.
 */
const KEPT = 'a, [data-select-skip]';

/** The rows of one list: the picking described at the top of this file. */
export class SelectableList {
	#source: () => SelectionSource;
	/** Where a Shift range starts: the last row clicked, picked or moved to with a plain key. */
	#anchor: number | null = null;
	#press: { index: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
	/** The pointer of the last press, so the click that follows it is known as a finger's. */
	#pointer = 'mouse';
	/** A long press picked a row: the click that may follow the finger lifting is not another tap. */
	#pressed = false;

	constructor(source: () => SelectionSource) {
		this.#source = source;
	}

	/** Whether this list holds the selection. */
	get active(): boolean {
		return selection.owner === this && selection.indexes.size > 0;
	}

	has(index: number): boolean {
		return selection.owner === this && selection.indexes.has(index);
	}

	#current(): Set<number> {
		return selection.owner === this ? new Set(selection.indexes) : new Set();
	}

	#set(indexes: Set<number>) {
		selection.set(this, this.#source(), indexes);
	}

	toggle(index: number) {
		const indexes = this.#current();
		if (!indexes.delete(index)) indexes.add(index);
		this.#anchor = index;
		this.#set(indexes);
	}

	/** Picks from the anchor to `index`, added to what is picked where `add`, in place of it otherwise. */
	range(index: number, add = false) {
		const from = this.#anchor ?? index;
		const indexes = add ? this.#current() : new Set<number>();
		for (let at = Math.min(from, index); at <= Math.max(from, index); at++) indexes.add(at);
		this.#set(indexes);
	}

	all() {
		const count = this.#source().songs().length;
		this.#set(new Set(Array.from({ length: count }, (_, index) => index)));
	}

	/** Leaves the selection if this list holds it: the list changed under it, or went. */
	drop() {
		if (selection.owner === this) selection.clear();
		this.#anchor = null;
	}

	/**
	 * A click anywhere in row `index`, caught on its way down. True when it was
	 * the selection's, and has been stopped short of the row's controls.
	 */
	click(event: MouseEvent, index: number): boolean {
		if (this.#pressed) {
			this.#pressed = false;
			event.preventDefault();
			event.stopPropagation();
			return true;
		}
		const target = event.target instanceof Element ? event.target : null;
		// A click with no press behind it (detail 0) is Enter or Space on a control.
		const finger = event.detail > 0 && (this.#pointer === 'touch' || this.#pointer === 'pen');
		if (finger && this.active) {
			if (target?.closest('[data-select-skip]')) return false;
			event.preventDefault();
			event.stopPropagation();
			this.toggle(index);
			return true;
		}
		if (target?.closest(KEPT)) return false;
		const toggle = event.ctrlKey || event.metaKey;
		if (event.shiftKey) {
			event.preventDefault();
			event.stopPropagation();
			this.range(index, toggle);
			return true;
		}
		if (toggle) {
			event.preventDefault();
			event.stopPropagation();
			this.toggle(index);
			return true;
		}
		// A plain click: on the row's own controls it is theirs, and anywhere it
		// leaves a selection and starts the next range here.
		if (this.active) selection.clear();
		this.#anchor = index;
		return false;
	}

	/** Shift held on a press would select the text from the last one; the range is what it means. */
	mousedown(event: MouseEvent) {
		if (event.shiftKey && !(event.target instanceof Element && event.target.closest(KEPT))) event.preventDefault();
	}

	pointerdown(event: PointerEvent, index: number) {
		this.#pointer = event.pointerType;
		this.#pressed = false;
		this.#cancelPress();
		if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
		if (event.target instanceof Element && event.target.closest(KEPT)) return;
		this.#press = {
			index,
			x: event.clientX,
			y: event.clientY,
			timer: setTimeout(() => this.#longPress(index), LONG_PRESS_MS)
		};
	}

	pointermove(event: PointerEvent) {
		if (!this.#press) return;
		if (Math.hypot(event.clientX - this.#press.x, event.clientY - this.#press.y) > LONG_PRESS_SLOP) this.#cancelPress();
	}

	pointerend() {
		this.#cancelPress();
	}

	/**
	 * The `contextmenu` a long press sends on Android, which would open the
	 * browser's own menu over the row. True when it was the selection's.
	 */
	contextmenu(event: MouseEvent, index: number): boolean {
		const pointer = (event as PointerEvent).pointerType ?? this.#pointer;
		if (pointer !== 'touch' && pointer !== 'pen') return false;
		if (event.target instanceof Element && event.target.closest(KEPT)) return false;
		event.preventDefault();
		if (this.#press?.index === index) this.#longPress(index);
		return true;
	}

	#longPress(index: number) {
		this.#cancelPress();
		this.#pressed = true;
		const indexes = this.#current();
		indexes.add(index);
		this.#anchor = index;
		this.#set(indexes);
	}

	#cancelPress() {
		if (!this.#press) return;
		clearTimeout(this.#press.timer);
		this.#press = null;
	}

	/**
	 * The selection's keys on focused row `index`. `focus` moves the focus to
	 * another row of the list. True when the key was the selection's.
	 */
	keydown(event: KeyboardEvent, index: number, focus: (index: number) => void): boolean {
		const count = this.#source().songs().length;
		if (event.key === ' ') {
			event.preventDefault();
			// Not on to the player's own Space, in the root layout.
			event.stopPropagation();
			this.toggle(index);
			return true;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			this.all();
			return true;
		}
		const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
		if (step === 0 || event.altKey || event.ctrlKey || event.metaKey) return false;
		event.preventDefault();
		const to = index + step;
		if (to < 0 || to >= count) return true;
		if (event.shiftKey) {
			this.#anchor ??= index;
			this.range(to);
		} else {
			this.#anchor = to;
		}
		focus(to);
		return true;
	}
}

export interface SelectionAction {
	label: string;
	icon: 'play' | 'skip' | 'queue' | 'plus' | 'heart' | 'heart-filled' | 'close';
	run: () => unknown;
	danger?: boolean;
}

/** Favourites a song at a time, four at once: the music servers star one item a call. */
async function starAll(songs: Song[], starred: boolean) {
	const ids = [...new Set(songs.filter((song) => isStarred('song', song.id, song.starred) !== starred).map((song) => song.id))];
	for (let at = 0; at < ids.length; at += 4) {
		await Promise.all(ids.slice(at, at + 4).map((id) => setStarred('song', id, starred)));
	}
}

/**
 * What can be done with the selection, for the bar and the menu. Each ends
 * the selection. A radio station standing in the queue is played and queued
 * with the rest, and left out of a playlist and the favourites.
 */
export function selectionActions(): SelectionAction[] {
	const all = selection.songs();
	if (all.length === 0) return [];
	const songs = all.filter((song) => !song.live);
	const starred = songs.length > 0 && songs.every((song) => isStarred('song', song.id, song.starred));
	const then = (run: () => unknown) => () => {
		selection.clear();
		return run();
	};
	const actions: SelectionAction[] = [
		{ label: 'Play', icon: 'play', run: then(() => player.playNow(all)) },
		{ label: 'Play next', icon: 'skip', run: then(() => player.playNext(all)) },
		{ label: 'Add to queue', icon: 'queue', run: then(() => player.addToQueue(all)) }
	];
	if (songs.length > 0) {
		actions.push(
			{
				label: 'Add to playlist…',
				icon: 'plus',
				run: then(() => addSongsToPlaylist(songs, songs.length === 1 ? songs[0].title : `${songs.length} songs`))
			},
			{
				label: starred ? 'Remove from favourites' : 'Add to favourites',
				icon: starred ? 'heart-filled' : 'heart',
				run: then(() => starAll(songs, !starred))
			}
		);
	}
	const remove = selection.source?.remove;
	if (remove) actions.push({ label: remove.label, icon: 'close', run: () => selection.remove(), danger: true });
	return actions;
}
