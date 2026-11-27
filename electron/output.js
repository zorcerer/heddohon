/**
 * The computer's audio output, for "What you're hearing" in the player (issue
 * #370): the device's name, and the rate and bit depth the system plays at.
 * Chromium plays through the system's mixer at the device's rate, so a file
 * at another rate is resampled on the way out; the page shows that as it
 * shows its own equaliser.
 *
 * Read from the system each time it is asked, held for `HOLD_MS`:
 *
 *  - Linux: `pactl`, which PipeWire answers as PulseAudio does. The default
 *    sink, or the one whose description is the label of the output chosen in
 *    Heddohon, which is what Chromium names it.
 *  - Windows: the endpoint's format as set under Sound settings
 *    (`PKEY_AudioEngine_DeviceFormat`) and its name
 *    (`PKEY_Device_FriendlyName`, Chromium's label), asked of Core Audio in a
 *    PowerShell script, with no native module in the package.
 *
 * Null where the system does not say, and on any other system. Needs nothing
 * of Electron, so `test/output.test.mjs` runs the parsers under Node.
 */
const { execFile } = require('node:child_process');

const HOLD_MS = 5000;
const TIMEOUT_MS = 8000;

/** `s24le 2ch 48000Hz`, as `pactl` writes a sink's sample specification, as numbers. */
function parseSampleSpec(spec) {
	const match = /^(\w+)\s+(\d+)ch\s+(\d+)Hz$/i.exec(String(spec ?? '').trim());
	if (!match) return null;
	const [, format, channels, rate] = match;
	const bits = /^float32/i.test(format) ? 32 : Number(/^[su](\d+)/i.exec(format)?.[1]) || null;
	return { rateHz: Number(rate), bits, float: /^float/i.test(format), channels: Number(channels) };
}

/**
 * The output from `pactl -f json info` and `pactl -f json list sinks`: the sink
 * whose description is `label`, or the default sink for none.
 */
function fromPactl(infoJson, sinksJson, label) {
	let info;
	let sinks;
	try {
		info = JSON.parse(infoJson);
		sinks = JSON.parse(sinksJson);
	} catch {
		return null;
	}
	if (!Array.isArray(sinks)) return null;
	const sink = label ? sinks.find((entry) => entry.description === label) : sinks.find((entry) => entry.name === info?.default_sink_name);
	if (!sink) return null;
	const spec = parseSampleSpec(sink.sample_specification);
	if (!spec) return null;
	const system = /pipewire/i.test(String(info?.server_name ?? '')) ? 'PipeWire' : 'PulseAudio';
	return { name: String(sink.description || sink.name), system, ...spec };
}

