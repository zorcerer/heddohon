/**
 * An in-memory map of pending or settled upstream reads, with a lifetime and a
 * bound. The caches in `listings.ts`, `details.ts`, `suggestions.ts` and the
 * link items in `shares.ts` are each one of these.
 *
 * The promise is held, not the result, so requests that arrive during the
 * first read wait for it. A rejected promise is dropped when it settles: a
 * failure is never served from here.
 *
 * Keys start with the account id and a NUL, so `forgetAccount` can drop one
 * account's entries. Jellyfin decides per user which libraries an account
 * sees, so one account's answer is not another's.
 *
 * The upstream user the credential belongs to is part of the key too. When a
 * new Jellyfin user takes over a name the account's entries are dropped, but a
 * request that resolved its session just before went on reading with the old
 * credential and stored the old user's answers for the new user (a minute for
 * details, 30 days for suggestions).
 *
 * Callers must treat the value as read-only: every request inside the lifetime
 * receives the same object.
 */
import type { StoredCredential } from './backends';
import { foldName } from './names';

/** Whose answer an entry is: the account, and the upstream user its credential signs in as. */
export interface MemoScope {
	accountId: string;
	credential: StoredCredential;
}

function viewerOf(credential: StoredCredential): string {
	return credential.kind === 'jellyfin' ? credential.userId : foldName(credential.username);
}

/** How often expired entries are swept out; see `get`. */
const SWEEP_MS = 10_000;

export class Memo {
	readonly #entries = new Map<string, { value: Promise<unknown>; until: number; accountId: string }>();
	readonly #perAccount = new Map<string, number>();
	readonly #ttlMs: number;
	readonly #max: number;
	readonly #maxPerAccount: number;
	#sweptAt = 0;

	/**
	 * Entries live `ttlMs` and at most `max` are held, oldest dropped first.
	 *
	 * One account holds at most a quarter of them. With a shared bound, one
	 * request that read 300 albums of an artist dropped every other account's
	 * details.
	 */
	constructor(ttlMs: number, max: number) {
		this.#ttlMs = ttlMs;
		this.#max = max;
		this.#maxPerAccount = Math.max(8, Math.floor(max / 4));
	}

	/**
	 * The value for `scope` and `key`, from memory while fresh. `ttlFor` sets
	 * the lifetime from the resolved value, so an empty answer can be held for
	 * less time than a full one.
	 */
	get<T>(scope: MemoScope, key: string, load: () => Promise<T>, ttlFor?: (value: T) => number): Promise<T> {
		const full = `${scope.accountId}\u0000${viewerOf(scope.credential)}\u0000${key}`;
		const held = this.#entries.get(full);
		if (held && held.until > Date.now()) return held.value as Promise<T>;

		this.#sweep();
		const value = load();
		const entry = { value: value as Promise<unknown>, until: Date.now() + this.#ttlMs, accountId: scope.accountId };
		// Deleted first, so the entry moves to the end of the insertion order,
		// which the eviction below reads as age.
		this.#delete(full);
		this.#entries.set(full, entry);
		this.#perAccount.set(scope.accountId, (this.#perAccount.get(scope.accountId) ?? 0) + 1);
		if ((this.#perAccount.get(scope.accountId) ?? 0) > this.#maxPerAccount) this.#evictOldest(scope.accountId);
		if (this.#entries.size > this.#max) this.#delete(this.#entries.keys().next().value!);

		value.then(
			(resolved) => {
				if (ttlFor) entry.until = Date.now() + ttlFor(resolved);
			},
			() => {
				if (this.#entries.get(full) === entry) this.#delete(full);
			}
		);
		return value;
	}

	/** Drops one entry, whichever upstream user it was read as. */
	forget(accountId: string, key: string): void {
		const prefix = `${accountId}\u0000`;
		const suffix = `\u0000${key}`;
		for (const full of [...this.#entries.keys()]) {
			if (full.startsWith(prefix) && full.endsWith(suffix)) this.#delete(full);
		}
	}

	/**
	 * Drops every entry held for an account, reads in flight included, so a
	 * request after this call starts a fresh read and does not wait on one that
	 * may predate the write that prompted this.
	 */
	forgetAccount(accountId: string): void {
		const prefix = `${accountId}\u0000`;
		for (const full of [...this.#entries.keys()]) {
			if (full.startsWith(prefix)) this.#delete(full);
		}
	}

	#delete(full: string): void {
		const entry = this.#entries.get(full);
		if (!entry) return;
		this.#entries.delete(full);
		const count = (this.#perAccount.get(entry.accountId) ?? 1) - 1;
		if (count > 0) this.#perAccount.set(entry.accountId, count);
		else this.#perAccount.delete(entry.accountId);
	}

	#evictOldest(accountId: string): void {
		for (const [full, entry] of this.#entries) {
			if (entry.accountId === accountId) {
				this.#delete(full);
				return;
			}
		}
	}

	/*
	 * Without this an expired entry was only replaced or evicted, never
	 * removed: 256 artist listings of a large library held 170MB past their
	 * minute.
	 */
	#sweep(): void {
		const at = Date.now();
		if (at - this.#sweptAt < SWEEP_MS) return;
		this.#sweptAt = at;
		for (const [full, entry] of [...this.#entries]) {
			if (entry.until <= at) this.#delete(full);
		}
	}
}
