/**
 * An in-memory map of pending or settled upstream reads, with a lifetime and a
 * bound. The caches in `listings.ts`, `details.ts` and `suggestions.ts` are
 * each one of these.
 *
 * What is held is the promise rather than the result, so requests that arrive
 * while the first read is still out wait for it instead of each starting their
 * own. A rejected promise is dropped as soon as it settles: a failure is never
 * served from here, and the next request asks again.
 *
 * Keys start with the account id and a NUL, so `forgetAccount` can drop one
 * account's entries. The key is the account, never the backend or the server
 * alone. Jellyfin decides per user which libraries an account can see, so one
 * account's answer is not another's.
 *
 * Callers must treat the value as read-only. Every request inside the lifetime
 * receives the same object.
 */
export class Memo {
	readonly #entries = new Map<string, { value: Promise<unknown>; until: number }>();
	readonly #ttlMs: number;
	readonly #max: number;

	/** Entries live `ttlMs` and at most `max` are held, oldest dropped first. */
	constructor(ttlMs: number, max: number) {
		this.#ttlMs = ttlMs;
		this.#max = max;
	}

	/**
	 * The value for `accountId` and `key`, from memory when it is fresh enough.
	 *
	 * `ttlFor`, when given, sets the lifetime from the value once it resolves,
	 * so an empty answer can be held for less time than a full one.
	 */
	get<T>(accountId: string, key: string, load: () => Promise<T>, ttlFor?: (value: T) => number): Promise<T> {
		const full = `${accountId}\u0000${key}`;
		const held = this.#entries.get(full);
		if (held && held.until > Date.now()) return held.value as Promise<T>;

		const value = load();
		const entry = { value: value as Promise<unknown>, until: Date.now() + this.#ttlMs };
		// Deleted first so the entry moves to the end of the insertion order, which
		// is what the eviction below reads as age.
		this.#entries.delete(full);
		this.#entries.set(full, entry);
		if (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);

		value.then(
			(resolved) => {
				if (ttlFor) entry.until = Date.now() + ttlFor(resolved);
			},
			() => {
				if (this.#entries.get(full) === entry) this.#entries.delete(full);
			}
		);
		return value;
	}

	/** Drops one entry. */
	forget(accountId: string, key: string): void {
		this.#entries.delete(`${accountId}\u0000${key}`);
	}

	/**
	 * Drops every entry held for an account.
	 *
	 * A read already in flight is dropped with the rest. Its promise was stored
	 * when it started, so a request after this call starts a fresh one rather
	 * than waiting on a read that may predate the write that prompted this.
	 */
	forgetAccount(accountId: string): void {
		const prefix = `${accountId}\u0000`;
		for (const key of this.#entries.keys()) {
			if (key.startsWith(prefix)) this.#entries.delete(key);
		}
	}
}
