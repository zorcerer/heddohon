/* The address screen. `preload.js` gives it `heddohonDesktop`; `main.js` does the checking. */
const form = document.getElementById('form');
const address = document.getElementById('address');
const problem = document.getElementById('problem');
const button = document.getElementById('connect');
const headers = document.getElementById('headers');
const more = document.getElementById('more');

function say(message) {
	problem.textContent = message ?? '';
	problem.hidden = !message;
}

window.heddohonDesktop.state().then((state) => {
	if (state?.server) address.value = state.server;
	if (state?.headers) {
		headers.value = state.headers;
		more.open = true;
	}
	say(state?.notice);
	address.focus();
});

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	say(null);
	button.disabled = true;
	button.textContent = 'Checking…';
	const result = await window.heddohonDesktop.connect(address.value, headers.value);
	// On success the window goes to the server and this page is gone.
	if (result?.error) {
		say(result.error);
		button.disabled = false;
		button.textContent = 'Connect';
	}
});
