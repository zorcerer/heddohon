/**
 * Heddohon for the desktop, Linux and Windows: a window around a server you run.
 *
 * Nothing of the web app is in this package. The first run asks for the
 * server's address, checks that a Heddohon answers there, and from then on
 * the window shows that server, so a server upgrade needs no new app. What
 * the app adds is a launcher entry, a window of its own, and Chromium's
 * Media Session, which the desktop's own media controls read: MPRIS on Linux
 * (media keys, `playerctl`), the system media controls on Windows. Nothing
 * here is written for either.
 *
 * The page is a remote one, so it is given nothing: context isolation and
 * the sandbox are on, there is no Node in it, and the preload exposes its
 * calls to the app's own two screens alone. The window stays on the
 * server's origin; any other address opens in the default browser.
 *
 * A server behind a proxy that asks who you are first (Authelia, Authentik,
 * oauth2-proxy, Cloudflare Access, plain basic auth) is reached three ways:
 *
 *  - Its sign-in pages are shown in the window. An origin the server, or
 *    another sign-in page, redirects the window to is a sign-in origin, and
 *    the window may move between those and back. A link on one of the
 *    server's own pages to anywhere else still opens in the browser.
 *  - Headers typed at the address screen are sent with every request to the
 *    server's origin, and to no other: a service token, for a proxy that
 *    takes one in place of a sign-in.
 *  - A basic-auth challenge from the server's origin is answered from a
 *    prompt.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { originOf, compareVersions, parseHeaders, formatHeaders, classify } = require('./lib');

const REPOSITORY = 'zorcerer/heddohon';
const SETUP = path.join(__dirname, 'setup.html');
const LOGIN = path.join(__dirname, 'login.html');
/** What the page may ask the desktop for. The audio output list needs `media` to name its devices. */
const ALLOWED_PERMISSIONS = new Set(['media', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write', 'screen-wake-lock']);
const CHECK_TIMEOUT_MS = 8000;
const UPDATE_CHECK_DELAY_MS = 5000;
/** `/healthz` is a few dozen bytes. Nothing longer is read. */
const MAX_CHECK_BYTES = 64 * 1024;

const NOT_HEDDOHON = (origin) => `${origin} answered, but not as a Heddohon server.`;
const UNREACHABLE = (origin) => `${origin} could not be reached. Check the address, and that this computer can open it in a browser.`;
const REFUSED = (origin) =>
	`${origin} asks for a sign-in this app could not complete. If the proxy in front of it takes a header, add it under "A sign-in in front of the server".`;

// Tests point this at a directory of their own.
if (process.env.HEDDOHON_DESKTOP_DATA) app.setPath('userData', process.env.HEDDOHON_DESKTOP_DATA);

// The id Windows groups the window, its taskbar button and its notifications under; the installer's shortcut carries the same.
if (process.platform === 'win32') app.setAppUserModelId('app.heddohon.desktop');

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

/**
 * Software rendering, for a machine whose graphics driver Chromium cannot
 * use: a virtual machine, a remote desktop, some driver and compositor pairs.
 * There the GPU process fails as it starts (`AllocateRingBuffer() failed` is
 * one way it says so) and takes the window with it. The second failure in a
 * run switches hardware acceleration off for good and starts the app again;
 * View, Software rendering switches it by hand, and
 * `HEDDOHON_DESKTOP_NO_GPU=1` or `--disable-gpu` does it for one run. It has
 * to be decided before the app is ready, so the profile is read here.
 */
config = readConfig();
if (config.softwareRendering || process.env.HEDDOHON_DESKTOP_NO_GPU) app.disableHardwareAcceleration();

/** Starts the app again. An AppImage is started as the file it is, not as the binary mounted inside it. */
function restart() {
	app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined);
	app.exit(0);
}

let gpuFailures = 0;
app.on('child-process-gone', (_event, details) => {
	if (details.type !== 'GPU' || details.reason === 'clean-exit' || details.reason === 'killed') return;
	gpuFailures++;
	if (gpuFailures < 2 || config.softwareRendering) return;
	config.softwareRendering = true;
	saveConfig();
	restart();
});

function saveConfig() {
	try {
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		// Readable by its owner only: it can hold the headers below. On Windows the
		// mode means nothing, and the profile is under the user's own AppData.
		// Written beside and renamed over, so the file is never seen half written:
		// the window's size is saved as it is dragged, and a read in the middle of a
		// write found an empty file.
		const beside = `${configPath()}.tmp`;
		fs.writeFileSync(beside, JSON.stringify(config, null, '\t'), { mode: 0o600 });
		fs.chmodSync(beside, 0o600);
		fs.renameSync(beside, configPath());
	} catch {
		// A profile that cannot be written: the address is asked for again next time.
	}
}

/** The headers sent to the server's origin, by name. */
let headers = {};

/**
 * Whether the desktop has a keyring to seal with: on Windows always, the
 * user's own data protection key. On Linux without one, Chromium falls back
 * to a fixed password (`basic_text`), which is the plain text with a step
 * added.
 */
const canSeal = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';

function loadHeaders() {
	try {
		if (typeof config.headersSealed === 'string') {
			return parseHeaders(safeStorage.decryptString(Buffer.from(config.headersSealed, 'base64'))).headers ?? {};
		}
		if (typeof config.headersPlain === 'string') return parseHeaders(config.headersPlain).headers ?? {};
	} catch {
		// Sealed under a keyring that is gone: asked for again at the address screen.
	}
	return {};
}

/** Kept sealed with the desktop's keyring where there is one, and in the profile's file, mode 0600, where there is not. */
function storeHeaders(next) {
	headers = next;
	delete config.headersSealed;
	delete config.headersPlain;
	const text = formatHeaders(next);
	if (!text) return;
	if (canSeal()) config.headersSealed = safeStorage.encryptString(text).toString('base64');
	else config.headersPlain = text;
}

const originOrNull = (url) => {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
};

let win = null;
/** Why the address screen is showing, when it is not the first run. */
let notice = null;
/** An address behind a sign-in, shown in the window and not saved until a Heddohon has answered there. */
let pending = null;
/** Origins the window was redirected to on its way to the server: the proxy's sign-in pages. */
const signInOrigins = new Set();

function showSetup(message = null) {
	notice = message;
	pending = null;
	void win?.loadFile(SETUP);
}

function isServer(url) {
	const origin = originOrNull(url);
	return origin !== null && (origin === config.server || origin === pending);
}

/** The saved server only: what a page has to be to ask the desktop for anything. */
function isSavedServer(url) {
	const origin = originOrNull(url);
	return origin !== null && origin === config.server;
}

function openOutside(url) {
	try {
		const { protocol } = new URL(url);
		if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url);
	} catch {
		// Not an address.
	}
}

