/* The basic-auth prompt. `preload.js` gives it `heddohonLogin`; `main.js` hands the answer to the challenge. */
const form = document.getElementById('form');

window.heddohonLogin.state().then((state) => {
	if (!state) return;
	document.getElementById('who').textContent = state.realm ? `${state.host} asks for a name and password (${state.realm}).` : `${state.host} asks for a name and password.`;
	document.getElementById('username').focus();
});

form.addEventListener('submit', (event) => {
	event.preventDefault();
	void window.heddohonLogin.submit(document.getElementById('username').value, document.getElementById('password').value);
});

document.getElementById('cancel').addEventListener('click', () => void window.heddohonLogin.submit(null, null));
