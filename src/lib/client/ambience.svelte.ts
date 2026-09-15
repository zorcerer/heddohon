/**
 * Which cover the whole screen takes its colour from.
 *
 * There is exactly one colour in the interface at a time, applied once at the
 * document root. Panels do not tint themselves — they are translucent, so they
 * pick up the field behind them, which is what makes the colour read as one
 * light in the room rather than as a property of each widget.
 *
 * Playback wins, because a colour that follows what you are hearing is doing
 * something; when nothing is playing the page offers its own subject instead, so
 * the room still responds to where you are rather than sitting grey.
 */
class Ambience {
	/** The cover of whatever page is open. Cleared when that page unmounts. */
	page = $state<string | null>(null);

	/**
	 * The cover of a page that has been clicked but has not arrived yet.
	 *
	 * Without this the room could not change until the new page's data had come
	 * back and its component had mounted: measured at 540ms after the click on a
	 * loopback music server, and longer on a real one. The colour then swung over
	 * the next 900ms, so a navigation read as a pause followed by a lurch.
	 *
	 * A clicked card already has the cover on screen and decoded, so the colour
	 * can be resolved from it at once and the room can start moving with the
	 * sleeve rather than after it.
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
	 * Keyed on the destination rather than cleared when a navigation completes.
	 * Completion and the arriving page's own `offer` are two different moments,
	 * and clearing on the earlier of them puts the room back on the colour of the
	 * page being left for as long as the gap lasts, which is the flicker this
	 * whole mechanism exists to remove.
	 */
	settle(href: string | null): void {
		if (this.#incomingFor !== href) {
			this.incoming = null;
			this.#incomingFor = null;
		}
	}

	/**
	 * Offer a cover for as long as the caller is mounted. Returns the teardown,
	 * so a component can hand it straight back from an `$effect`.
	 */
	offer(coverArt: string | null | undefined): () => void {
		const mine = coverArt ?? null;
		this.page = mine;
		// The page it was heading for is the page that is here.
		if (this.incoming === mine) {
			this.incoming = null;
			this.#incomingFor = null;
		}
		return () => {
			// Only withdraw our own offer: a faster page that has already taken
			// over must not have its colour cleared by our teardown.
			if (this.page === mine) this.page = null;
		};
	}
}

export const ambience = new Ambience();
