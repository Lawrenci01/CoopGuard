import { createSocket } from "node:dgram";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;

const DHCP_DISCOVER = 1;
const DHCP_OFFER = 2;
const DHCP_REQUEST = 3;
const DHCP_ACK = 5;
const DHCP_MAGIC_COOKIE = Buffer.from([99, 130, 83, 99]);

export type DhcpRequest = {
  messageType: number;
  transactionId: number;
  flags: number;
  hardwareType: number;
  hardwareLength: number;
  clientHardwareAddress: Buffer;
  requestedAddress?: string;
  serverIdentifier?: string;
};

function ipv4Bytes(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    throw new Error(`Invalid IPv4 address: ${address}`);
  return Buffer.from(parts);
}

function ipv4Text(bytes: Buffer) {
  return [...bytes].join(".");
}

function option(packet: Buffer, code: number) {
  let offset = 240;
  while (offset < packet.length) {
    const current = packet[offset];
    if (current === 255) return undefined;
    if (current === 0) {
      offset += 1;
      continue;
    }
    const length = packet[offset + 1];
    if (current === undefined || length === undefined) return undefined;
    const start = offset + 2;
    const end = start + length;
    if (end > packet.length) return undefined;
    if (current === code) return packet.subarray(start, end);
    offset = end;
  }
  return undefined;
}

export function parseDhcpRequest(packet: Buffer): DhcpRequest | undefined {
  if (
    packet.length < 244 ||
    packet[0] !== 1 ||
    !packet.subarray(236, 240).equals(DHCP_MAGIC_COOKIE)
  )
    return undefined;
  const hardwareLength = packet[2] ?? 0;
  const messageType = option(packet, 53)?.[0];
  if (!messageType || hardwareLength < 1 || hardwareLength > 16) return undefined;
  const requestedAddress = option(packet, 50);
  const serverIdentifier = option(packet, 54);
  return {
    messageType,
    transactionId: packet.readUInt32BE(4),
    flags: packet.readUInt16BE(10),
    hardwareType: packet[1] ?? 1,
    hardwareLength,
    clientHardwareAddress: Buffer.from(
      packet.subarray(28, 28 + hardwareLength),
    ),
    ...(requestedAddress?.length === 4
      ? { requestedAddress: ipv4Text(requestedAddress) }
      : {}),
    ...(serverIdentifier?.length === 4
      ? { serverIdentifier: ipv4Text(serverIdentifier) }
      : {}),
  };
}

function appendOption(parts: Buffer[], code: number, value: Buffer) {
  parts.push(Buffer.from([code, value.length]), value);
}

export function buildDhcpReply(
  request: DhcpRequest,
  messageType: typeof DHCP_OFFER | typeof DHCP_ACK,
  leaseAddress: string,
  serverAddress: string,
) {
  const header = Buffer.alloc(240);
  header[0] = 2;
  header[1] = request.hardwareType;
  header[2] = request.hardwareLength;
  header.writeUInt32BE(request.transactionId, 4);
  header.writeUInt16BE(request.flags | 0x8000, 10);
  ipv4Bytes(leaseAddress).copy(header, 16);
  ipv4Bytes(serverAddress).copy(header, 20);
  request.clientHardwareAddress.copy(header, 28, 0, 16);
  DHCP_MAGIC_COOKIE.copy(header, 236);

  const options: Buffer[] = [];
  appendOption(options, 53, Buffer.from([messageType]));
  appendOption(options, 54, ipv4Bytes(serverAddress));
  const lease = Buffer.alloc(4);
  lease.writeUInt32BE(86_400);
  appendOption(options, 51, lease);
  appendOption(options, 1, ipv4Bytes("255.255.255.0"));
  appendOption(options, 3, ipv4Bytes(serverAddress));
  appendOption(options, 6, ipv4Bytes(serverAddress));
  appendOption(
    options,
    28,
    ipv4Bytes(`${serverAddress.split(".").slice(0, 3).join(".")}.255`),
  );
  options.push(Buffer.from([255]));
  const reply = Buffer.concat([header, ...options]);
  return reply.length >= 300
    ? reply
    : Buffer.concat([reply, Buffer.alloc(300 - reply.length)]);
}

export function leaseAddressFor(
  clientHardwareAddress: Buffer,
  serverAddress: string,
) {
  const prefix = serverAddress.split(".").slice(0, 3).join(".");
  const hash = [...clientHardwareAddress].reduce(
    (total, byte) => (total * 31 + byte) >>> 0,
    0,
  );
  return `${prefix}.${20 + (hash % 200)}`;
}

function hardwareAddressText(address: Buffer) {
  return [...address]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":");
}

export function startLocalDhcp(serverAddress: string) {
  ipv4Bytes(serverAddress);
  const socket = createSocket("udp4");
  const leases = new Map<string, string>();

  socket.on("message", (packet) => {
    const request = parseDhcpRequest(packet);
    if (!request) return;
    if (
      request.serverIdentifier &&
      request.serverIdentifier !== serverAddress
    )
      return;
    if (
      request.messageType !== DHCP_DISCOVER &&
      request.messageType !== DHCP_REQUEST
    )
      return;

    const client = request.clientHardwareAddress.toString("hex");
    const lease =
      leases.get(client) ??
      leaseAddressFor(request.clientHardwareAddress, serverAddress);
    leases.set(client, lease);
    const responseType =
      request.messageType === DHCP_DISCOVER ? DHCP_OFFER : DHCP_ACK;
    const response = buildDhcpReply(
      request,
      responseType,
      lease,
      serverAddress,
    );
    socket.send(response, DHCP_CLIENT_PORT, "255.255.255.255");
    console.log(
      `${responseType === DHCP_OFFER ? "Offered" : "Leased"} ${lease} to ${hardwareAddressText(request.clientHardwareAddress)}`,
    );
  });
  socket.on("error", (error) => {
    console.error(`Local DHCP failed: ${error.message}`);
    process.exitCode = 1;
    socket.close();
  });
  socket.bind(DHCP_SERVER_PORT, serverAddress, () => {
    socket.setBroadcast(true);
    console.log(`CoopGuard local DHCP listening on ${serverAddress}:67`);
  });
  return socket;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const addressIndex = process.argv.indexOf("--address");
  const address = addressIndex >= 0 ? process.argv[addressIndex + 1] : undefined;
  if (!address) throw new Error("Usage: localDhcp.ts --address <hotspot IPv4>");
  startLocalDhcp(address);
}
