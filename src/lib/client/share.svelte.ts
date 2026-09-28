/**
 * Making and withdrawing shared links (to a song, an album or a playlist),
 * and the state behind the share dialog.
 *
 * The dialog is mounted once in the root layout, like the playlist picker, and
 * opened from wherever a song, an album or a playlist is on screen.
 *
 * A link is shown once. The server keeps only a digest of its token, so the
 * link held here is the only copy there is, and closing the dialog drops it.
 */
import type { Song } from '$lib/types';

export const SHARE_LIFETIMES = [
	{ days: 1, label: '1 day' },
	{ days: 7, label: '7 days' },
	{ days: 30, label: '30 days' }
] as const;

export type ShareDays = (typeof SHARE_LIFETIMES)[number]['days'];

/** What the dialog is making a link to. */
export interface ShareSubject {
	kind: 'song' | 'album' | 'playlist';
	id: string;
	title: string;
	/** The artist, for a song or an album. */
	subtitle: string | null;
	coverArt: string | null;
}

export interface MadeLink {
	url: string;
	expiresAt: number;
}

async function readError(response: Response, fallback: string): Promise<string> {
	const payload = (await response.json().catch(() => null)) as { message?: string } | null;
	return payload?.message ?? fallback;
}

class ShareComposer {
	subject = $state<ShareSubject | null>(null);
	days = $state<ShareDays>(7);
	busy = $state(false);
	error = $state<string | null>(null);
	link = $state<MadeLink | null>(null);
	copied = $state(false);

	#copiedTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Whether the dialog is showing. The song and the link are kept until the
	 * closing fade has finished, so the dialog does not empty itself, or flip
	 * back to the lifetime choice, on its way out. The link is still dropped:
	 * 200ms later, rather than on the same frame.
	 */
	visible = $state(false);
	#clearTimer: ReturnType<typeof setTimeout> | undefined;

	/** A song, or anything else as a subject. */
	open(item: Song | ShareSubject) {
		clearTimeout(this.#clearTimer);
		this.subject =
			'kind' in item
				? item
				: { kind: 'song', id: item.id, title: item.title, subtitle: item.artist, coverArt: item.coverArt };
		this.days = 7;
		this.busy = false;
		this.error = null;
		this.link = null;
		this.copied = false;
		this.visible = true;
	}

	close() {
		if (!this.visible) return;
		clearTimeout(this.#copiedTimer);
		this.visible = false;
		// The fade in app.css is 150ms.
		this.#clearTimer = setTimeout(() => {
			this.subject = null;
			this.link = null;
			this.error = null;
			this.copied = false;
		}, 200);
	}

	async create() {
		if (!this.subject || this.busy) return;
		const subject = this.subject;
		this.busy = true;
		this.error = null;
		try {
			const response = await fetch('/api/shares', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ kind: subject.kind, id: subject.id, days: this.days })
			});
			if (!response.ok) throw new Error(await readError(response, 'Could not make a link'));
			const body = (await response.json()) as { path: string; expiresAt: number };
			// Closed, or pointed at something else, while the request was out.
			if (!this.visible || this.subject !== subject) return;
			// The origin this page was loaded from, which is the one the reader can
			// reach. The server's own idea of it can differ behind a proxy.
			this.link = { url: new URL(body.path, location.origin).href, expiresAt: body.expiresAt };
			await this.copy();
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not make a link';
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Puts the link on the clipboard.
	 *
	 * The asynchronous clipboard exists only in a secure context, so a plain-http
	 * deployment reached by address has none. The link is in a selectable field
	 * either way, and a failed copy says so rather than claiming it worked.
	 */
	async copy(): Promise<boolean> {
		if (!this.link) return false;
		try {
			await navigator.clipboard.writeText(this.link.url);
		} catch {
			this.copied = false;
			return false;
		}
		this.copied = true;
		clearTimeout(this.#copiedTimer);
		this.#copiedTimer = setTimeout(() => (this.copied = false), 2400);
		return true;
	}
}

export const shareComposer = new ShareComposer();
