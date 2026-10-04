/**
 * Which addresses a station's stream may be fetched from; `radio.ts` has the
 * rules. This file imports nothing of the app's own, so the e2e suite loads it
 * directly.
 */
import { BlockList, isIP } from 'node:net';

/**
 * Loopback, private, link-local, carrier-grade NAT, multicast and the
 * unspecified addresses. In IPv6 also the ranges that carry an IPv4 address
 * (IPv4-compatible, NAT64, 6to4, Teredo): on a host with such a tunnel they
 * reach that IPv4 address, private or not. `BlockList` matches an IPv4-mapped
 * address (`::ffff:10.0.0.1`) against the IPv4 rules itself.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 3]
] as const) {
	NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 96],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8]
] as const) {
	NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

export function isPublic(address: string, family: number): boolean {
	// An IPv4 address written as IPv6 is the IPv4 address.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return !NOT_PUBLIC.check(mapped[1], 'ipv4');
	return !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Whether the hop after this one may be on a private address: only where this
 * one was allowed to be and was itself served from one. `servedFrom` is the
 * address the connection was made to.
 *
 * A station on the internet writes its own redirect and playlist, and would
 * otherwise make this server fetch from the network it sits on.
 */
export function privateAllowedAfter(allowedSoFar: boolean, servedFrom: string | undefined): boolean {
	if (!allowedSoFar || !servedFrom) return false;
	return !isPublic(servedFrom, isIP(servedFrom));
}
