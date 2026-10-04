/**
 * Getting Heddohon as an app, by whichever way suits the device.
 *
 * There are two kinds: the apps shipped with each release (a window around
 * this server for Windows, as an installer and a portable .exe, and Linux, as
 * an AppImage, and an APK for Android), and the page installed by the browser
 * as a web app.
 *
 *  - Windows and Linux are pointed at the release's files, in any browser,
 *    and the browser's own install is not offered.
 *  - Android is pointed at the APK, with the browser's install beside it where
 *    the browser offers one.
 *  - macOS, iPhone and iPad have no app of ours and keep the browser's. Chrome
 *    and Edge fire `beforeinstallprompt` once the manifest and the service
 *    worker qualify, and the event's `prompt()` opens their dialog (only from
 *    a press, once per event). Safari has no such event: on macOS 17 and later
 *    the page is added with File, Add to Dock, and on iPhone and iPad with
 *    Share, Add to Home Screen, so those get a line of instruction. Edge on a
 *    Mac gets a line for its own menu where the event has not come. Firefox
 *    there installs neither way and gets nothing.
 *
 * `listen` runs from `hooks.client.ts`, before the first page renders: Chrome
 * fires the event once per page load, and a listener added when the layout
 * mounts can miss it.
 *
 * Whether the app is already in use is known several ways, none complete:
 *
 *  - The page runs inside one of ours. The desktop app names itself in its
 *    user agent, and the Android app opens the server with `?app=android` and
 *    is the referrer of the page it opens. A reverse proxy's sign-in page
 *    replaces the referrer, so both are read, and the answer is kept in
 *    `sessionStorage` for the tab's later pages.
 *  - The page runs as an installed web app (its display mode).
 *  - The browser says the web app is installed (`getInstalledRelatedApps`,
 *    with the manifest naming itself under `related_applications`; Chrome and
 *    Edge only).
 *  - This browser profile has done any of those before, kept in
 *    `localStorage`, which an installed web app and a tab of the same browser
 *    share. An uninstall is not seen, so the mark stays. Settings makes the
 *    offer whatever it says.
 */

/** Chrome's event, which TypeScript's DOM types do not have. */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * How this device gets the app: one of ours from the release (`app-*`), the
 * browser's own dialog, a line of instruction, or not at all.
 */
type InstallRoute = 'app-windows' | 'app-linux' | 'app-android' | 'prompt' | 'safari-mac' | 'safari-ios' | 'edge' | null;

/** The line shown where there is no button to press. */
export const INSTALL_STEPS: Record<'safari-mac' | 'safari-ios' | 'edge', string> = {
	'safari-mac': "In Safari's menu bar, choose File, then Add to Dock.",
	'safari-ios': 'Tap Share, then Add to Home Screen.',
	edge: "In Edge's menu (the three dots), choose Apps, then Install this site as an app."
};

/** What each of our apps is, for the card and for Settings. */
export const APP_KINDS: Record<'app-windows' | 'app-linux' | 'app-android', { system: string; files: string; action: string }> = {
	'app-windows': { system: 'Windows', files: 'an installer or a portable .exe', action: 'Get the app' },
	'app-linux': { system: 'Linux', files: 'an AppImage', action: 'Get the app' },
	'app-android': { system: 'Android', files: 'an APK to install', action: 'Get the APK' }
};

/** The latest release, whose files the apps are. */
export const APP_RELEASES = 'https://github.com/zorcerer/heddohon/releases/latest';

const INSTALLED_KEY = 'heddohon:installed';
/** Set in the tab one of our apps opened, for the pages it loads after the first. */
const IN_APP_KEY = 'heddohon:in-app';
/** The Android app, as the referrer of the page it opens. */
const ANDROID_APP = 'android-app://app.heddohon.android';

