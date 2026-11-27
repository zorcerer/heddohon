/**
 * The calls the app's own two screens make: the address screen and the
 * basic-auth prompt, both files in this package. The main process checks the
 * caller again (`fromOwnPage` in `main.js`).
 *
 * A web page is given two things for the Discord activity: `heddohonPresence`,
 * which says what plays and returns nothing, and `heddohonDiscord`, the switch
 * that turns it on, which Settings shows; and `heddohonOutput`, which names
 * the computer's audio output for "What you're hearing". The main process
 * answers each only from the saved server's main frame, so a sign-in page in
 * front of the server that calls them is ignored (`fromSavedServer` in
 * `main.js`).
 */
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && location.pathname.endsWith('/setup.html')) {
	contextBridge.exposeInMainWorld('heddohonDesktop', {
		state: () => ipcRenderer.invoke('setup:state'),
		connect: (address, headers) => ipcRenderer.invoke('setup:connect', address, headers)
	});
}

if (location.protocol === 'file:' && location.pathname.endsWith('/login.html')) {
	contextBridge.exposeInMainWorld('heddohonLogin', {
		state: () => ipcRenderer.invoke('login:state'),
		submit: (username, password) => ipcRenderer.invoke('login:submit', username, password)
	});
}

if (location.protocol === 'https:' || location.protocol === 'http:') {
	contextBridge.exposeInMainWorld('heddohonPresence', (state) => ipcRenderer.send('presence', state));
	// The switch for it, which the server's Settings shows (This browser): its state, and a change to it.
	// The computer's audio output, for "What you're hearing": by the label of the output chosen, or the default.
	contextBridge.exposeInMainWorld('heddohonOutput', {
		describe: (label) => ipcRenderer.invoke('output:describe', typeof label === 'string' ? label : '')
	});
	contextBridge.exposeInMainWorld('heddohonDiscord', {
		state: () => ipcRenderer.invoke('discord:state'),
		set: (on) => ipcRenderer.invoke('discord:set', on === true)
	});
}
