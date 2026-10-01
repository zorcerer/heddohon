/**
 * Installing Heddohon as an app, where this browser can.
 *
 * Chrome and Edge fire `beforeinstallprompt` once the manifest and the
 * service worker qualify, and the event's `prompt()` opens their own install
 * dialog; it works only from a press, and only once per event. Safari has no
 * such event: on macOS 17 and later the page can be added with File, Add to
 * Dock, and on iPhone and iPad with Share, Add to Home Screen, so those get a
 * line of instruction instead. Firefox installs neither way on the desktop and
 * gets nothing.
 *
 * `listen` runs from `hooks.client.ts`, before the first page renders: Chrome
 * fires the event once per page load, and a listener added when the layout
 * mounts can miss it.
 */

/** Chrome's event, which TypeScript's DOM types do not have. */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** How this browser installs the app: its own dialog, an instruction for Safari, or not at all. */
export type InstallRoute = 'prompt' | 'safari-mac' | 'safari-ios' | null;

/** The line shown for Safari, where there is no button to press. */
export const SAFARI_STEPS: Record<'safari-mac' | 'safari-ios', string> = {
	'safari-mac': "In Safari's menu bar, choose File, then Add to Dock.",
	'safari-ios': 'Tap Share, then Add to Home Screen.'
};

/**
 * Safari from its user agent. Other browsers on iOS carry `CriOS`, `FxiOS` or
 * `EdgiOS`, and Chromium on macOS carries `Chrome`, so those are ruled out
 * first. iPadOS asks for desktop sites and reports itself as a Mac, which only
 * its touch points tell apart. Add to Dock arrived in Safari 17.
 */
function safariRoute(): InstallRoute {
	const ua = navigator.userAgent;
	if (!/Safari\//.test(ua) || /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\/|Android/.test(ua)) return null;
	const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
	if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'safari-ios';
	const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
	return /Macintosh/.test(ua) && version >= 17 ? 'safari-mac' : null;
}

class Installer {
	/** Chrome's event, held until the button is pressed. */
	#deferred = $state<BeforeInstallPromptEvent | null>(null);
	#safari = $state<InstallRoute>(null);
	/** Running as the installed app, or installed from this page just now. */
	installed = $state(false);
	busy = $state(false);

	listen() {
		this.installed =
			matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
		this.#safari = safariRoute();
		window.addEventListener('beforeinstallprompt', (event) => {
			// Without this Chrome shows its own install bar as well as the card.
			event.preventDefault();
			this.#deferred = event as BeforeInstallPromptEvent;
		});
		window.addEventListener('appinstalled', () => {
			this.installed = true;
			this.#deferred = null;
		});
	}

	get route(): InstallRoute {
		if (this.installed) return null;
		return this.#deferred ? 'prompt' : this.#safari;
	}

	/** Opens the browser's install dialog. Call from a press. */
	async install() {
		const event = this.#deferred;
		if (!event || this.busy) return;
		this.busy = true;
		try {
			await event.prompt();
			const { outcome } = await event.userChoice;
			if (outcome === 'accepted') this.installed = true;
		} catch {
			// Prompted already, or refused by the browser; the event is spent either way.
		} finally {
			// One prompt per event. Chrome fires a new one if the app can still be installed.
			this.#deferred = null;
			this.busy = false;
		}
	}
}

export const installer = new Installer();
