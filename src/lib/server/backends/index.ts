import type { BackendKind } from '$lib/types';
import { jellyfinBackend } from './jellyfin';
import { subsonicBackend } from './subsonic';
import type { MediaBackend } from './types';

const REGISTRY: Record<BackendKind, MediaBackend> = {
	subsonic: subsonicBackend,
	jellyfin: jellyfinBackend
};

export function backendFor(kind: BackendKind): MediaBackend {
	const backend = REGISTRY[kind];
	if (!backend) throw new Error(`Unknown backend: ${kind}`);
	return backend;
}

export function isBackendKind(value: unknown): value is BackendKind {
	return value === 'subsonic' || value === 'jellyfin';
}

export type { MediaBackend, StoredCredential, StreamRequest, UpstreamResponse } from './types';
export { UpstreamError } from './http';
