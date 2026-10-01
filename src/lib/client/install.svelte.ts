/**
 * Installing Heddohon as an app, where this browser can.
 *
 * Chrome and Edge fire `beforeinstallprompt` once the manifest and the
 * service worker qualify, and the event's `prompt()` opens their own install
 * dialog; it works only from a press, and only once per event. Safari has no
 * such event: on macOS 17 and later the page can be added with File, Add to
 * Dock, and on iPhone and iPad with Share, Add to Home Screen, so those get a
 * line of instruction instead. Edge on a desktop gets its own line where the
 * event has not come: it installs any site from its menu, including one
 * served over plain http, where the event never fires. Firefox installs
 * neither way on the desktop and gets nothing.
 *
 * `listen` runs from `hooks.client.ts`, before the first page renders: Chrome
 * fires the event once per page load, and a listener added when the layout
 * mounts can miss it.
 *
 * Whether the app is already installed is known three ways, none of them
 * complete. The page is running as the app (its display mode). The browser
 * says the app is installed (`getInstalledRelatedApps`, with the manifest
 * naming itself under `related_applications`; Chrome and Edge only). Or this
 * browser profile has run as the app or installed it before, which is kept
 * in `localStorage`: the installed app and a tab of the same browser share
 * it, so a tab opened beside the installed app knows. An uninstall is not
 * seen, so the mark stays; Settings offers the install whatever it says.
 */

/** Chrome's event, which TypeScript's DOM types do not have. */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** How this browser installs the app: its own dialog, a line of instruction, or not at all. */
export type InstallRoute = 'prompt' | 'safari-mac' | 'safari-ios' | 'edge' | null;

/** The line shown where there is no button to press. */
export const INSTALL_STEPS: Record<'safari-mac' | 'safari-ios' | 'edge', string> = {
	'safari-mac': "In Safari's menu bar, choose File, then Add to Dock.",
	'safari-ios': 'Tap Share, then Add to Home Screen.',
	edge: "In Edge's menu (the three dots), choose Apps, then Install this site as an app."
};

const INSTALLED_KEY = 'heddohon:installed';

/** The display modes an installed app runs in. A browser tab is `browser`. */
const APP_DISPLAY_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'];

/**
 * The browser from its user agent, where there is no event to go by. Other
 * browsers on iOS carry `CriOS`, `FxiOS` or `EdgiOS`, and Chromium on macOS
 * carries `Chrome`, so those are ruled out before Safari. iPadOS asks for
 * desktop sites and reports itself as a Mac, which only its touch points tell
 * apart. Add to Dock arrived in Safari 17. Edge on a desktop carries `Edg/`;
 * on Android it carries `EdgA/` and its menu is another one.
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
	#instructed = $state<InstallRoute>(null);
	/** Running as the installed app, or installed from this page just now. */
	installed = $state(false);
	/** Installed as far as this browser can tell, running as the app or not; see the top of the file. */
	known = $state(false);
	busy = $state(false);

	listen() {
		this.installed =
			APP_DISPLAY_MODES.some((mode) => matchMedia(`(display-mode: ${mode})`).matches) ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
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

	/** How this browser installs, or null where it cannot or is running as the app already. */
	get route(): InstallRoute {
		if (this.installed) return null;
		return this.#deferred ? 'prompt' : this.#instructed;
	}

	/** Whether to suggest installing: this browser can, and the app is not known to be installed. */
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
