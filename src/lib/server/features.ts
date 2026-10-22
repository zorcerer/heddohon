/**
 * The optional parts of the server that are off until someone turns them on,
 * each of which sends something to a third party or opens something to one.
 * An administrator of the music server switches them under Settings,
 * Features, and the first-run setup offers them; both save the variable to
 * `setup.json` (`SETUP_NAMES`). A variable set in the environment decides it
 * instead, and Settings shows it locked.
 *
 * Only the switches. The addresses they fetch from (`HEDDOHON_LYRICS_LRCLIB_URL`
 * and the like) name another host and stay environment-only.
 *
 * A new feature that is off by default goes in `FEATURES`: Settings lists it,
 * and every administrator is told of it once on the home page
 * (`featuresSeen` in settings) while it is off. Profile pages are the one
 * that is on until switched off (`defaultOn`): a page is shown beyond its own
 * account, to the others here or through a public link, only once that
 * account chooses to.
 */
import { config, fromEnvironment, type AppConfig, type SetupName } from './config';

export const FEATURE_IDS = ['newReleases', 'lrclib', 'autoeq', 'discord', 'listenbrainz', 'mcp', 'profiles'] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

interface Feature {
	id: FeatureId;
	variable: SetupName;
	title: string;
	/** What it does and what it sends where, for the administrator deciding. */
	detail: string;
	on: (cfg: AppConfig) => boolean;
	/** On unless switched off. The rest are off until switched on. */
	defaultOn?: boolean;
}

export const FEATURES: readonly Feature[] = [
	{
		id: 'newReleases',
		variable: 'HEDDOHON_NEW_RELEASES',
		title: 'New releases from MusicBrainz',
		detail:
			'Each account can turn on a home shelf of recent albums by the artists it plays most. For an account that does, the names of those artists are sent to MusicBrainz once a day.',
		on: (cfg) => cfg.musicbrainzUrl !== null
	},
	{
		id: 'lrclib',
		variable: 'HEDDOHON_LYRICS_LRCLIB',
		title: 'Lyrics from LRCLIB',
		detail:
			'For a track the music server has no lyrics for, its artist, title, album and length are sent to LRCLIB when its lyrics are opened.',
		on: (cfg) => cfg.lrclibUrl !== null
	},
	{
		id: 'autoeq',
		variable: 'HEDDOHON_AUTOEQ',
		title: 'Headphone corrections from AutoEq',
		detail:
			'Listeners can search the AutoEq database for their headphones under Settings, Playback. The index is fetched from GitHub once a day, and each correction chosen, which tells GitHub the headphones.',
		on: (cfg) => cfg.autoeqUrl !== null
	},
	{
		id: 'discord',
		variable: 'HEDDOHON_DISCORD',
		title: 'Plays sent to Discord',
		detail:
			'An account can link a Discord channel by a webhook, and the title, artist, album and cover of each track it plays are posted there.',
		on: (cfg) => cfg.discordUrl !== null
	},
	{
		id: 'listenbrainz',
		variable: 'HEDDOHON_LISTENBRAINZ',
		title: 'Plays sent to ListenBrainz',
		detail: 'An account can link ListenBrainz by its token, and the title, artist and album of each track it plays are sent there.',
		on: (cfg) => cfg.listenbrainzUrl !== null
	},
	{
		id: 'mcp',
		variable: 'HEDDOHON_MCP',
		title: 'AI assistants (MCP)',
		detail:
			'Each account can make a token for an AI assistant, which then reads its library and, if the token allows it, changes its playlists. What it reads goes to whoever runs its model.',
		on: (cfg) => cfg.mcp
	},
	{
		id: 'profiles',
		variable: 'HEDDOHON_PROFILES',
		title: 'Profile pages',
		detail:
			'Each account has a page under People with four albums it picks, a bio, its name and picture, and if it chooses what it played lately. It can show the page to the other accounts here, and to anyone through a public link it makes. Off, the pages, People and the public links answer as pages that do not exist; what was saved stays.',
		on: (cfg) => cfg.profiles,
		defaultOn: true
	}
];

export interface FeatureState {
	id: FeatureId;
	title: string;
	detail: string;
	variable: SetupName;
	on: boolean;
	/** The environment sets the variable, so Settings does not change it. */
	fromEnvironment: boolean;
}

export function featureStates(): FeatureState[] {
	const cfg = config();
	return FEATURES.map((feature) => ({
		id: feature.id,
		title: feature.title,
		detail: feature.detail,
		variable: feature.variable,
		on: feature.on(cfg),
		fromEnvironment: fromEnvironment(feature.variable)
	}));
}

/** The features that are off and that `seen` does not hold, for the notice on an administrator's home page. */
export function unseenFeatures(seen: readonly string[]): FeatureState[] {
	return featureStates().filter((feature) => !feature.on && !seen.includes(feature.id));
}
