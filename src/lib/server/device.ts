/**
 * A name for the browser a session was signed in from, for the list in
 * Settings: "Firefox on Android", "Safari on iPhone".
 *
 * Only the browser's family and the platform are kept, not the header, a
 * version or a device model. A header this does not recognise (curl, an app)
 * gives null, and the list says "Unknown browser".
 */

/** Checked in order: Edge and Opera carry "Chrome", and every one of them carries "Safari". */
const BROWSERS: [RegExp, string][] = [
	[/\bEdg(?:e|A|iOS)?\//, 'Edge'],
	[/\b(?:OPR|OPiOS)\//, 'Opera'],
	[/\bSamsungBrowser\//, 'Samsung Internet'],
	[/\b(?:Firefox|FxiOS)\//, 'Firefox'],
	[/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
	[/\bVersion\/[\d.]+.*\bSafari\//, 'Safari']
];

/** iPad before Mac: iPadOS asks for desktop sites as a Mac, which a header alone cannot tell apart. */
const PLATFORMS: [RegExp, string][] = [
	[/\biPhone\b/, 'iPhone'],
	[/\biPad\b/, 'iPad'],
	[/\bAndroid\b/, 'Android'],
	[/\bCrOS\b/, 'ChromeOS'],
	[/\bWindows\b/, 'Windows'],
	[/\bMacintosh\b/, 'Mac'],
	[/\bLinux\b/, 'Linux']
];

export function deviceLabel(userAgent: string | null): string | null {
	if (!userAgent) return null;
	const header = userAgent.slice(0, 512);
	const browser = BROWSERS.find(([pattern]) => pattern.test(header))?.[1] ?? null;
	const platform = PLATFORMS.find(([pattern]) => pattern.test(header))?.[1] ?? null;
	if (browser && platform) return `${browser} on ${platform}`;
	return browser ?? platform;
}
