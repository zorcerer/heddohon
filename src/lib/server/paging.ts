/**
 * Page slicing for listings the music servers return whole.
 *
 * Subsonic's `getArtists` and `getStarred2` have no offset parameter — they hand
 * back the entire set in one response. Rendering ten thousand cards is avoidable:
 * the expensive part is the DOM and the serialised payload, and both are fixed by
 * slicing before the page is rendered. The request itself is paid once a minute
 * per account for artists, through `listings.ts`, rather than once per page.
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
	// A page number past the end lands on the last page rather than showing
	// nothing, which is what a stale bookmark or a shrinking library produces.
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
