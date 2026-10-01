/**
 * The two calls the address screen makes. Exposed only to that screen, a file
 * in this package: on the server's pages this adds nothing to the window, and
 * the main process checks the caller again (`fromSetup` in `main.js`).
 */
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
	contextBridge.exposeInMainWorld('heddohonDesktop', {
		state: () => ipcRenderer.invoke('setup:state'),
		connect: (address) => ipcRenderer.invoke('setup:connect', address)
	});
}
