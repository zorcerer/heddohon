/**
 * The computer's audio output as the app reads it (issue #370), from the
 * answers the systems give, without the systems: `pactl` as PipeWire 1.2 and
 * PulseAudio 17 write it, and the Windows script's line. Runs under Node:
 *
 *   node --test test/output.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { describeOutput, fromPactl, fromWindows, parseSampleSpec, WINDOWS_SCRIPT } = require('../output.js');

const INFO = JSON.stringify({ server_name: 'PulseAudio (on PipeWire 1.2.7)', default_sink_name: 'alsa_output.usb-Topping_E30-00.analog-stereo' });
const SINKS = JSON.stringify([
	{ name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo', sample_specification: 's32le 2ch 48000Hz' },
	{ name: 'alsa_output.usb-Topping_E30-00.analog-stereo', description: 'E30 Analog Stereo', sample_specification: 's24le 2ch 44100Hz' }
]);

describe('the output as the system says it', () => {
	test("reads a sink's sample specification", () => {
		assert.deepEqual(parseSampleSpec('s24le 2ch 48000Hz'), { rateHz: 48000, bits: 24, float: false, channels: 2 });
		assert.deepEqual(parseSampleSpec('float32le 2ch 44100Hz'), { rateHz: 44100, bits: 32, float: true, channels: 2 });
		assert.deepEqual(parseSampleSpec('s16le 1ch 22050Hz'), { rateHz: 22050, bits: 16, float: false, channels: 1 });
		assert.equal(parseSampleSpec('nonsense'), null);
		assert.equal(parseSampleSpec(undefined), null);
	});

	test('on Linux, the default sink, or the one the output chosen in Heddohon names', () => {
		assert.deepEqual(fromPactl(INFO, SINKS, ''), { name: 'E30 Analog Stereo', system: 'PipeWire', rateHz: 44100, bits: 24, float: false, channels: 2 });
		assert.deepEqual(fromPactl(INFO, SINKS, 'Built-in Audio Analog Stereo').rateHz, 48000);
		assert.equal(fromPactl(INFO, SINKS, 'A device that is gone'), null);
		const pulse = JSON.stringify({ server_name: 'pulseaudio', default_sink_name: 'alsa_output.pci-0000_00_1f.3.analog-stereo' });
		assert.equal(fromPactl(pulse, SINKS, '').system, 'PulseAudio');
		assert.equal(fromPactl('not json', SINKS, ''), null);
		assert.equal(fromPactl(INFO, '{}', ''), null);
	});

	test('on Windows, what the script wrote, held to what it can be', () => {
		assert.deepEqual(fromWindows('{"name":"Speakers (Realtek(R) Audio)","rateHz":48000,"bits":24,"channels":2,"float":false}'), {
			name: 'Speakers (Realtek(R) Audio)',
			system: 'Windows',
			rateHz: 48000,
			bits: 24,
			float: false,
			channels: 2
		});
		assert.equal(fromWindows('{"name":"X","rateHz":0}'), null);
		assert.equal(fromWindows(''), null);
		assert.equal(fromWindows('{"name":"","rateHz":96000,"bits":0}').bits, null);
	});

	test('on any other system, nothing', async () => {
		assert.equal(await describeOutput('', 'darwin'), null);
	});
});

describe('the Windows script', { skip: process.platform !== 'win32' && 'Windows alone' }, () => {
	// A runner may have no audio device, so the answer may be empty; the script has to compile and run either way.
	test('compiles and runs, and writes an output or nothing', () => {
		const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
		const written = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
			input: '\n',
			encoding: 'utf8',
			timeout: 60_000
		});
		if (written.trim()) assert.ok(fromWindows(written), `the script wrote what is not an output: ${written}`);
	});
});
