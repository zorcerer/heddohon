/**
 * Which audio output the player sends its sound to.
 *
 * `HTMLMediaElement.setSinkId` moves an element to another output, and the
 * player plays through two plain elements (see `player.svelte.ts`), so choosing
 * one is a call on each. What differs by browser is how the outputs are found:
 *
 *  - Firefox has a picker of its own, `mediaDevices.selectAudioOutput()`, which
 *    asks for no other permission. The button opens it.
 *  - Chrome and Edge list outputs by name only once the page may use the
 *    microphone. Until then the list holds the system default and nothing
 *    else, and a separate button asks for that permission. The stream it opens
 *    is stopped as soon as it is granted: nothing is recorded, and the
 *    microphone's in-use indicator shows for the moment of the request.
 *  - Safari and iOS have neither, and every browser withholds both on a page
 *    that is not https or localhost. The control is not shown there.
 *
 * The choice is kept in this browser's `localStorage`, the one thing Heddohon
 * keeps there. The rest of the settings follow the account (`settings.ts`), but
 * an output id is minted per browser and per site, so on another computer it
 * names nothing.
 */
import { browser } from '$app/environment';
import { player } from './player.svelte';

export interface Output {
	/** `''` for the system default. */
	id: string;
	label: string;
}

const DEFAULT_OUTPUT: Output = { id: '', label: 'System default' };
const STORAGE_KEY = 'heddohon:audio-output';

/** Firefox's picker, which the DOM types in TypeScript do not carry yet. */
type WithPicker = MediaDevices & { selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo> };

function read(): Output | null {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		return typeof saved?.id === 'string' && typeof saved?.label === 'string' ? saved : null;
	} catch {
		return null;
	}
}

function write(output: Output) {
	try {
		if (output.id) localStorage.setItem(STORAGE_KEY, JSON.stringify(output));
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Storage refused (a private window with it off): the choice lasts until reload.
	}
}

/**
 * Forgets the output saved in this browser. Called from the sign-in page, so
 * the next account to sign in here is not moved to the previous one's
 * headset, and the device's name is not left behind after signing out.
 */
export function forgetSavedOutput() {
	write(DEFAULT_OUTPUT);
}

class AudioOutputs {
	/** Whether this browser can move audio to another output at all. False until `init`. */
	supported = $state(false);
	/** Whether it has its own picker (Firefox), rather than a list read here. */
	picker = $state(false);
	/** The outputs by name, where the browser gives names. The default is not among them. */
	outputs = $state<Output[]>([]);
	/** False while the browser hides the outputs' names (Chrome before microphone permission). */
	named = $state(false);
	current = $state<Output>(DEFAULT_OUTPUT);
	/** Set when the last choice was refused or could not be listed, for the panel to say so. */
	problem = $state<string | null>(null);
	/** True while the microphone request behind "List outputs" is open. */
	listing = $state(false);

	#started = false;

	/**
	 * Detects support, lists what can be listed, and puts back the output this
	 * browser used last. Called once the player has its elements.
	 *
	 * A saved output that is refused (Firefox forgets the grant at reload,
	 * a Bluetooth device is off) leaves the sound on the default and the choice
	 * saved, so it applies again when the device is there and picked.
	 */
	async init() {
		if (!browser || this.#started) return;
		this.#started = true;
		this.supported = 'setSinkId' in HTMLMediaElement.prototype && Boolean(navigator.mediaDevices);
		if (!this.supported) return;
		this.picker = typeof (navigator.mediaDevices as WithPicker).selectAudioOutput === 'function';
		navigator.mediaDevices.addEventListener('devicechange', () => void this.refresh());
		await this.refresh();

		const saved = read();
		if (!saved) return;
		try {
			await player.setOutput(saved.id);
			this.current = saved;
		} catch {
			this.current = DEFAULT_OUTPUT;
		}
	}

	/** Reads the outputs again, after a device comes or goes or a permission is granted. */
	async refresh() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			// Chrome adds "default" and "communications" entries that stand for
			// whichever real device the system has in those roles. The default is
			// offered as its own chip, and a music player has no use for the other.
			const outputs = devices
				.filter((device) => device.kind === 'audiooutput' && device.deviceId && !['default', 'communications'].includes(device.deviceId))
				.map((device) => ({ id: device.deviceId, label: device.label }));
			this.named = outputs.length > 0 && outputs.every((output) => output.label !== '');
			this.outputs = this.named ? outputs : [];
		} catch {
			this.outputs = [];
			this.named = false;
		}
	}

	async choose(output: Output) {
		this.problem = null;
		try {
			await player.setOutput(output.id);
			this.current = output;
			write(output);
		} catch {
			this.problem = `The browser would not play through ${output.label}.`;
		}
	}

	/** Firefox: its own picker, which returns the output chosen in it. */
	async pick() {
		const picker = (navigator.mediaDevices as WithPicker).selectAudioOutput;
		if (!picker) return;
		try {
			const device = await picker.call(navigator.mediaDevices, { deviceId: this.current.id || undefined });
			await this.choose({ id: device.deviceId, label: device.label || 'Chosen output' });
		} catch (err) {
			// Closing the picker without a choice rejects with NotAllowedError.
			if ((err as DOMException)?.name !== 'NotAllowedError') this.problem = 'The browser did not open its output picker.';
		}
	}

	/**
	 * Chrome and Edge: asks for the microphone so the outputs have names, and
	 * closes the stream the moment it opens.
	 */
	async nameOutputs() {
		this.problem = null;
		this.listing = true;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			for (const track of stream.getTracks()) track.stop();
		} catch (err) {
			this.problem = refusal(err);
			return;
		} finally {
			this.listing = false;
		}
		await this.refresh();
		if (!this.named) this.problem = 'This browser found no other outputs.';
	}
}

/**
 * Why the microphone request failed, in terms of what to do about it.
 *
 * One sentence covered every refusal, and on a computer without a microphone
 * Chrome refuses at once, with no prompt, so pressing "List outputs" appeared
 * to do nothing. The cases are told apart by the error Chrome reports and by
 * whether the page's Permissions-Policy allows the microphone: a reverse proxy
 * that adds its own `microphone=()` refuses it the same way a user does.
 */
function refusal(err: unknown): string {
	const name = (err as DOMException)?.name;
	const policy = (document as Document & { featurePolicy?: { allowsFeature(feature: string): boolean } }).featurePolicy;
	if (policy && !policy.allowsFeature('microphone')) {
		return 'The Permissions-Policy on this page does not allow the microphone, so outputs cannot be listed. A reverse proxy in front of Heddohon may be setting its own.';
	}
	if (name === 'NotFoundError') {
		return 'This browser names outputs only once a page may use a microphone, and no microphone is connected.';
	}
	if (name === 'NotAllowedError') {
		return 'Microphone access is blocked for this site. Allow it in the site settings beside the address, then list again.';
	}
	return 'The browser would not open the microphone, so it does not list outputs by name.';
}

export const audioOutputs = new AudioOutputs();
