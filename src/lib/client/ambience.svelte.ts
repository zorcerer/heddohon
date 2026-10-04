/**
 * Which cover the whole screen takes its colour from.
 *
 * The interface has one colour at a time, applied at the document root. Panels
 * are translucent and pick up the field behind them.
 *
 * Playback wins. With nothing playing, the open page offers its own subject.
 */
class Ambience {
	/** The cover of whatever page is open. Cleared when that page unmounts. */
	page = $state<string | null>(null);

	/**
	 * The cover of a page that has been clicked but has not arrived yet.
	 *
	 * Without it the room could not change until the new page's data was back
	 * and its component mounted: 540ms after the click on a loopback music
	 * server, followed by the 900ms move. A clicked card has the cover on
	 * screen and decoded, so the colour is resolved at once and the room moves
	 * with the sleeve.
	 */
	incoming = $state<string | null>(null);

	/** Where that cover was heading, so a different destination can drop it. */
	#incomingFor: string | null = null;

	/** Points the room at where a navigation is going, before it gets there. */
	arriving(coverArt: string | null | undefined, href: string): void {
		this.incoming = coverArt ?? null;
		this.#incomingFor = href;
	}

	/**
	 * Drops an offer that is not for the navigation now under way.
	 *
	 * Keyed on the destination, not cleared when a navigation completes:
	 * completion comes before the arriving page's own `offer`, and clearing
	 * then puts the room back on the colour of the page left for the gap.
	 */
	settle(href: string | null): void {
		if (this.#incomingFor !== href) {
			this.incoming = null;
			this.#incomingFor = null;
		}
	}

	/** Offers a cover while the caller is mounted. Returns the teardown, for an `$effect` to return. */
	offer(coverArt: string | null | undefined): () => void {
		const mine = coverArt ?? null;
		this.page = mine;
		// The page it was heading for is the page that is here.
		if (this.incoming === mine) {
			this.incoming = null;
			this.#incomingFor = null;
		}
		return () => {
			// Only our own offer is withdrawn: a faster page may have taken over.
			if (this.page === mine) this.page = null;
		};
	}
}

export const ambience = new Ambience();
