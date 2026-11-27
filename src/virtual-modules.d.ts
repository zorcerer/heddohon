/** The sound analysis worker's file, as a URL (`analysisWorker` in `vite.config.ts`). */
declare module 'virtual:analysis-worker' {
	const url: URL;
	export default url;
}
