/**
 * CSV for the downloads (the listening history, a playlist), as RFC 4180
 * writes it, with lines ending in CRLF.
 */

/**
 * One field. A value a spreadsheet would read as a formula (`=`, `+`, `-`,
 * `@`, a tab or a carriage return first) takes a `'` in front: track names
 * are written by whoever tags the library, not by the account downloading
 * them.
 */
export function csvField(value: string | number | null): string {
	if (value === null) return '';
	let text = String(value);
	if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(fields: (string | number | null)[]): string {
	return `${fields.map(csvField).join(',')}\r\n`;
}
