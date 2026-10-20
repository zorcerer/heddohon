/**
 * A QR code (ISO/IEC 18004) for the TOTP address an authenticator app scans,
 * drawn as SVG by `QrCode.svelte`.
 *
 * Written here rather than taken from a package: the CSP admits no `data:`
 * or `blob:` image, so a library's canvas-to-PNG output could not be shown,
 * and the encoder needed is one mode (bytes) at one level (M, 15% of the
 * code recoverable). It follows Project Nayuki's reference implementation
 * (MIT), and the browser suite reads what it draws back with a decoder.
 */

/** Error correction codewords per block, level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [
	-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28,
	28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28
];
/** Error correction blocks, level M, by version (index 0 unused). */
const BLOCKS = [
	-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
	35, 37, 38, 40, 43, 45, 47, 49
];
/** Level M's two format bits. */
const LEVEL_M = 0;

function rawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const align = Math.floor(version / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function dataCodewords(version: number): number {
	return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

// Reed-Solomon over GF(2^8) with the polynomial 0x11D.
function multiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function divisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = multiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = multiply(root, 0x02);
	}
	return result;
}

function remainder(data: number[], div: number[]): number[] {
	const result = div.map(() => 0);
	for (const byte of data) {
		const factor = byte ^ (result.shift() as number);
		result.push(0);
		div.forEach((coefficient, i) => (result[i] ^= multiply(coefficient, factor)));
	}
	return result;
}

function alignmentPositions(version: number, size: number): number[] {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
	return result;
}

const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0;

const MASKS: ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0,
	(_x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

/** The modules of the smallest code that holds `text`, `true` for dark, by row. */
export function qrModules(text: string): boolean[][] {
	const bytes = Array.from(new TextEncoder().encode(text));
	let version = 1;
	for (; version <= 40; version++) {
		const countBits = version < 10 ? 8 : 16;
		if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
	}
	if (version > 40) throw new Error('Too long for a QR code');

	// The bit stream: byte mode, the count, the bytes, a terminator, padding.
	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) push(byte, 8);
	const capacity = dataCodewords(version) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

	// Split into blocks, add error correction, interleave.
	const blockCount = BLOCKS[version];
	const eccLength = ECC_PER_BLOCK[version];
	const raw = Math.floor(rawDataModules(version) / 8);
	const shortBlocks = blockCount - (raw % blockCount);
	const shortLength = Math.floor(raw / blockCount);
	const div = divisor(eccLength);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < blockCount; i++) {
		const chunk = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
		k += chunk.length;
		const ecc = remainder(chunk, div);
		if (i < shortBlocks) chunk.push(0);
		blocks.push(chunk.concat(ecc));
	}
	const codewords: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(block[i]);
		});
	}

	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const set = (x: number, y: number, dark: boolean) => {
		modules[y][x] = dark;
		fixed[y][x] = true;
	};

	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4]
	]) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const distance = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
			}
		}
	}
	const positions = alignmentPositions(version, size);
	positions.forEach((cx, i) =>
		positions.forEach((cy, j) => {
			if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)) return;
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		})
	);

	const drawFormat = (mask: number) => {
		const value = (LEVEL_M << 3) | mask;
		let rem = value;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const format = ((value << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
		set(8, 7, bit(format, 6));
		set(8, 8, bit(format, 7));
		set(7, 8, bit(format, 8));
		for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
		for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
		for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
		set(8, size - 8, true);
	};
	drawFormat(0);

	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const value = (version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			set(a, b, bit(value, i));
			set(b, a, bit(value, i));
		}
	}

	// The codewords, in the zigzag from the bottom right.
	let index = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vertical = 0; vertical < size; vertical++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vertical : vertical;
				if (!fixed[y][x] && index < codewords.length * 8) {
					modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
					index++;
				}
			}
		}
	}

	const applyMask = (mask: number) => {
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
		}
	};

	// The mask with the lowest penalty (section 7.8.3), which scanners read best.
	let best = 0;
	let lowest = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(mask);
		drawFormat(mask);
		const score = penalty(modules);
		if (score < lowest) {
			lowest = score;
			best = mask;
		}
		applyMask(mask);
	}
	applyMask(best);
	drawFormat(best);
	return modules;
}

function penalty(modules: boolean[][]): number {
	const size = modules.length;
	let score = 0;
	const lines: string[] = [];
	for (let y = 0; y < size; y++) lines.push(modules[y].map((dark) => (dark ? '1' : '0')).join(''));
	for (let x = 0; x < size; x++) lines.push(modules.map((row) => (row[x] ? '1' : '0')).join(''));
	for (const line of lines) {
		for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
		for (const pattern of ['10111010000', '00001011101']) {
			for (let at = line.indexOf(pattern); at >= 0; at = line.indexOf(pattern, at + 1)) score += 40;
		}
	}
	let dark = 0;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (modules[y][x]) dark++;
			if (x + 1 < size && y + 1 < size) {
				const colour = modules[y][x];
				if (modules[y][x + 1] === colour && modules[y + 1][x] === colour && modules[y + 1][x + 1] === colour) score += 3;
			}
		}
	}
	const total = size * size;
	score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
	return score;
}
