/**
 * A playlist file read into tracks to look for in the library
 * (`/api/playlists/match`). Read in the browser: a Spotify data export holds
 * every playlist of the account, more than a request body takes, and only the
 * one picked is sent.
 *
 * What is read:
 *
 * - M3U and M3U8: `#EXTINF:length,Artist - Title` where there is one, and
 *   otherwise the file name ("01 - Artist - Title.flac") and its folder for
 *   the album.
 * - CSV, and the tab-separated text Apple Music's "Export Playlist" writes
 *   (UTF-16): a header row names the columns ("Track Name", "Artist Name(s)"
 *   and "Duration (ms)" from Exportify; "Name", "Artist", "Album" and "Time"
 *   from Apple Music; "title", "artist", "album" and "duration_seconds" from
 *   Heddohon's own export).
 * - JSON: Spotify's account data (`Playlist1.json`: `playlists`, each with
 *   `items` of `track`), or a list of tracks with title and artist fields.
 * - XML: Apple Music's playlist or library export (a property list), each
 *   playlist with the tracks it lists.
 */

export interface FileTrack {
	title: string;
	artist: string | null;
	album: string | null;
	/** Seconds. */
	duration: number | null;
}

export interface FilePlaylist {
	name: string;
	tracks: FileTrack[];
}

/** The file's text: UTF-16 where it starts with a byte order mark, as Apple Music writes it, and UTF-8 otherwise. */
export function decode(bytes: ArrayBuffer): string {
	const head = new Uint8Array(bytes.slice(0, 2));
	const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8';
	return new TextDecoder(encoding).decode(bytes).replace(/^﻿/, '');
}

/** The file's name without its extension, for a playlist name where the file has none. */
function baseName(file: string): string {
	return file.replace(/\.[^.]+$/, '').trim() || 'Imported playlist';
}

function clean(value: unknown): string | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const text = String(value).trim();
	return text || null;
}

/** "Artist - Title", or the title alone where there is no " - ". */
function splitNamed(text: string): { artist: string | null; title: string } {
	const at = text.indexOf(' - ');
	if (at <= 0) return { artist: null, title: text.trim() };
	return { artist: text.slice(0, at).trim() || null, title: text.slice(at + 3).trim() };
}

function readM3u(text: string, file: string): FilePlaylist[] {
	let name = baseName(file);
	const tracks: FileTrack[] = [];
	let info: { duration: number | null; artist: string | null; title: string } | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith('#PLAYLIST:')) {
			name = line.slice(10).trim() || name;
		} else if (line.startsWith('#EXTINF:')) {
			const comma = line.indexOf(',');
			const seconds = Number.parseFloat(line.slice(8, comma < 0 ? undefined : comma));
			const named = splitNamed(comma < 0 ? '' : line.slice(comma + 1));
			info = { duration: seconds > 0 ? seconds : null, ...named };
		} else if (!line.startsWith('#')) {
			const parts = line.replace(/\\/g, '/').split('/').filter(Boolean);
			const fileName = decodeURIComponentSafe(parts.at(-1) ?? '').replace(/\.[^.]+$/, '');
			const fromFile = splitNamed(fileName.replace(/^\d{1,3}(?:[-.]\d{1,3})?\s*[-.]?\s+/, ''));
			const album = parts.length >= 2 ? decodeURIComponentSafe(parts.at(-2) ?? '') : null;
			const title = info?.title || fromFile.title;
			if (title) {
				tracks.push({
					title,
					artist: info?.artist ?? fromFile.artist ?? (parts.length >= 3 ? decodeURIComponentSafe(parts.at(-3) ?? '') : null),
					album: album || null,
					duration: info?.duration ?? null
				});
			}
			info = null;
		}
	}
	return [{ name, tracks }];
}

