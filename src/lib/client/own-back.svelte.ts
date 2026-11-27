/**
 * Back, kept by the app itself, in the app added to an iPhone's home screen.
 *
 * iOS gives that app its own swipe back from the left edge. It slides a
 * picture of the whole screen, the dock and the player with it, and draws the
 * page again when the swipe ends. A page cannot leave anything out of that
 * picture, and on 2026-11-12 blocking the touches at the edge was not a thing
 * iOS could be relied on to honour.
 *
 * So there every navigation replaces the history entry instead of adding one,
 * and iOS has nothing to swipe back to. The pages are kept here instead, each
 * with where it was scrolled, in this tab's `sessionStorage`, and the app's
 * own swipe (`EdgeSwipe.svelte`) and the Back link (`BackLink.svelte`) step
 * back through them. The swipe moves the page alone, under a dock that stays.
 *
 * Everywhere else (Safari, Android, a computer) nothing here runs and the
 * history is the browser's: Android's back button walks it.
 *
 * On by `navigator.standalone`, which only iOS sets, or by the
 * `heddohon:own-back` key in `localStorage`, which the tests and a preview on
 * another device use.
 */
import { browser } from '$app/env';
import { afterNavigate, beforeNavigate, goto } from '$app/navigation';

const STACK_KEY = 'heddohon:own-back-stack';
const FORCE_KEY = 'heddohon:own-back';
/** As far back as the swipe reaches. */
const DEPTH = 50;

interface Entry {
	/** Path and query, as `goto` takes it. */
	url: string;
	scroll: number;
}

const here = () => location.pathname + location.search;

function wanted(): boolean {
	if (!browser) return false;
	if ((navigator as { standalone?: boolean }).standalone === true) return true;
	try {
		return localStorage.getItem(FORCE_KEY) === '1';
	} catch {
		return false;
	}
}

class OwnBack {
	active = $state(false);
	/** How many pages are behind this one. */
	depth = $state(0);
	#stack: Entry[] = [];
	#goingBack: Entry | null = null;

	/**
	 * Called once from the root layout. Turns every `pushState` into a
	 * `replaceState`: SvelteKit reads `history.pushState` each time it makes an
	 * entry, so its links, `goto` and its own entries all go through this.
	 */
	init() {
		if (!browser || this.active || !wanted()) return;
		this.active = true;
		const replace = History.prototype.replaceState;
		history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
			replace.call(this, data, unused, url);
		};
		this.#load();

		beforeNavigate(({ willUnload }) => {
			// Going back, the page being left is already off the list, and the
			// top is the page arriving, whose place is the one to keep.
			if (willUnload || this.#goingBack) return;
			const top = this.#stack.at(-1);
			if (top) top.scroll = scrollY;
			this.#save();
		});

		afterNavigate(({ type }) => {
			if (type === 'enter') return;
			const url = here();
			const back = this.#goingBack;
			this.#goingBack = null;
			if (back) {
				// Once the page has laid out, where it was left.
				requestAnimationFrame(() => requestAnimationFrame(() => scrollTo({ top: back.scroll, behavior: 'instant' })));
				this.#save();
				return;
			}
			const top = this.#stack.at(-1);
			// The same page with another query (a sort, a search being typed)
			// is the same place: Back does not step through each one.
			if (top && new URL(top.url, location.origin).pathname === location.pathname) top.url = url;
			else this.#stack.push({ url, scroll: 0 });
			if (this.#stack.length > DEPTH) this.#stack.splice(0, this.#stack.length - DEPTH);
			this.#save();
		});
	}

	/** Goes to the page behind this one, where it was scrolled. False with none. */
	back(): boolean {
		if (!this.active || this.#stack.length < 2) return false;
		this.#stack.pop();
		const previous = this.#stack.at(-1)!;
		this.#goingBack = previous;
		this.#save();
		void goto(previous.url);
		return true;
	}

	#load() {
		try {
			const saved = JSON.parse(sessionStorage.getItem(STACK_KEY) ?? '[]') as Entry[];
			// Kept across a reload of the same page; anything else starts again here.
			this.#stack = Array.isArray(saved) && saved.at(-1)?.url === here() ? saved : [{ url: here(), scroll: 0 }];
		} catch {
			this.#stack = [{ url: here(), scroll: 0 }];
		}
		this.#save();
	}

	#save() {
		this.depth = this.#stack.length - 1;
		try {
			sessionStorage.setItem(STACK_KEY, JSON.stringify(this.#stack));
		} catch {
			// Private mode with storage full: the swipe still works until a reload.
		}
	}
}

export const ownBack = new OwnBack();
