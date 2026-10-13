/**
 * The state behind the menu a right click opens on a song or an album.
 *
 * The menu is one element mounted in the root layout, like the playlist
 * picker and for its reason: a library page renders hundreds of rows and
 * cards, and each says only what it is when it is clicked.
 */
import type { Song } from '$lib/types';

/** What a card knows of an album: enough to act on it and to name it. */
export interface MenuAlbum {
	id: string;
	name: string;
	artist: string | null;
	/** Absent where the list the card is in does not say, and "Go to artist" with it. */
	artistId?: string | null;
	coverArt: string | null;
	/** Absent where the list does not say, and the favourite item with it: it could only guess which way to turn. */
	starred?: boolean;
}

export type MenuSubject =
	| {
			kind: 'song';
			song: Song;
			/** What the row's own play control does: start it in its list, or pause it. */
			play: () => void;
			/** Takes the row out of the list it is in, where the list allows that, under the words for it there. */
			remove: { label: string; run: () => void } | null;
	  }
	| { kind: 'album'; album: MenuAlbum };

/** Marks what the menu is open for, so the row keeps its hover while the pointer is in the menu. */
const MARK = 'data-menu-open';

/**
 * Whether a `contextmenu` event is one this menu answers. The browser's own
 * menu is left for three:
 *
 * - Shift held, the way to reach it past a page that has its own (Firefox
 *   does this by itself; the others do not).
 * - A long press. On a phone that is how a link is opened in a new tab, the
 *   rows already carry their actions as buttons, and iOS does not send the
 *   event at all.
 * - A click on text selected in the target, where the listener wants Copy.
 */
function answers(event: MouseEvent, target: HTMLElement): boolean {
	if (event.shiftKey) return false;
	const pointer = (event as PointerEvent).pointerType;
	if (pointer === 'touch' || pointer === 'pen') return false;
	// Firefox sends a MouseEvent with no pointer type. 5 is a touch there.
	if ((event as MouseEvent & { mozInputSource?: number }).mozInputSource === 5) return false;
	const selection = getSelection();
	if (selection && !selection.isCollapsed && target.contains(selection.anchorNode)) return false;
	return true;
}

class ContextMenu {
	subject = $state.raw<MenuSubject | null>(null);
	/** Where it was asked for, in the window. The menu moves itself to fit. */
	x = $state(0);
	y = $state(0);
	/** Opened from the keyboard, so the first item takes the focus. */
	keyboard = $state(false);
	#opener: HTMLElement | null = null;

	open(event: MouseEvent, subject: MenuSubject) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement) || !answers(event, target)) return;
		event.preventDefault();
		// A card inside a row, or a row inside a card, would otherwise open twice.
		event.stopPropagation();

		this.#opener?.removeAttribute(MARK);
		this.#opener = target;
		target.setAttribute(MARK, '');

		// The menu key and Shift+F10 send the event with no button pressed. Some
		// browsers put it at the focused element and some at the window's corner,
		// so the place is taken from the element.
		const keyboard = event.button !== 2 && !event.ctrlKey;
		if (keyboard) {
			const box = target.getBoundingClientRect();
			this.x = box.left + Math.min(32, box.width / 2);
			this.y = box.top + Math.min(box.height, 40);
		} else {
			this.x = event.clientX;
			this.y = event.clientY;
		}
		this.keyboard = keyboard;
		this.subject = subject;
	}

	/** Whether what the menu was opened on is inside `node`: a scroll of anything else leaves it where it is. */
	isIn(node: Node): boolean {
		return this.#opener !== null && node.contains(this.#opener);
	}

	/** `refocus` returns the focus to what the menu was opened on, for a menu left by the keyboard. */
	close(refocus = false) {
		if (!this.subject) return;
		this.subject = null;
		this.#opener?.removeAttribute(MARK);
		if (refocus) this.#opener?.focus({ preventScroll: true });
		this.#opener = null;
	}
}

export const contextMenu = new ContextMenu();