/** One GET that follows nothing: the status, where a redirect points, and the start of the body. */
function get(url) {
	return new Promise((resolve, reject) => {
		const request = net.request({ url, redirect: 'manual', credentials: 'omit' });
		for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
		const timer = setTimeout(() => request.abort(), CHECK_TIMEOUT_MS);
		const done = (answer) => {
			clearTimeout(timer);
			resolve(answer);
		};
		request.on('redirect', (status) => {
			done({ status, body: '' });
			request.abort();
		});
		request.on('response', (response) => {
			const chunks = [];
			let size = 0;
			response.on('data', (chunk) => {
				size += chunk.length;
				if (size <= MAX_CHECK_BYTES) chunks.push(chunk);
			});
			response.on('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		request.on('abort', () => reject(new Error('aborted')));
		request.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		request.end();
	});
}

/**
 * What answers at `origin`: `heddohon` when `/healthz` says ok and there is a
 * manifest, `sign-in` when something in front of it asks who is asking, or
 * `{ error }` with what to tell the person at the address screen.
 */
async function check(origin) {
	try {
		const health = await get(`${origin}/healthz`);
		const kind = classify(health.status, health.body);
		if (kind === 'sign-in') return 'sign-in';
		if (kind !== 'heddohon') return { error: NOT_HEDDOHON(origin) };
		return (await get(`${origin}/manifest.webmanifest`)).status === 200 ? 'heddohon' : { error: NOT_HEDDOHON(origin) };
	} catch {
		return { error: UNREACHABLE(origin) };
	}
}

/**
 * The same question asked from the page the window has reached, once a
 * sign-in is behind it: there it carries whatever the sign-in left, a cookie
 * or an answered challenge, which a request of this process's own would not.
 * Until it says yes the address is not saved, and the page is given no
 * permissions (`isSavedServer`).
 */
async function verifyPending(contents) {
	const origin = pending;
	if (!origin || !isServer(contents.getURL())) return;
	const ok = await contents
		.executeJavaScript(
			`Promise.all([fetch('/healthz').then((r) => (r.ok ? r.json() : null)), fetch('/manifest.webmanifest').then((r) => r.ok)])
				.then(([health, manifest]) => health?.status === 'ok' && manifest === true)
				.catch(() => false)`
		)
		.catch(() => false);
	// Not yet is not no: a proxy's own sign-in page can be on the server's origin
	// (oauth2-proxy's is), and the next page the window reaches is asked again.
	if (ok !== true || pending !== origin) return;
	config.server = origin;
	pending = null;
	saveConfig();
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
	/*
	 * The window stays on the server and on the sign-in pages in front of it.
	 * From a sign-in page it may go on to another (a proxy's page hands over to
	 * an identity provider's with a form or a script, not always a redirect),
	 * and that one becomes a sign-in origin too. From one of the server's own
	 * pages, anywhere else is the default browser's.
	 */
	contents.on('will-navigate', (event, url) => {
		if (isServer(url) || url.startsWith('file:')) return;
		const to = originOrNull(url);
		const from = originOrNull(contents.getURL());
		if (to && (signInOrigins.has(to) || (from && signInOrigins.has(from)))) {
			signInOrigins.add(to);
			return;
		}
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
		showSetup(`${config.server ?? pending} could not be reached.`);
	});
	// An address behind a sign-in: when the window is on it, ask it what it is.
	contents.on('did-navigate', (_event, url, status) => {
		if (!pending || !isServer(url)) return;
		// The proxy turned the window away with nothing to sign in to.
		if (status === 401 || status === 403) showSetup(REFUSED(pending));
	});
	contents.on('did-finish-load', () => void verifyPending(contents));

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
				{ label: 'Check for updates…', click: () => void checkForUpdate(true) },
				{ role: 'quit' }
			]
		},
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				// The way back from a sign-in page that led somewhere else.
				{ label: 'Go to the server', accelerator: 'Alt+Home', click: () => config.server && void win?.loadURL(config.server) },
				{ role: 'reload' },
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
				{ type: 'separator' },
				{
					label: 'Software rendering',
					type: 'checkbox',
					checked: Boolean(config.softwareRendering),
					// Decided before the app is ready, so a change starts it again.
					click: () => {
						config.softwareRendering = !config.softwareRendering;
						saveConfig();
						restart();
					}
				}
			]
		}
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Asks GitHub for the latest release: once per start, and whenever Check for
 * updates is chosen from the menu. A newer one goes in the menu, where it
 * stays, and is said in a dialog whose Get it opens its page: once per release
 * for the check at the start, since the menu bar is hidden until Alt is
 * pressed, and every time for one that was asked for. Asked for, it also
 * says when this is the latest, or that GitHub could not be reached.
 *
 * The app does not update itself: an AppImage, an installer or a portable
 * .exe is a file the person replaces.
 *
 * `HEDDOHON_DESKTOP_RELEASES` points the question somewhere else, which the
 * suite uses.
 */
