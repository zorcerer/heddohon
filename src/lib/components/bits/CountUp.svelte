<!--
	CountUp, from Svelte Bits (https://sveltebits.xyz), by David Haz:
	https://github.com/DavidHDev/svelte-bits/blob/c37078c5ff7af7b090e510e0a2d0fbb472c1d286/src/lib/components/library/TextAnimations/CountUp/CountUp.svelte
	Under the MIT + Commons Clause licence in LICENSE.md beside this file. Changes
	for Heddohon are marked "Heddohon:".
-->
<!-- @svelte-bits
{
  "title": "Count Up",
  "description": "Spring-animated number counter that counts up (or down) when scrolled into view, with configurable spring physics, delay, and number formatting.",
  "dependencies": ["motion"]
}
-->
<script lang="ts">
	import { animate } from 'motion';

	type Props = {
		to: number;
		from?: number;
		direction?: 'up' | 'down';
		delay?: number;
		duration?: number;
		class?: string;
		startWhen?: boolean;
		separator?: string;
		onStart?: () => void;
		onEnd?: () => void;
	};

	let {
		to,
		from = 0,
		direction = 'up',
		delay = 0,
		duration = 2,
		class: className = '',
		startWhen = true,
		separator = '',
		onStart,
		onEnd
	}: Props = $props();

	let spanEl: HTMLSpanElement | undefined = $state();
	let inView = $state(false);

	function getDecimalPlaces(num: number): number {
		const str = num.toString();
		if (str.includes('.')) {
			const decimals = str.split('.')[1];
			if (parseInt(decimals) !== 0) return decimals.length;
		}
		return 0;
	}

	const maxDecimals = $derived(Math.max(getDecimalPlaces(from), getDecimalPlaces(to)));

	function formatValue(latest: number, decimals: number, sep: string): string {
		const hasDecimals = decimals > 0;
		const options: Intl.NumberFormatOptions = {
			useGrouping: !!sep,
			minimumFractionDigits: hasDecimals ? decimals : 0,
			maximumFractionDigits: hasDecimals ? decimals : 0
		};
		const formatted = Intl.NumberFormat('en-US', options).format(latest);
		return sep ? formatted.replace(/,/g, sep) : formatted;
	}

	// Heddohon: the figure is in the page as rendered, at its value; the count
	// starts from `from` when it comes into view, and not with less motion.
	const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	$effect(() => {
		if (!spanEl) return;
		const el = spanEl;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					inView = true;
					observer.unobserve(el);
				}
			},
			{ threshold: 0 }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!inView || !startWhen || !spanEl || reduced()) return;

		const el = spanEl;
		const decimals = maxDecimals;
		const sep = separator;
		const damping = 20 + 40 * (1 / duration);
		const stiffness = 100 * (1 / duration);
		const startValue = direction === 'down' ? to : from;
		const endValue = direction === 'down' ? from : to;

		onStart?.();
		el.textContent = formatValue(startValue, decimals, sep);

		let stopFn: (() => void) | undefined;

		const startTimeout = setTimeout(() => {
			const controls = animate(startValue, endValue, {
				type: 'spring',
				damping,
				stiffness,
				onUpdate: (latest: number) => {
					if (el) el.textContent = formatValue(latest, decimals, sep);
				}
			});
			stopFn = () => controls.stop();
		}, delay * 1000);

		const endTimeout = setTimeout(() => {
			onEnd?.();
		}, (delay + duration) * 1000);

		return () => {
			clearTimeout(startTimeout);
			clearTimeout(endTimeout);
			stopFn?.();
		};
	});
</script>

<span bind:this={spanEl} class={className}>{formatValue(direction === 'down' ? from : to, maxDecimals, separator)}</span>
