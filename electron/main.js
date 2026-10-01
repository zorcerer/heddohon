/**
 * Heddohon for the Linux desktop: a window around a server you run.
 *
 * Nothing of the web app is in this package. The first run asks for the
 * server's address, checks that a Heddohon answers there, and from then on
 * the window shows that server, so a server upgrade needs no new app. What
 * the app adds is a launcher entry, a window of its own, and Chromium's
 * Media Session, which on Linux is MPRIS: media keys, the desktop's media
 * controls and `playerctl` work without anything written here.
 *
 * The page is a remote one, so it is given nothing: context isolation and
 * the sandbox are on, there is no Node in it, and the preload exposes its
 * two calls to the address screen alone. The window stays on the server's
 * origin; any other address opens in the default browser.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { originOf, compareVersions } = require('./lib');

const REPOSITORY = 'zorcerer/heddohon';
const SETUP = path.join(__dirname, 'setup.html');
/** What the page may ask the desktop for. The audio output list needs `media` to name its devices. */
const ALLOWED_PERMISSIONS = new Set(['media', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write', 'screen-wake-lock']);
const CHECK_TIMEOUT_MS = 8000;

// Tests point this at a directory of their own.
if (process.env.HEDDOHON_DESKTOP_DATA) app.setPath('userData', process.env.HEDDOHON_DESKTOP_DATA);

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
	try {
		const config = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
		return typeof config === 'object' && config !== null ? config : {};
	} catch {
		return {};
	}
}

let config = {};

function saveConfig() {
	try {
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify(config, null, '\t'));
	} catch {
		// A profile that cannot be written: the address is asked for again next time.
	}
}

/**
 * Whether a Heddohon answers at `origin`: `/healthz` says ok and there is a
 * manifest. Returns null, or what to tell the person at the address screen.
 */
async function check(origin) {
	const get = async (pathname) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
		try {
			return await net.fetch(`${origin}${pathname}`, { signal: controller.signal, redirect: 'error', credentials: 'omit' });
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		const health = await get('/healthz');
		const body = health.ok ? await health.json().catch(() => null) : null;
		if (body?.status !== 'ok') return `${origin} answered, but not as a Heddohon server.`;
		const manifest = await get('/manifest.webmanifest');
		if (!manifest.ok) return `${origin} answered, but not as a Heddohon server.`;
		return null;
	} catch {
		return `${origin} could not be reached. Check the address, and that this computer can open it in a browser.`;
	}
}

let win = null;
/** Why the address screen is showing, when it is not the first run. */
let notice = null;

function showSetup(message = null) {
	notice = message;
	void win?.loadFile(SETUP);
}

function isServer(url) {
	try {
		return Boolean(config.server) && new URL(url).origin === config.server;
	} catch {
		return false;
	}
}

function openOutside(url) {
	try {
		const { protocol } = new URL(url);
		if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url);
	} catch {
		// Not an address.
	}
}

function createWindow() {
	const bounds = config.window ?? {};
	win = new BrowserWindow({
		width: bounds.width ?? 1280,
		height: bounds.height ?? 860,
		x: bounds.x,
		y: bounds.y,
		minWidth: 360,
		minHeight: 480,
		backgroundColor: '#0b0c0f',
		autoHideMenuBar: true,
		title: 'Heddohon',
		icon: path.join(__dirname, 'build', 'icon.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: false
		}
	});
	if (bounds.maximized) win.maximize();

	// The size and place are kept for the next start.
	let timer = null;
	const remember = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (!win || win.isDestroyed()) return;
			config.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
			saveConfig();
		}, 500);
	};
	win.on('resize', remember);
	win.on('move', remember);
	win.on('closed', () => {
		clearTimeout(timer);
		win = null;
	});

	const contents = win.webContents;
	// The window stays on the server. Anything else is the default browser's.
	contents.on('will-navigate', (event, url) => {
		if (isServer(url) || url.startsWith('file:')) return;
		event.preventDefault();
		openOutside(url);
	});
	contents.setWindowOpenHandler(({ url }) => {
		if (isServer(url)) return { action: 'allow' };
		openOutside(url);
		return { action: 'deny' };
	});
	// The server not answering when the app starts: back to the address screen, with the address kept.
	contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
		// -3 is a load that was replaced by another, not a failure.
		if (!isMainFrame || code === -3 || !isServer(url)) return;
		showSetup(`${config.server} could not be reached.`);
	});

	if (config.server) void win.loadURL(config.server);
	else showSetup();
}

function buildMenu(update = null) {
	const template = [
		{
			label: 'Heddohon',
			submenu: [
				{ label: 'Change server…', click: () => showSetup() },
				{ type: 'separator' },
				...(update
					? [{ label: `Version ${update.version} is available`, click: () => openOutside(update.url) }, { type: 'separator' }]
					: []),
				{ label: `Version ${app.getVersion()}`, enabled: false },
				{ role: 'quit' }
			]
		},
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				{ role: 'reload' },
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' }
			]
		}
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Asks GitHub for the latest release, once per start, and puts it in the menu
 * when it is newer. The app does not update itself: an AppImage is a file the
 * person replaces, and a .deb is the package manager's.
 */
async function checkForUpdate() {
	if (process.env.HEDDOHON_DESKTOP_NO_UPDATE_CHECK) return;
	try {
		const response = await net.fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
			headers: { accept: 'application/vnd.github+json' },
			credentials: 'omit'
		});
		if (!response.ok) return;
		const latest = await response.json();
		const version = String(latest.tag_name ?? '').replace(/^v/, '');
		if (version && compareVersions(version, app.getVersion()) > 0) {
			buildMenu({ version, url: `https://github.com/${REPOSITORY}/releases/tag/v${version}` });
		}
	} catch {
		// Offline, or GitHub not reachable: asked again at the next start.
	}
}

/** Only the address screen may call these. */
const fromSetup = (event) => {
	try {
		return event.senderFrame !== null && new URL(event.senderFrame.url).protocol === 'file:';
	} catch {
		return false;
	}
};

ipcMain.handle('setup:state', (event) => (fromSetup(event) ? { server: config.server ?? '', notice } : null));

ipcMain.handle('setup:connect', async (event, raw) => {
	if (!fromSetup(event)) return { error: 'Not allowed.' };
	const origin = originOf(raw);
	if (!origin) return { error: 'That is not an address. It looks like https://music.example.com.' };
	const problem = await check(origin);
	if (problem) return { error: problem };
	config.server = origin;
	saveConfig();
	notice = null;
	void win?.loadURL(origin);
	return { error: null };
});

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});

	app.whenReady().then(() => {
		config = readConfig();
		// A stored address that is no longer one is asked for again.
		if (config.server && originOf(config.server) !== config.server) delete config.server;

		const allowed = (contents, permission) => ALLOWED_PERMISSIONS.has(permission) && isServer(contents?.getURL() ?? '');
		session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
		session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));

		buildMenu();
		createWindow();
		void checkForUpdate();
	});

	app.on('window-all-closed', () => app.quit());
}
