/**
 * `analyse` (`features.ts`) in a worker thread: one worker, started on first
 * use and ended by `stopAnalyser`, so a server that never analyses starts no
 * thread. A worker that dies is started again for the next song, and the
 * song it was on fails with the reason.
 *
 * The samples are moved to the worker, not copied: after the call the caller
 * no longer has them.
 */
import { Worker } from 'node:worker_threads';
import workerUrl from 'virtual:analysis-worker';
import type { SongFeatures } from './features.ts';

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, { resolve: (features: SongFeatures) => void; reject: (err: Error) => void }>();

function started(): Worker {
	if (worker) return worker;
	const created = new Worker(workerUrl);
	// Not a reason to keep the process alive on shutdown.
	created.unref();
	created.on('message', (message: { id: number; features?: SongFeatures; error?: string }) => {
		const pending = waiting.get(message.id);
		if (!pending) return;
		waiting.delete(message.id);
		if (message.features) pending.resolve(message.features);
		else pending.reject(new Error(message.error ?? 'The analysis failed.'));
	});
	const fail = (why: Error) => {
		if (worker === created) worker = null;
		for (const pending of waiting.values()) pending.reject(why);
		waiting.clear();
	};
	created.on('error', (err) => fail(new Error(`The analysis worker failed: ${err.message}`)));
	created.on('exit', (code) => fail(new Error(`The analysis worker stopped (code ${code}).`)));
	worker = created;
	return created;
}

export function analyseInWorker(samples: Float32Array, rate: number): Promise<SongFeatures> {
	const id = ++next;
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve, reject });
		started().postMessage({ id, samples, rate }, [samples.buffer as ArrayBuffer]);
	});
}

/** Ends the worker, if one is running. */
export async function stopAnalyser(): Promise<void> {
	const running = worker;
	worker = null;
	await running?.terminate();
}