/*
 * Core Audio, from PowerShell's C#. The interfaces declare only the methods
 * they need, in their vtable order, each `[PreserveSig]`: without it .NET reads
 * the `int` as a hidden out-parameter and the HRESULT is thrown instead. x64 only, as the Windows app is: a
 * PROPVARIANT is 24 bytes there, its blob's size at 8 and its pointer at 16.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
public static class HeddohonOutput {
	[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
	[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDeviceEnumerator { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection devices); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
	[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDeviceCollection { [PreserveSig] int GetCount(out int count); [PreserveSig] int Item(int index, out IMMDevice device); }
	[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store); }
	[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IPropertyStore { [PreserveSig] int GetCount(out int count); [PreserveSig] int GetAt(int i, out Key key); [PreserveSig] int GetValue(ref Key key, out Variant value); }
	[StructLayout(LayoutKind.Sequential)] struct Key { public Guid Format; public int Id; }
	[StructLayout(LayoutKind.Explicit)] struct Variant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; [FieldOffset(8)] public int Size; [FieldOffset(16)] public IntPtr Data; }
	static Key Name = new Key { Format = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), Id = 14 };
	static Key Format = new Key { Format = new Guid("f19f064d-082c-4e27-bc73-6882a1bb8e4c"), Id = 0 };
	static string Describe(IMMDevice device) {
		IPropertyStore store; if (device.OpenPropertyStore(0, out store) != 0) return null;
		Variant name; store.GetValue(ref Name, out name);
		Variant format; store.GetValue(ref Format, out format);
		if (format.Type != 65 || format.Size < 16) return null;
		byte[] wave = new byte[format.Size];
		Marshal.Copy(format.Data, wave, 0, format.Size);
		int tag = BitConverter.ToUInt16(wave, 0), bits = BitConverter.ToUInt16(wave, 14);
		// WAVE_FORMAT_EXTENSIBLE carries the bits that hold audio after its header.
		if (tag == 0xFFFE && format.Size >= 20) { int valid = BitConverter.ToUInt16(wave, 18); if (valid > 0) bits = valid; }
		string label = name.Type == 31 ? Marshal.PtrToStringUni(name.Pointer) : "";
		return "{\"name\":\"" + label.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"rateHz\":" + BitConverter.ToUInt32(wave, 4)
			+ ",\"bits\":" + bits + ",\"channels\":" + BitConverter.ToUInt16(wave, 2) + ",\"float\":" + (tag == 3 ? "true" : "false") + "}";
	}
	public static string Find(string label) {
		var devices = (IMMDeviceEnumerator)new Enumerator();
		if (string.IsNullOrEmpty(label)) { IMMDevice device; if (devices.GetDefaultAudioEndpoint(0, 0, out device) != 0) return null; return Describe(device); }
		IMMDeviceCollection all; if (devices.EnumAudioEndpoints(0, 1, out all) != 0) return null;
		int count; all.GetCount(out count);
		for (int i = 0; i < count; i++) {
			IMMDevice device; all.Item(i, out device);
			string found = Describe(device);
			if (found != null && found.StartsWith("{\"name\":\"" + label.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")) return found;
		}
		return null;
	}
}
'@
$label = [Console]::In.ReadLine()
$found = [HeddohonOutput]::Find($label)
if ($found) { [Console]::Out.Write($found) }
`;

/** What the Windows script wrote, held to what it can be. */
function fromWindows(text) {
	let found;
	try {
		found = JSON.parse(text);
	} catch {
		return null;
	}
	if (!found || typeof found.rateHz !== 'number' || found.rateHz <= 0) return null;
	return {
		name: String(found.name ?? '').slice(0, 200) || 'Default output',
		system: 'Windows',
		rateHz: found.rateHz,
		bits: typeof found.bits === 'number' && found.bits > 0 ? found.bits : null,
		float: found.float === true,
		channels: typeof found.channels === 'number' ? found.channels : null
	};
}

function run(command, args, input = null) {
	return new Promise((resolve) => {
		const child = execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) =>
			resolve(err ? null : stdout)
		);
		if (input !== null) child.stdin?.end(`${input}\n`);
	});
}

const held = new Map();

/**
 * The output Chromium plays to: the system's default for no label, or the
 * device of that label. Null where the system does not say.
 */
async function describeOutput(label = '', platform = process.platform) {
	const key = `${platform}\u0000${label}`;
	const hit = held.get(key);
	if (hit && Date.now() - hit.at < HOLD_MS) return hit.output;
	let output = null;
	if (platform === 'linux') {
		const [info, sinks] = await Promise.all([run('pactl', ['-f', 'json', 'info']), run('pactl', ['-f', 'json', 'list', 'sinks'])]);
		output = info && sinks ? fromPactl(info, sinks, label) : null;
	} else if (platform === 'win32') {
		// Encoded, as Windows wants it (UTF-16LE in base64): the script's quotes
		// and lines would not survive being quoted on a command line.
		const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
		const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], label);
		output = text ? fromWindows(text) : null;
	}
	held.set(key, { at: Date.now(), output });
	return output;
}

module.exports = { describeOutput, fromPactl, fromWindows, parseSampleSpec, WINDOWS_SCRIPT };
