/**
 * Carries one sleeve across a navigation.
 *
 * Clicking a record pulls it out of its sleeve, and the same sleeve then grows
 * into the album page's hero rather than the page cutting to a new layout. The
 * browser does the morph via the View Transitions API; all this module does is
 * make sure exactly one element on each side of the navigation claims the
 * matching `view-transition-name`.
 *
 * "Exactly one" is the whole reason this state exists. The same album can appear
 * in two shelves on the home page, and a duplicated view-transition-name makes
 * the browser silently skip the transition for both. So the name is applied only
 * to the sleeve that was actually clicked.
 */

/** How long the record spends sliding out before the navigation starts. */
export const LAUNCH_MS = 190;

let nextToken = 0;

/**
 * A per-card identity, so two cards for the same album stay distinguishable.
 *
 * The counter is reset at the start of every navigation, which makes the tokens
 * stable rather than merely unique: returning to a page renders the same cards
 * in the same order and so hands out the same numbers. That is what lets the
 * return trip know which of several identical cards to morph back into.
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
	 * Re-arms the outbound names for a return to the page we came from, so the
	 * album hero morphs back into the exact card that opened it.
	 *
	 * Only the page that was actually departed from qualifies. Going back to some
	 * other page that happens to list the album would morph the cover into a card
	 * the user never touched, which reads as the layout jumping.
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
	 * Whether this sleeve should take the shared name.
	 *
	 * A sleeve with a token is one of possibly several cards for the same album —
	 * the home page shows the same release under more than one shelf — so it only
	 * claims the name if it is the one that was clicked. A sleeve without a token
	 * is a page's single hero, which claims on the album id alone because there is
	 * nothing to disambiguate it from.
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
