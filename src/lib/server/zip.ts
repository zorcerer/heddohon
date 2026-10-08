/**
 * A ZIP archive of a few files held in memory, for the database backup
 * (`backup.ts`).
 *
 * Written here and not taken from a package: the server has two runtime
 * dependencies, and the format needs a header before each file, the same
 * headers again in a directory at the end, and a CRC-32 of each file. Each
 * file is deflated. Sizes and offsets are 32-bit, so an archive stays under
 * 4GB; `backup.ts` refuses long before that.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

/** ZIP's CRC-32: polynomial 0xedb88320, least significant bit first. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let r = i;
		for (let bit = 0; bit < 8; bit++) r = r & 1 ? (r >>> 1) ^ 0xedb88320 : r >>> 1;
		table[i] = r >>> 0;
	}
	return table;
})();

function checksum(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** A time as MS-DOS keeps it, in UTC: two seconds to a unit, years from 1980. */
function dosTime(at: Date): { time: number; date: number } {
	return {
		time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
		date: ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()
	};
}

export function zip(entries: ZipEntry[], at: Date = new Date()): Uint8Array {
	const { time, date } = dosTime(at);
	const parts: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const packed = deflateRawSync(entry.data);
		const crc = checksum(entry.data);

		// Version 2.0, names in UTF-8 (bit 11), deflate.
		const fields = Buffer.alloc(26);
		fields.writeUInt16LE(20, 0);
		fields.writeUInt16LE(0x0800, 2);
		fields.writeUInt16LE(8, 4);
		fields.writeUInt16LE(time, 6);
		fields.writeUInt16LE(date, 8);
		fields.writeUInt32LE(crc, 10);
		fields.writeUInt32LE(packed.length, 14);
		fields.writeUInt32LE(entry.data.length, 18);
		fields.writeUInt16LE(name.length, 22);
		fields.writeUInt16LE(0, 24);

		const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), fields, name]);
		parts.push(local, packed);

		// The directory entry: made by version 2.0, the same fields, then no
		// comment, disk 0, no attributes, and where the file's header starts.
		const tail = Buffer.alloc(14);
		tail.writeUInt32LE(offset, 10);
		directory.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), fields, tail, name]));

		offset += local.length + packed.length;
	}

	const listed = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(listed.length, 12);
	end.writeUInt32LE(offset, 16);

	return Buffer.concat([...parts, listed, end]);
}