function decodeURIComponentSafe(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** Rows of a CSV or tab-separated file: quotes as RFC 4180 has them, either separator. */
function rows(text: string, separator: string): string[][] {
	const out: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
		} else if (char === '"' && field === '') {
			quoted = true;
		} else if (char === separator) {
			row.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.some((cell) => cell.trim())) out.push(row);
			row = [];
		} else {
			field += char;
		}
	}
	row.push(field);
	if (row.some((cell) => cell.trim())) out.push(row);
	return out;
}

const TITLE_COLUMNS = ['track name', 'title', 'name', 'song', 'song name', 'track', 'track title'];
const ARTIST_COLUMNS = ['artist name(s)', 'artist name', 'artist', 'artists', 'album artist'];
const ALBUM_COLUMNS = ['album name', 'album', 'release', 'album title'];
const DURATION_COLUMNS = ['duration (ms)', 'duration_ms', 'duration_seconds', 'duration', 'time', 'length'];

/** A length as a column holds it: milliseconds where the header says so or the value is that large, "m:ss", or seconds. */
function seconds(value: string | null, header: string): number | null {
	if (!value) return null;
	if (/^\d+:\d{1,2}(?::\d{1,2})?$/.test(value)) {
		return value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) || null;
	}
	const number = Number.parseFloat(value);
	if (!(number > 0)) return null;
	return /ms|millis/.test(header) || number > 36_000 ? number / 1000 : number;
}

function readTable(text: string, file: string): FilePlaylist[] {
	const end = text.search(/\r?\n/);
	const first = end < 0 ? text : text.slice(0, end);
	const separator = first.includes('\t') ? '\t' : !first.includes(',') && first.includes(';') ? ';' : ',';
	const [header, ...body] = rows(text, separator);
	if (!header) return [{ name: baseName(file), tracks: [] }];
	const names = header.map((cell) => cell.trim().toLowerCase());
	const column = (wanted: string[]) => {
		for (const name of wanted) {
			const at = names.indexOf(name);
			if (at >= 0) return at;
		}
		return -1;
	};
	const [title, artist, album, duration] = [column(TITLE_COLUMNS), column(ARTIST_COLUMNS), column(ALBUM_COLUMNS), column(DURATION_COLUMNS)];
	if (title < 0) throw new Error('The file has no column for the track name (Title, Name or Track Name).');
	const tracks: FileTrack[] = [];
	for (const row of body) {
		const name = clean(row[title]);
		if (!name) continue;
		// Exportify lists every artist of a track, comma-separated; the first is the one to look for.
		const artists = artist < 0 ? null : clean(row[artist]);
		tracks.push({
			title: name,
			artist: artists && names[artist] === 'artist name(s)' ? artists.split(',')[0].trim() : artists,
			album: album < 0 ? null : clean(row[album]),
			duration: duration < 0 ? null : seconds(clean(row[duration]), names[duration])
		});
	}
	return [{ name: baseName(file), tracks }];
}

/** A track from a JSON object, by whichever of the usual keys it has. */
function jsonTrack(raw: unknown): FileTrack | null {
	if (!raw || typeof raw !== 'object') return null;
	const item = raw as Record<string, unknown>;
	if (item.track && typeof item.track === 'object') return jsonTrack(item.track);
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = item[key];
			if (Array.isArray(value)) {
				const first = value[0] as unknown;
				const named = first && typeof first === 'object' ? (first as Record<string, unknown>).name : first;
				if (clean(named)) return clean(named);
			} else if (clean(value)) {
				return clean(value);
			}
		}
		return null;
	};
	const title = pick('trackName', 'title', 'name', 'track_name', 'song');
	if (!title) return null;
	const ms = Number(item.durationMs ?? item.duration_ms ?? item.msPlayed ?? NaN);
	const plain = Number(item.duration ?? item.duration_seconds ?? NaN);
	return {
		title,
		artist: pick('artistName', 'artist', 'artists', 'artist_name'),
		album: pick('albumName', 'album', 'album_name'),
		duration: ms > 0 ? ms / 1000 : plain > 0 ? (plain > 36_000 ? plain / 1000 : plain) : null
	};
}

