/**
 * Internet radio: the stations the music server lists, and their streams.
 *
 * Navidrome keeps a list of stations, each a name and a stream address on
 * another host. The browser talks only to Heddohon (its pages' policy allows
 * media from this origin alone), so this server fetches the stream and passes
 * the bytes on.
 *
 * This is the one place the server fetches an address it was not configured
 * with, so the address is held to rules:
 *
 *  - It comes from the music server's list for the signed-in account, looked
 *    up by the station's id. Nothing a request carries is fetched.
 *  - http or https, without a user name or password in it.
 *  - Every address its host resolves to is public, unless
 *    `HEDDOHON_RADIO_PRIVATE=true`. Otherwise a station pointed at the local
 *    network would read whatever answers there back out as "audio". The check
 *    is made in the connection's own lookup, and each request dials its own
 *    connection, so the address checked is the address dialled.
 *  - A redirect is followed up to three times, each hop under the same rules.
 *    A playlist file (.m3u, .pls) counts as one: its first address is the
 *    stream.
 *  - Where a hop leads is written by whoever answered it, not by the music
 *    server's administrator. So with `HEDDOHON_RADIO_PRIVATE=true` a hop
 *    served from a public address still leads only to public ones. Only a hop
 *    that was itself on a private address may lead to another.
 *  - The answer has to say it is audio. Anything else is dropped unread. An
 *    HLS playlist is a list of segments, not a stream, and is not played.
 *
 * The stream is sent on as it arrives, with its type and no length. It ends
 * when the listener leaves, when the session ends, or when it stalls.
 */
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { RadioStation } from '$lib/types';
import type { AuthenticatedSession } from './auth';
import { backendFor } from './backends';
import type { RadioStationSource } from './backends/types';
import { config } from './config';
import { log, reason } from './log';
import { MEDIA_CSP } from './proxy';
import { isPublic, privateAllowedAfter } from './radio-guard';
import { APP_VERSION } from './version';

/** To the first byte of the answer. After that only the stall limit below applies. */
const CONNECT_TIMEOUT_MS = 10_000;
/** A stream that sends nothing for this long is cut. */
const STALL_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
/** Stations one account plays at once: a tab each on a few devices. */
const MAX_STREAMS_PER_ACCOUNT = 4;
/** The types a playlist file is served as, and the most of one that is read. */
const PLAYLIST_TYPES = new Set(['audio/x-mpegurl', 'audio/mpegurl', 'audio/x-scpls', 'application/pls+xml']);
const MAX_PLAYLIST_BYTES = 64 * 1024;

export class RadioError extends Error {
	constructor(
		message: string,
		readonly kind: 'unknown' | 'refused' | 'unreachable' | 'not_audio' | 'busy'
	) {
		super(message);
	}
}

/** Whether this deployment and this account's music server offer stations. */
export function radioEnabled(session: AuthenticatedSession | null): boolean {
	return Boolean(session && config().radio && backendFor(session.account.backend).getRadioStations);
}

async function sources(session: AuthenticatedSession): Promise<RadioStationSource[]> {
	const list = backendFor(session.account.backend).getRadioStations;
	if (!config().radio || !list) return [];
	return list(session.credential);
}

/** A station's own page, if it is an http or https address: it becomes a link. */
function homePage(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}

/** The stations for the Radio page, without their stream addresses. */
export async function radioStations(session: AuthenticatedSession): Promise<RadioStation[]> {
	return (await sources(session)).map((station) => ({ id: station.id, name: station.name, homePage: homePage(station.homePageUrl) }));
}

/** The address as a URL this server will fetch, or a refusal. `mayBePrivate`: this hop may be on a private address. */
function allowed(raw: string, mayBePrivate: boolean): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new RadioError('The station has no usable address', 'refused');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RadioError('The station is not an http or https address', 'refused');
	if (url.username || url.password) throw new RadioError('The station address carries a user name or password', 'refused');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	// A literal address is never looked up, so it is checked here.
	const family = isIP(host);
	if (family !== 0 && !mayBePrivate && !isPublic(host, family)) {
		throw new RadioError('The station is on a private address', 'refused');
	}
	return url;
}

/** DNS for the connection. Refuses a name with any non-public address, unless this hop may be on one. */
const guardedLookup = (mayBePrivate: boolean): LookupFunction => (hostname, options, callback) => {
	dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err, '', 0);
		if (!mayBePrivate && addresses.some((entry) => !isPublic(entry.address, entry.family))) {
			return callback(Object.assign(new Error('The station resolves to a private address'), { code: 'EPRIVATE' }), '', 0);
		}
		// Node asks for every address when it races families, and for one otherwise.
		if ((options as { all?: boolean }).all) (callback as unknown as (err: null, list: typeof addresses) => void)(null, addresses);
		else callback(null, addresses[0].address, addresses[0].family);
	});
};

