import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDhcpReply,
  leaseAddressFor,
  parseDhcpRequest,
  type DhcpRequest,
} from "../src/localDhcp";

function requestPacket(messageType: number) {
  const packet = Buffer.alloc(300);
  packet[0] = 1;
  packet[1] = 1;
  packet[2] = 6;
  packet.writeUInt32BE(0x12345678, 4);
  Buffer.from("661a525bf5ce", "hex").copy(packet, 28);
  Buffer.from([99, 130, 83, 99]).copy(packet, 236);
  Buffer.from([53, 1, messageType, 50, 4, 192, 168, 137, 42, 255]).copy(
    packet,
    240,
  );
  return packet;
}

test("parses a DHCP request from the hotspot client", () => {
  const request = parseDhcpRequest(requestPacket(1));
  assert.deepEqual(request, {
    messageType: 1,
    transactionId: 0x12345678,
    flags: 0,
    hardwareType: 1,
    hardwareLength: 6,
    clientHardwareAddress: Buffer.from("661a525bf5ce", "hex"),
    requestedAddress: "192.168.137.42",
  });
});

test("builds a broadcast DHCP offer for the local /24", () => {
  const request = parseDhcpRequest(requestPacket(1)) as DhcpRequest;
  const reply = buildDhcpReply(
    request,
    2,
    "192.168.137.42",
    "192.168.137.1",
  );
  assert.equal(reply[0], 2);
  assert.equal(reply.readUInt32BE(4), 0x12345678);
  assert.equal(reply.readUInt16BE(10), 0x8000);
  assert.deepEqual([...reply.subarray(16, 20)], [192, 168, 137, 42]);
  assert.deepEqual([...reply.subarray(20, 24)], [192, 168, 137, 1]);
  assert.ok(reply.length >= 300);
});

test("assigns a stable lease inside the hotspot subnet", () => {
  const client = Buffer.from("661a525bf5ce", "hex");
  const first = leaseAddressFor(client, "192.168.137.1");
  assert.equal(first, leaseAddressFor(client, "192.168.137.1"));
  assert.match(first, /^192\.168\.137\.(?:2\d|[3-9]\d|1\d\d|2[01]\d)$/);
});
