/**
 * A song's audio, as the music server sends it, to the samples the analysis
 * reads (issue #316, part of #312): an excerpt, mono, at 22.05kHz.
 *
 * ffmpeg does the decoding, as a child process fed through a pipe. The audio
 * reaches it on its standard input and nothing about the music server is on
 * its command line, where `ps` would show a credential to every process on
 * the host. The image carries a 3MB build with only the audio decoders
 * (`Dockerfile`); outside the image it is whichever `ffmpeg` is on the path.
 *
 * The excerpt is 90 seconds from 30 seconds in, past most intros, or the last
 * 90 seconds of a shorter song. ffmpeg stops reading once it has them, and
 * the download is cancelled there: about the first two minutes of the file.
 *
 * This module imports nothing of the app's configuration, so
 * `tests/e2e/analysis-decode.test.mjs` runs it directly.
 */
import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { Readable } from 'node:stream';

/** The rate the analysis works at: 11kHz of bandwidth, which holds what the measures read. */
export const ANALYSIS_RATE = 22050;
/** Seconds skipped at the start of a song long enough to spare them. */
export const EXCERPT_FROM = 30;
/** Seconds analysed. */
export const EXCERPT_LENGTH = 90;

/** How long one song may take before ffmpeg is stopped. */
const DECODE_TIMEOUT_MS = 120_000;
/** What is kept of ffmpeg's own words for a failure. */
const STDERR_MAX = 300;

/**
 * Why a song gave no samples: `missing`, no ffmpeg to run; `failed`, ffmpeg
 * refused the file; `empty`, it decoded to nothing; `timeout`; `aborted`, the
 * caller's signal.
 */
export class DecodeError extends Error {
	readonly kind: 'missing' | 'failed' | 'empty' | 'timeout' | 'aborted';
	constructor(kind: DecodeError['kind'], message: string) {
		super(message);
		this.name = 'DecodeError';
		this.kind = kind;
	}
}

export interface DecodeOptions {
	/** The song's length in seconds as the music server reports it, to place the excerpt; unknown reads from 30s. */
	duration?: number | null;
	/** The ffmpeg to run. */
	ffmpeg?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Where the excerpt starts in a song of `duration` seconds. */
export function excerptStart(duration: number | null | undefined): number {
	if (!duration || !Number.isFinite(duration)) return EXCERPT_FROM;
	if (duration >= EXCERPT_FROM + EXCERPT_LENGTH) return EXCERPT_FROM;
	return Math.max(0, Math.floor(duration - EXCERPT_LENGTH));
}

/**
 * Decodes the excerpt of `audio` to mono floats at `ANALYSIS_RATE`. Reads as
 * much of `audio` as the excerpt needs and cancels the rest. Rejects with a
 * `DecodeError`, and leaves no process running either way.
 */
export function decodeExcerpt(audio: ReadableStream<Uint8Array>, options: DecodeOptions = {}): Promise<Float32Array> {
	const { ffmpeg = 'ffmpeg', signal, timeoutMs = DECODE_TIMEOUT_MS } = options;
	const from = excerptStart(options.duration);
	// The seek is on the output side: a pipe cannot be sought, so ffmpeg
	// decodes from the start and drops what comes before `from`.
	const args = ['-nostdin', '-v', 'error', '-i', 'pipe:0', '-ss', String(from), '-t', String(EXCERPT_LENGTH), '-vn', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', 'pipe:1'];
	const limit = (EXCERPT_LENGTH + 1) * ANALYSIS_RATE * 4;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			void audio.cancel().catch(() => undefined);
			reject(new DecodeError('aborted', 'The decode was stopped.'));
			return;
		}
		const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const input = Readable.fromWeb(audio as import('node:stream/web').ReadableStream<Uint8Array>);
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = '';
		let ended: DecodeError | null = null;
		let settled = false;

		const stop = (why: DecodeError) => {
			ended ??= why;
			child.kill('SIGKILL');
		};
		const timer = setTimeout(() => stop(new DecodeError('timeout', `ffmpeg took longer than ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
		const onAbort = () => stop(new DecodeError('aborted', 'The decode was stopped.'));
		signal?.addEventListener('abort', onAbort, { once: true });

		const finish = (outcome: Float32Array | DecodeError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			// The rest of the file is not wanted: stop the download.
			input.destroy();
			if (outcome instanceof DecodeError) reject(outcome);
			else resolve(outcome);
		};

		child.on('spawn', () => {
			// Below everything else on the host: the analysis is never in a hurry.
			try {
				if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_LOW);
			} catch {
				// A host that refuses leaves it at the server's own priority.
			}
		});
		child.on('error', (err: NodeJS.ErrnoException) => {
			finish(
				err.code === 'ENOENT'
					? new DecodeError('missing', `No ffmpeg to decode with: "${ffmpeg}" was not found.`)
					: new DecodeError('failed', `ffmpeg did not start: ${err.message}`)
			);
		});
		// ffmpeg closes its input once it has the excerpt; the write that
		// follows fails with EPIPE, which is the end, not an error.
		child.stdin.on('error', () => undefined);
		input.on('error', (err) => stop(new DecodeError('failed', `The audio stopped arriving: ${err.message}`)));
		input.pipe(child.stdin);

		child.stdout.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > limit) return stop(new DecodeError('failed', 'ffmpeg wrote more than the excerpt holds.'));
			chunks.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < STDERR_MAX) stderr += chunk.toString('utf8');
		});
		child.on('close', (code) => {
			if (ended) return finish(ended);
			const said = stderr.trim().split('\n')[0]?.slice(0, STDERR_MAX) ?? '';
			if (code !== 0 && bytes === 0) return finish(new DecodeError('failed', said || `ffmpeg ended with code ${code}.`));
			const whole = bytes - (bytes % 4);
			if (whole === 0) return finish(new DecodeError('empty', said || 'The file decoded to no audio.'));
			// Into a buffer of its own, which starts on a 4-byte boundary.
			const samples = new Float32Array(whole / 4);
			const view = new Uint8Array(samples.buffer);
			let at = 0;
			for (const chunk of chunks) {
				const take = Math.min(chunk.length, whole - at);
				view.set(chunk.subarray(0, take), at);
				at += take;
				if (at >= whole) break;
			}
			finish(samples);
		});
	});
}
