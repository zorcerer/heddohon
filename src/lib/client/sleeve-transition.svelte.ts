/**
 * Carries one sleeve across a navigation.
 *
 * Clicking a record pulls it out of its sleeve, and the sleeve grows into the
 * album page's hero. The browser does the morph through the View Transitions
 * API. This module makes sure exactly one element on each side of the
 * navigation claims the matching `view-transition-name`.
 *
 * The same album can be in two shelves on the home page, and a duplicated
 * view-transition-name makes the browser skip the transition for both. So the
 * name goes only on the sleeve that was clicked.
 */

/** How long the record spends sliding out before the navigation starts. */
export const LAUNCH_MS = 190;

let nextToken = 0;

/**
 * A per-card identity, so two cards for one album can be told apart.
 *
 * The counter is reset at the start of every navigation, so returning to a
 * page renders the same cards in the same order with the same numbers, and
 * the return trip knows which of several identical cards to morph back into.
 */
export function sleeveToken(): number {
	nextToken += 1;
	return nextToken;
}

export function resetSleeveTokens(): void {
	nextToken = 0;
}

class SleeveTransition {
	/** The album whose sleeve is mid-flight. Names are derived from this. */
	activeId = $state<string | null>(null);
	/** Which specific sleeve was clicked. */
	activeToken = $state<number | null>(null);

	/** The outbound trip, remembered so the way back can retrace it. */
	#departure: { id: string; token: number; from: string } | null = null;

	begin(id: string, token: number, from: string) {
		this.activeId = id;
		this.activeToken = token;
		this.#departure = { id, token, from };
	}

	end() {
		this.activeId = null;
		this.activeToken = null;
	}

	/**
	 * Re-arms the outbound names for a return to the page left, so the album
	 * hero morphs back into the card that opened it. Going back to another page
	 * that lists the album would morph the cover into a card never touched.
	 */
	armReturn(toPathname: string): boolean {
		if (!this.#departure || this.#departure.from !== toPathname) return false;
		this.activeId = this.#departure.id;
		this.activeToken = this.#departure.token;
		return true;
	}

	forget() {
		this.#departure = null;
	}

	/**
	 * Whether this sleeve takes the shared name.
	 *
	 * A sleeve with a token is one of possibly several cards for the album, and
	 * claims the name only if it was the one clicked. A sleeve without a token
	 * is a page's single hero, and claims on the album id alone.
	 */
	claims(id: string | null | undefined, token: number | null = null): boolean {
		if (id === null || id === undefined) return false;
		if (this.activeId !== id) return false;
		return token === null || this.activeToken === token;
	}
}

export const sleeveTransition = new SleeveTransition();

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

export function supportsViewTransitions(): boolean {
	return typeof document !== 'undefined' && 'startViewTransition' in document;
}
