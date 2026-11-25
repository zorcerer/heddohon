/**
 * The calls the app's own two screens make: the address screen and the
 * basic-auth prompt, both files in this package. The main process checks the
 * caller again (`fromOwnPage` in `main.js`).
 *
 * A web page is given one call, `heddohonPresence`, which says what plays for
 * the Discord activity and returns nothing. The main process takes it only
 * from the saved server's main frame, so a sign-in page in front of the server
 * that calls it is ignored (`ipcMain.on('presence')` in `main.js`).
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
}
