/**
 * The account's listening history as a file to download, from Settings:
 * CSV, or JSON in the shape of a ListenBrainz listen.
 *
 * Written as it is read, a page of plays at a time (`exportPlays`), so a
 * history of any length is never held whole in memory.
 */
import { csvLine } from './csv';
import { exportPlays, type ExportedPlay } from './history';
import { APP_VERSION } from './version';

export const EXPORT_FORMATS = ['csv', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const CSV_HEADER = ['played_at', 'track', 'artist', 'album', 'duration_seconds', 'device', 'source', 'song_id'];

function csvRow(play: ExportedPlay): string {
	return csvLine([
		new Date(play.playedAt).toISOString(),
		play.title,
		play.artist,
		play.album,
		play.duration,
		play.device,
		play.source,
		play.songId
	]);
}

/**
 * A play as a ListenBrainz listen: what `/1/submit-listens` takes in its
 * `payload`, and what a ListenBrainz export holds. Null for a play without a
 * track name or an artist, which ListenBrainz refuses (a row from before
 * these were kept). `additional_info` takes any key; the `heddohon_` ones
 * are this server's.
 */
function listen(play: ExportedPlay): Record<string, unknown> | null {
	if (!play.title || !play.artist) return null;
	return {
		listened_at: Math.floor(play.playedAt / 1000),
		track_metadata: {
			artist_name: play.artist,
			track_name: play.title,
			...(play.album ? { release_name: play.album } : {}),
			additional_info: {
				...(play.source === 'heddohon' ? { media_player: 'Heddohon' } : {}),
				submission_client: 'Heddohon',
				submission_client_version: APP_VERSION,
				...(play.duration ? { duration: play.duration } : {}),
				heddohon_song_id: play.songId,
				...(play.source ? { heddohon_source: play.source } : {}),
				...(play.device ? { heddohon_device: play.device } : {})
			}
		}
	};
}

/**
 * The account's plays from `from` to before `to` (epoch millis), oldest first,
 * as a stream of the file.
 */
export function exportHistory(
	accountId: string,
	format: ExportFormat,
	from: number,
	to: number
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const pages = exportPlays(accountId, from, to);
	let first = true;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(format === 'csv' ? csvLine(CSV_HEADER) : '['));
		},
		async pull(controller) {
			try {
				// Until something is written: a stream does not ask again after a
				// pull that wrote nothing, and a page can be all plays a listen
				// leaves out.
				for (;;) {
					const next = await pages.next();
					if (next.done) {
						if (format === 'json') controller.enqueue(encoder.encode(first ? ']\n' : '\n]\n'));
						controller.close();
						return;
					}
					let text = '';
					for (const play of next.value) {
						if (format === 'csv') {
							text += csvRow(play);
							continue;
						}
						const item = listen(play);
						if (!item) continue;
						text += `${first ? '\n' : ',\n'}${JSON.stringify(item)}`;
						first = false;
					}
					if (text) {
						controller.enqueue(encoder.encode(text));
						return;
					}
				}
			} catch (err) {
				controller.error(err);
			}
		},
		async cancel() {
			await pages.return(undefined);
		}
	});
}
