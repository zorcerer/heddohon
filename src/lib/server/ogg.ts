/**
 * An Ogg stream with its serial numbers fixed, so that two reads of one
 * transcode are the same bytes.
 *
 * ffmpeg gives each Ogg stream it writes a random serial number. Every page
 * carries it, under a checksum of the page. Jellyfin 12.1.0, asked twice for
 * the same Opus transcode, sent 4125406 bytes both times, 2047 of them
 * different: the serial and the checksum of each of the 256 pages, and nothing
 * else. MP3 and AAC came back identical.
 *
 * A browser holds the part of a track it has fetched and asks for the rest by
 * byte range. When the rest came from another read (the copy in
 * `transcodes.ts` dropped after its 15 minutes, lost with a restart, or never
 * held because the limits there were reached), the pages belonged to a stream
 * the decoder did not know. Chromium ended the track at that byte: at 2:36 of
 * 4:46 on 2026-10-06, and the queue moved on.
 *
 * Each page is rewritten with a serial given by the order its stream first
 * appears in, and its checksum recomputed. The sizes do not change. Anything
 * that does not parse as Ogg is passed on untouched from that byte on.
 */

/** "HEDD", plus the stream's index. */
const SERIAL_BASE = 0x48454444;
const HEADER_BYTES = 27;

/** Ogg's CRC-32: polynomial 0x04c11db7, most significant bit first, initial value 0. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let r = i << 24;
		for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
		table[i] = r >>> 0;
	}
	return table;
})();

function checksum(page: Uint8Array): number {
	let crc = 0;
	for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
	return crc;
}

export function stableOgg(): TransformStream<Uint8Array, Uint8Array> {
	let pending: Uint8Array = new Uint8Array(0);
	let passing = false;
	const serials = new Map<number, number>();

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (passing) {
				controller.enqueue(chunk);
				return;
			}
			if (pending.length === 0) pending = chunk;
			else {
				const joined = new Uint8Array(pending.length + chunk.length);
				joined.set(pending);
				joined.set(chunk, pending.length);
				pending = joined;
			}

			let at = 0;
			while (pending.length - at >= HEADER_BYTES) {
				// "OggS", stream structure version 0.
				if (pending[at] !== 0x4f || pending[at + 1] !== 0x67 || pending[at + 2] !== 0x67 || pending[at + 3] !== 0x53 || pending[at + 4] !== 0) {
					passing = true;
					break;
				}
				const segments = pending[at + 26];
				if (pending.length - at < HEADER_BYTES + segments) break;
				let length = HEADER_BYTES + segments;
				for (let i = 0; i < segments; i++) length += pending[at + HEADER_BYTES + i];
				if (pending.length - at < length) break;

				// A copy: the chunk it came in belongs to the reader upstream.
				const page = pending.slice(at, at + length);
				const view = new DataView(page.buffer);
				const serial = view.getUint32(14, true);
				let stable = serials.get(serial);
				if (stable === undefined) {
					stable = (SERIAL_BASE + serials.size) >>> 0;
					serials.set(serial, stable);
				}
				view.setUint32(14, stable, true);
				view.setUint32(22, 0, true);
				view.setUint32(22, checksum(page), true);
				controller.enqueue(page);
				at += length;
			}

			if (passing) {
				controller.enqueue(pending.slice(at));
				pending = new Uint8Array(0);
			} else {
				pending = at === 0 ? pending : pending.slice(at);
			}
		},
		flush(controller) {
			// A page cut short by the end of the body.
			if (pending.length > 0) controller.enqueue(pending);
		}
	});
}
