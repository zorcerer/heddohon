/**
 * The calls the app's own two screens make: the address screen and the
 * basic-auth prompt, both files in this package. On the server's pages, and
 * on a sign-in page in front of it, this adds nothing to the window, and the
 * main process checks the caller again (`fromOwnPage` in `main.js`).
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
