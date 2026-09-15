import type { AudioQuality, Song } from '$lib/types';

export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
		return '--:--';
	}
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
	}
	return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Long-form duration for album/playlist headers: "1 hr 12 min". */
export function formatLongDuration(seconds: number | null | undefined): string {
	if (!seconds || !Number.isFinite(seconds)) return '';
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	if (hours > 0) return `${hours} hr ${minutes} min`;
	return `${minutes} min`;
}

export function formatBytes(bytes: number | null): string {
	if (!bytes) return '';
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The badge shown next to the transport controls: "FLAC 24/96" for lossless,
 * "MP3 320" for lossy. Sample rates are rendered in kHz because that is how
 * every mastering spec and every hi-res store writes them.
 */
export function formatQuality(quality: AudioQuality): string {
	const format = quality.format?.toUpperCase() ?? '';
	if (quality.lossless) {
		const depth = quality.bitDepth;
		const rate = quality.sampleRateHz ? quality.sampleRateHz / 1000 : null;
		if (depth && rate) {
			// 44.1 and 88.2 need the decimal; 48/96/192 do not.
			const rateLabel = Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
			return `${format} ${depth}/${rateLabel}`;
		}
		if (rate) return `${format} ${Number.isInteger(rate) ? rate : rate.toFixed(1)} kHz`;
		return format || 'Lossless';
	}
	if (quality.bitrateKbps) return `${format} ${quality.bitrateKbps}`;
	return format;
}

export function qualityDetail(quality: AudioQuality): string[] {
	const parts: string[] = [];
	if (quality.format) parts.push(quality.format.toUpperCase());
	if (quality.bitDepth) parts.push(`${quality.bitDepth}-bit`);
	if (quality.sampleRateHz) parts.push(`${(quality.sampleRateHz / 1000).toFixed(1).replace(/\.0$/, '')} kHz`);
	if (quality.channels) parts.push(quality.channels === 2 ? 'Stereo' : `${quality.channels} ch`);
	if (quality.bitrateKbps) parts.push(`${quality.bitrateKbps} kbps`);
	if (quality.sizeBytes) parts.push(formatBytes(quality.sizeBytes));
	return parts;
}

export function coverUrl(coverArt: string | null | undefined, size: number): string {
	if (!coverArt) return '';
	return `/api/cover/${encodeURIComponent(coverArt)}?size=${size}`;
}

/**
 * The stream URL, carrying the delivery mode.
 *
 * The server decides what to send from the account's settings and ignores this
 * value. It is in the URL because a browser caches a stream per URL: without it
 * the original file, already fetched and held, would answer the request made
 * after transcoding was switched on.
 */
export function streamUrl(songId: string, mode: string = 'raw'): string {
	return `/api/stream/${encodeURIComponent(songId)}?mode=${encodeURIComponent(mode)}`;
}

export function songSubtitle(song: Song): string {
	return [song.artist, song.album].filter(Boolean).join(' · ');
}