/** Whether the page is inside the desktop app or the Android app. */
function inOurApp(): boolean {
	if (/\bElectron\//.test(navigator.userAgent)) return true;
	const opened = document.referrer.startsWith(ANDROID_APP) || new URLSearchParams(location.search).get('app') === 'android';
	try {
		if (opened) sessionStorage.setItem(IN_APP_KEY, '1');
		return opened || sessionStorage.getItem(IN_APP_KEY) === '1';
	} catch {
		// Storage refused: known for this page only.
		return opened;
	}
}

/** The display modes an installed app runs in. A browser tab is `browser`. */
const APP_DISPLAY_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'];

/**
 * One of our apps for this system, from the user agent. ChromeOS says Linux
 * and runs neither an AppImage nor an .exe, so it is left to the browser.
 */
function appRoute(): InstallRoute {
	const ua = navigator.userAgent;
	if (/Android/.test(ua)) return 'app-android';
	if (/Windows NT/.test(ua)) return 'app-windows';
	if (/Linux/.test(ua) && !/CrOS/.test(ua)) return 'app-linux';
	return null;
}

/**
 * The browser from its user agent, where there is no event to go by. Other
 * browsers on iOS carry `CriOS`, `FxiOS` or `EdgiOS`, and Chromium on macOS
 * carries `Chrome`, so those are ruled out before Safari. iPadOS reports
 * itself as a Mac, told apart only by its touch points. Add to Dock arrived in
 * Safari 17. Edge on a desktop carries `Edg/`.
 */
function instructedRoute(): InstallRoute {
	const ua = navigator.userAgent;
	if (/Edg\//.test(ua) && !/Android|iPhone|iPad|iPod/.test(ua)) return 'edge';
	if (!/Safari\//.test(ua) || /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|EdgA\/|OPR\/|Android/.test(ua)) return null;
	const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
	if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'safari-ios';
	const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
	return /Macintosh/.test(ua) && version >= 17 ? 'safari-mac' : null;
}

class Installer {
	/** Chrome's event, held until the button is pressed. */
	#deferred = $state<BeforeInstallPromptEvent | null>(null);
	#app = $state<InstallRoute>(null);
	#instructed = $state<InstallRoute>(null);
	/** Running as the app (one of ours, or the installed web app), or installed from this page just now. */
	installed = $state(false);
	/** In use as far as this browser can tell, running as the app or not; see the top of the file. */
	known = $state(false);
	busy = $state(false);

	listen() {
		this.installed =
			inOurApp() ||
			APP_DISPLAY_MODES.some((mode) => matchMedia(`(display-mode: ${mode})`).matches) ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
		this.#app = appRoute();
		this.#instructed = instructedRoute();
		if (this.installed) this.#mark();
		else this.known = this.#marked();
		void this.#askBrowser();
		window.addEventListener('beforeinstallprompt', (event) => {
			// Without this Chrome shows its own install bar as well as the card.
			event.preventDefault();
			this.#deferred = event as BeforeInstallPromptEvent;
		});
		window.addEventListener('appinstalled', () => {
			this.installed = true;
			this.#deferred = null;
			this.#mark();
		});
	}

	/** How this device gets the app, or null where it cannot or is running as the app already. */
	get route(): InstallRoute {
		if (this.installed) return null;
		if (this.#app) return this.#app;
		return this.#deferred ? 'prompt' : this.#instructed;
	}

	/** Whether the browser's own install dialog can be opened: beside the APK on Android, and the route itself on a Mac. */
	get canPrompt(): boolean {
		return !this.installed && this.#deferred !== null;
	}

	/** Whether to suggest the app: there is a way to get it, and it is not known to be in use. */
	get suggested(): boolean {
		return this.route !== null && !this.known;
	}

	/** Opens the browser's install dialog. Call from a press. */
	async install() {
		const event = this.#deferred;
		if (!event || this.busy) return;
		this.busy = true;
		try {
			await event.prompt();
			const { outcome } = await event.userChoice;
			if (outcome === 'accepted') {
				this.installed = true;
				this.#mark();
			}
		} catch {
			// Prompted already, or refused by the browser; the event is spent either way.
		} finally {
			// One prompt per event. Chrome fires a new one if the app can still be installed.
			this.#deferred = null;
			this.busy = false;
		}
	}

	#marked(): boolean {
		try {
			return localStorage.getItem(INSTALLED_KEY) === '1';
		} catch {
			return false;
		}
	}

	#mark() {
		this.known = true;
		try {
			localStorage.setItem(INSTALLED_KEY, '1');
		} catch {
			// Storage refused: known for this page load only.
		}
	}

	async #askBrowser() {
		const ask = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> }).getInstalledRelatedApps;
		if (typeof ask !== 'function') return;
		try {
			if ((await ask.call(navigator)).length > 0) this.#mark();
		} catch {
			// Not allowed in this context (an iframe, an insecure origin): nothing learnt.
		}
	}
}

export const installer = new Installer();
