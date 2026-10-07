/**
 * Page slicing for listings the music servers return whole.
 *
 * Subsonic's `getArtists` and `getStarred2` have no offset parameter. Slicing
 * before the page is rendered bounds the DOM and the serialised payload. The
 * request itself is held by `listings.ts`.
 */
export const PAGE_SIZE = 100;

export interface Page<T> {
	items: T[];
	page: number;
	pageCount: number;
	total: number;
	hasPrevious: boolean;
	hasNext: boolean;
}

export function readPageNumber(params: URLSearchParams, key = 'page'): number {
	const raw = Number.parseInt(params.get(key) ?? '1', 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function paginate<T>(items: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
	const total = items.length;
	const pageCount = Math.max(1, Math.ceil(total / size));
	// A page number past the end (a stale bookmark, a library that shrank) lands
	// on the last page.
	const current = Math.min(Math.max(1, page), pageCount);
	const start = (current - 1) * size;

	return {
		items: items.slice(start, start + size),
		page: current,
		pageCount,
		total,
		hasPrevious: current > 1,
		hasNext: current < pageCount
	};
}
