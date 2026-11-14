/**
 * The analysis, in a worker thread (`analyser.ts`), so a song's second of
 * arithmetic never holds up a request.
 *
 * The build makes this a file of its own, `build/server/analysis-worker.js`
 * (`analysisWorker` in `vite.config.ts`); in development Node runs this file
 * with its types stripped. So it imports only by relative path, with the
 * extension, and nothing that needs the app's configuration.
 */
import { parentPort } from 'node:worker_threads';
import { analyse } from './features.ts';

export interface WorkerRequest {
	id: number;
	samples: Float32Array;
	rate: number;
}

parentPort?.on('message', ({ id, samples, rate }: WorkerRequest) => {
	try {
		const features = analyse(samples, rate);
		parentPort?.postMessage({ id, features }, [features.vector.buffer as ArrayBuffer]);
	} catch (err) {
		parentPort?.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
	}
});
