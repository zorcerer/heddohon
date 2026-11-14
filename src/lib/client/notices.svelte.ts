/**
 * What Settings has for an administrator to look at: the optional features
 * that are off and that the account has not been told of (`features.ts`),
 * and sound analysis stopped on an error (`analysisStopped` in
 * `analysis/job.ts`).
 * The home page's loader finds them and sets the count here; the rail's and
 * the Library page's links to Settings carry a dot while it is above 0, and
 * opening the Server tab clears it.
 *
 * Until 2026-11-10 the home page told of them in a card above the library,
 * which put the server's housekeeping on the page an account opens most.
 */
class Notices {
	/** The features named. Opening the Server tab marks these seen. */
	features = $state.raw<string[]>([]);
	/** Sound analysis has stopped. Opening its section clears this; the home page finds it again while it lasts. */
	analysisStopped = $state(false);
	/** Whether the links to Settings carry the dot. */
	get any(): boolean {
		return this.features.length > 0 || this.analysisStopped;
	}
}

export const notices = new Notices();