async function checkForUpdate(asked = false) {
	if (!asked && process.env.HEDDOHON_DESKTOP_NO_UPDATE_CHECK) return;
	const say = (message, detail) => {
		if (asked && win && !win.isDestroyed()) void dialog.showMessageBox(win, { type: 'info', title: 'Heddohon', message, detail, buttons: ['OK'] });
	};
	try {
		const response = await net.fetch(process.env.HEDDOHON_DESKTOP_RELEASES || `https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
			headers: { accept: 'application/vnd.github+json' },
			credentials: 'omit'
		});
		if (!response.ok) return say('GitHub could not be asked', `It answered ${response.status}. The releases are at github.com/${REPOSITORY}/releases.`);
		const latest = await response.json();
		const version = String(latest.tag_name ?? '').replace(/^v/, '');
		if (!/^\d+\.\d+\.\d+/.test(version)) return say('GitHub could not be asked', 'Its answer named no release.');
		if (compareVersions(version, app.getVersion()) <= 0) return say('This is the latest release', `Heddohon ${app.getVersion()}.`);
		const url = `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
		buildMenu({ version, url });
		// Once per release for the check at the start; every time for one that was asked for.
		if ((!asked && config.toldVersion === version) || !win || win.isDestroyed()) return;
		config.toldVersion = version;
		saveConfig();
		const { response: choice } = await dialog.showMessageBox(win, {
			type: 'info',
			title: 'Heddohon',
			message: `Heddohon ${version} is available`,
			detail: `This is ${app.getVersion()}. The newer app is on the releases page. It stays listed in the menu (press Alt, then Heddohon).`,
			buttons: ['Get it', 'Later'],
			defaultId: 0,
			cancelId: 1
		});
		if (choice === 0) openOutside(url);
	} catch {
		// Offline, or GitHub not reachable: asked again at the next start.
		say('GitHub could not be reached', 'Check the connection and try again.');
	}
}

/** Only the app's own screens, files in this package, may call these. */
const fromOwnPage = (event, file) => {
	try {
		const url = new URL(event.senderFrame?.url ?? '');
		return url.protocol === 'file:' && path.basename(url.pathname) === file;
	} catch {
		return false;
	}
};

ipcMain.handle('setup:state', (event) =>
	fromOwnPage(event, 'setup.html') ? { server: config.server ?? '', notice, headers: formatHeaders(headers) } : null
);

ipcMain.handle('setup:connect', async (event, raw, headerText) => {
	if (!fromOwnPage(event, 'setup.html')) return { error: 'Not allowed.' };
	const origin = originOf(raw);
	if (!origin) return { error: 'That is not an address. It looks like https://music.example.com.' };
	const parsed = parseHeaders(headerText);
	if (parsed.error) return { error: parsed.error };

	// In place for the check itself, and put back if the address is turned down.
	const before = headers;
	headers = parsed.headers;
	const answer = await check(origin);
	if (typeof answer === 'object') {
		headers = before;
		return answer;
	}
	storeHeaders(parsed.headers);
	notice = null;
	signInOrigins.clear();
	if (answer === 'heddohon') {
		config.server = origin;
		pending = null;
	} else {
		// A sign-in in front of it: shown in the window, and saved once a Heddohon answers behind it.
		delete config.server;
		pending = origin;
	}
	saveConfig();
	void win?.loadURL(origin);
	return { error: null };
});

/*
 * A basic-auth challenge: asked for in a small window over the main one. One
 * prompt per challenge at a time, since a page and what it loads can each be
 * challenged before the first answer is in.
 */
let asking = null;
let answerLogin = null;

function askCredentials(host, realm) {
	asking ??= new Promise((resolve) => {
		const prompt = new BrowserWindow({
			parent: win ?? undefined,
			modal: Boolean(win),
			width: 420,
			height: 380,
			resizable: false,
			minimizable: false,
			maximizable: false,
			autoHideMenuBar: true,
			backgroundColor: '#0b0c0f',
			title: 'Sign in',
			webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
		});
		let answered = false;
		answerLogin = { host, realm, submit: (credentials) => ((answered = true), resolve(credentials), prompt.close()) };
		prompt.on('closed', () => {
			if (!answered) resolve(null);
			asking = null;
			answerLogin = null;
		});
		void prompt.loadFile(LOGIN);
	});
	return asking;
}

ipcMain.handle('login:state', (event) => (fromOwnPage(event, 'login.html') && answerLogin ? { host: answerLogin.host, realm: answerLogin.realm } : null));
ipcMain.handle('login:submit', (event, username, password) => {
	if (!fromOwnPage(event, 'login.html') || !answerLogin) return;
	answerLogin.submit(username === null ? null : { username: String(username), password: String(password ?? '') });
});

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});

	// Answered only for the server and its sign-in pages; any other challenge, and a proxy's, is refused as before.
	app.on('login', (event, _contents, details, authInfo, callback) => {
		const origin = originOrNull(details.url);
		if (authInfo.isProxy || !origin || !(isServer(details.url) || signInOrigins.has(origin))) return;
		event.preventDefault();
		void askCredentials(authInfo.host, authInfo.realm).then((credentials) => {
			if (credentials) callback(credentials.username, credentials.password);
			else callback();
		});
	});

	app.whenReady().then(() => {
		// A stored address that is no longer one is asked for again.
		if (config.server && originOf(config.server) !== config.server) delete config.server;
		headers = loadHeaders();

		const allowed = (contents, permission) => ALLOWED_PERMISSIONS.has(permission) && isSavedServer(contents?.getURL() ?? '');
		session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
		session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));

		// The headers go to the server's origin and nowhere else: not to a sign-in page, and not to a site a page loads from.
		session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
			if (Object.keys(headers).length > 0 && isServer(details.url)) callback({ requestHeaders: { ...details.requestHeaders, ...headers } });
			else callback({});
		});
		// Where the server, or a sign-in page, sends the window is a sign-in page.
		session.defaultSession.webRequest.onBeforeRedirect((details) => {
			if (details.resourceType !== 'mainFrame') return;
			const from = originOrNull(details.url);
			const to = originOrNull(details.redirectURL);
			if (to && !isServer(details.redirectURL) && (isServer(details.url) || (from && signInOrigins.has(from)))) signInOrigins.add(to);
		});

		buildMenu();
		createWindow();
		// After the window has had time to show the server: the dialog is not the first thing seen.
		setTimeout(() => void checkForUpdate(), UPDATE_CHECK_DELAY_MS);
	});

	app.on('window-all-closed', () => app.quit());
}
