/**
 * Pulling the player sheet down to close it, on a phone.
 *
 * The drag starts inside `NowPlayingPanel` (its grab handle and its artwork)
 * and moves the wrapper the layout owns, `.player`, which the sheet's open and
 * close transitions are on. This is the state between the two: how far the
 * sheet is pulled, or null.
 *
 * The wrapper follows the finger with `translate`, the property the sheet
 * slides on, and not a transform on the glass inside it: a transform is not a
 * backdrop root, so the panel keeps its blur while carried.
 */
import { player } from './player.svelte';

/**
 * How far down, in px, a release closes the sheet: about a sixth of an
 * iPhone's 852pt screen, past where a wandering scroll or tap ends.
 */
const CLOSE_DISTANCE = 140;
/**
 * Or a flick: this speed in px per millisecond at release, downward, closes it
 * from any distance. 0.6 is 600pt a second.
 */
const CLOSE_SPEED = 0.6;
/** Movement before a press on the artwork counts as a drag rather than a tap. */
const SLOP = 8;

export const sheetDrag = $state<{ offset: number | null }>({ offset: null });

/** Where the last pull let go, read once by the morph that follows it. */
let releasedAt = 0;

export function takeRelease(): number {
	const offset = releasedAt;
	releasedAt = 0;
	return offset;
}

interface Gesture {
	pointerId: number;
	startY: number;
	startX: number;
	lastY: number;
	lastT: number;
	speed: number;
	pulling: boolean;
}

let gesture: Gesture | null = null;
/** Set when a drag ends, so the click that follows it does not also open a link. */
let swallowClick = false;

function begin(event: PointerEvent) {
	// A drag on something that is not a link has no click after it to clear this.
	swallowClick = false;
	if (!player.sheetLayout || !player.panelOpen || event.button !== 0) return;
	gesture = {
		pointerId: event.pointerId,
		startY: event.clientY,
		startX: event.clientX,
		lastY: event.clientY,
		lastT: event.timeStamp,
		speed: 0,
		pulling: false
	};
}

function move(event: PointerEvent) {
	if (!gesture || event.pointerId !== gesture.pointerId) return;
	const dy = event.clientY - gesture.startY;
	if (!gesture.pulling) {
		const dx = Math.abs(event.clientX - gesture.startX);
		if (Math.abs(dy) < SLOP || dx > Math.abs(dy)) return;
		gesture.pulling = true;
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
	}
	const dt = event.timeStamp - gesture.lastT;
	if (dt > 0) gesture.speed = (event.clientY - gesture.lastY) / dt;
	gesture.lastY = event.clientY;
	gesture.lastT = event.timeStamp;
	// Upward it gives a little and stops, a sheet already as high as it goes.
	sheetDrag.offset = dy >= 0 ? dy : -Math.sqrt(-dy) * 2;
}

function end(event: PointerEvent) {
	if (!gesture || event.pointerId !== gesture.pointerId) return;
	const { pulling, lastT } = gesture;
	// A finger that stopped before it let go is not throwing the sheet.
	const speed = event.timeStamp - lastT > 100 ? 0 : gesture.speed;
	const offset = sheetDrag.offset ?? 0;
	gesture = null;
	if (!pulling) return;
	swallowClick = true;
	// For the morph into the dock, which starts from here rather than from the top.
	releasedAt = offset;
	// The class that turns the transition back on and the offset go together,
	// so the sheet travels from where the finger left it: shut, or back up.
	sheetDrag.offset = null;
	if (offset > CLOSE_DISTANCE || speed > CLOSE_SPEED) player.togglePanel();
}

function cancel() {
	gesture = null;
	sheetDrag.offset = null;
}

function click(event: MouseEvent) {
	if (!swallowClick) return;
	swallowClick = false;
	event.preventDefault();
	event.stopPropagation();
}

/**
 * The handlers for an element the sheet can be pulled by, spread onto it. The
 * click handler runs in the capture phase, so a drag that ends on a link does
 * not follow it.
 */
export const pullHandlers = {
	onpointerdown: begin,
	onpointermove: move,
	onpointerup: end,
	onpointercancel: cancel,
	onclickcapture: click
};