function request(url: URL, signal: AbortSignal, mayBePrivate: boolean): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const outgoing = (url.protocol === 'https:' ? https : http).request(url, {
			method: 'GET',
			headers: { accept: 'audio/*', 'user-agent': `Heddohon/${APP_VERSION} (https://github.com/zorcerer/heddohon)` },
			lookup: guardedLookup(mayBePrivate),
			// Its own connection: a kept one was looked up under an earlier request's rule.
			agent: false,
			signal
		});
		const timer = setTimeout(() => outgoing.destroy(new Error('The station did not answer in time')), CONNECT_TIMEOUT_MS);
		outgoing.once('response', (response) => {
			clearTimeout(timer);
			resolve(response);
		});
		outgoing.once('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		outgoing.end();
	});
}

/** The first address in an .m3u or .pls body, or null for an HLS playlist or one with none. */
async function firstInPlaylist(response: http.IncomingMessage): Promise<string | null> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of response) {
		total += (chunk as Buffer).length;
		if (total > MAX_PLAYLIST_BYTES) {
			response.destroy();
			return null;
		}
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (text.includes('#EXT-X-')) return null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim().replace(/^File\d+=/i, '');
		if (/^https?:\/\//i.test(line)) return line;
	}
	return null;
}

const active = new Map<string, number>();

/**
 * The stream of station `id` for this session, as a response to send on.
 * Throws `RadioError`: `unknown` for an id the music server does not list,
 * `refused` for an address the rules above turn down, `unreachable` when the
 * station does not answer, `not_audio` when it answers with something else,
 * `busy` past `MAX_STREAMS_PER_ACCOUNT`.
 */
export async function openStation(session: AuthenticatedSession, id: string, client: AbortSignal): Promise<Response> {
	const station = (await sources(session)).find((entry) => entry.id === id);
	if (!station) throw new RadioError('No such station', 'unknown');

	const account = session.account.id;
	if ((active.get(account) ?? 0) >= MAX_STREAMS_PER_ACCOUNT) throw new RadioError('Too many stations are playing on this account', 'busy');
	active.set(account, (active.get(account) ?? 0) + 1);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const left = (active.get(account) ?? 1) - 1;
		if (left > 0) active.set(account, left);
		else active.delete(account);
	};

	const controller = new AbortController();
	const stop = () => controller.abort();
	client.addEventListener('abort', stop, { once: true });

	try {
		// The station's own address is the administrator's. The hops after it are not; see the top of the file.
		let mayBePrivate = config().radioPrivate;
		let url = allowed(station.streamUrl, mayBePrivate);
		let response: http.IncomingMessage | null = null;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const answer = await request(url, controller.signal, mayBePrivate).catch((err) => {
				if (err instanceof RadioError) throw err;
				throw new RadioError(
					(err as NodeJS.ErrnoException).code === 'EPRIVATE' ? 'The station resolves to a private address' : `The station could not be reached: ${reason(err)}`,
					(err as NodeJS.ErrnoException).code === 'EPRIVATE' ? 'refused' : 'unreachable'
				);
			});
			mayBePrivate = privateAllowedAfter(mayBePrivate, answer.socket.remoteAddress);
			const status = answer.statusCode ?? 0;
			if (status >= 300 && status < 400 && answer.headers.location) {
				answer.destroy();
				url = allowed(new URL(answer.headers.location, url).href, mayBePrivate);
				continue;
			}
			if (status !== 200) {
				answer.destroy();
				throw new RadioError(`The station answered HTTP ${status}`, 'unreachable');
			}
			if (PLAYLIST_TYPES.has((answer.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase())) {
				const listed = await firstInPlaylist(answer);
				if (!listed) throw new RadioError('The station is a playlist with no stream this server can pass on', 'not_audio');
				url = allowed(new URL(listed, url).href, mayBePrivate);
				continue;
			}
			response = answer;
			break;
		}
		if (!response) throw new RadioError('The station redirects too many times', 'unreachable');

		const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
		if (!type.startsWith('audio/') && type !== 'application/ogg') {
			response.destroy();
			throw new RadioError(`The station sent ${type || 'no content type'}, which is not an audio stream`, 'not_audio');
		}

		const upstream = response;
		upstream.setTimeout(STALL_TIMEOUT_MS, () => upstream.destroy(new Error('The station stopped sending')));
		upstream.once('close', () => {
			release();
			client.removeEventListener('abort', stop);
		});
		log.debug('radio', { station: station.id, host: url.host, type });
		return new Response(Readable.toWeb(upstream) as ReadableStream<Uint8Array>, {
			headers: {
				'content-type': type,
				// As on the music server's own media: inert if it is opened as a page. See `MEDIA_CSP`.
				'content-security-policy': MEDIA_CSP,
				// Live: nothing to cache, and a proxy in front must not hold it back.
				'cache-control': 'no-store',
				'x-accel-buffering': 'no'
			}
		});
	} catch (err) {
		controller.abort();
		release();
		client.removeEventListener('abort', stop);
		if (err instanceof RadioError && err.kind !== 'unknown') {
			log.warn('radio-failed', { station: station.id, kind: err.kind, detail: err.message });
		}
		throw err;
	}
}