function readJson(text: string, file: string): FilePlaylist[] {
	const data = JSON.parse(text) as unknown;
	const listOf = (items: unknown) => (Array.isArray(items) ? items.map(jsonTrack).filter((track): track is FileTrack => track !== null) : []);
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const record = data as Record<string, unknown>;
		if (Array.isArray(record.playlists)) {
			return record.playlists.map((raw, index) => {
				const playlist = (raw ?? {}) as Record<string, unknown>;
				return { name: clean(playlist.name) ?? `Playlist ${index + 1}`, tracks: listOf(playlist.items ?? playlist.tracks) };
			});
		}
		const items = record.tracks ?? record.items;
		if (Array.isArray(items)) return [{ name: clean(record.name) ?? baseName(file), tracks: listOf(items) }];
	}
	return [{ name: baseName(file), tracks: listOf(data) }];
}

/** The value element after `<key>name</key>` in a property list `<dict>`. */
function plistValue(dict: Element, name: string): Element | null {
	const children = [...dict.children];
	const at = children.findIndex((child) => child.tagName === 'key' && child.textContent === name);
	return at >= 0 ? (children[at + 1] ?? null) : null;
}

function readPlist(text: string, file: string): FilePlaylist[] {
	const doc = new DOMParser().parseFromString(text, 'application/xml');
	if (doc.querySelector('parsererror')) throw new Error('The XML file could not be read.');
	const root = doc.querySelector('plist > dict');
	if (!root) throw new Error('The XML file is not an Apple Music export.');
	const tracks = new Map<string, FileTrack>();
	const library = plistValue(root, 'Tracks');
	if (library) {
		for (const child of library.children) {
			if (child.tagName !== 'dict') continue;
			const field = (name: string) => clean(plistValue(child, name)?.textContent);
			const title = field('Name');
			const id = field('Track ID');
			if (!title || !id) continue;
			const ms = Number(field('Total Time'));
			tracks.set(id, { title, artist: field('Artist'), album: field('Album'), duration: ms > 0 ? ms / 1000 : null });
		}
	}
	const playlists: FilePlaylist[] = [];
	for (const playlist of plistValue(root, 'Playlists')?.children ?? []) {
		if (playlist.tagName !== 'dict') continue;
		// The library itself and the lists Music keeps (Music, Downloaded) are not playlists to import.
		if (plistValue(playlist, 'Master') || plistValue(playlist, 'Distinguished Kind')) continue;
		const items = [...(plistValue(playlist, 'Playlist Items')?.children ?? [])]
			.map((item) => tracks.get(clean(plistValue(item, 'Track ID')?.textContent) ?? ''))
			.filter((track): track is FileTrack => track !== undefined);
		playlists.push({ name: clean(plistValue(playlist, 'Name')?.textContent) ?? baseName(file), tracks: items });
	}
	return playlists.length > 0 ? playlists : [{ name: baseName(file), tracks: [...tracks.values()] }];
}

/**
 * The playlists in a file, each with its tracks. Throws an `Error` whose
 * message says what is wrong with a file it cannot read.
 */
export function readPlaylistFile(text: string, file: string): FilePlaylist[] {
	const start = text.trimStart();
	const extension = /\.([^.]+)$/.exec(file)?.[1]?.toLowerCase() ?? '';
	let playlists: FilePlaylist[];
	if (start.startsWith('#EXTM3U') || extension === 'm3u' || extension === 'm3u8') playlists = readM3u(text, file);
	else if (start.startsWith('<')) playlists = readPlist(text, file);
	else if (start.startsWith('{') || start.startsWith('[')) {
		try {
			playlists = readJson(text, file);
		} catch {
			throw new Error('The JSON file could not be read.');
		}
	} else playlists = readTable(text, file);
	const found = playlists.filter((playlist) => playlist.tracks.length > 0);
	if (found.length === 0) throw new Error('No tracks were found in the file.');
	return found;
}
