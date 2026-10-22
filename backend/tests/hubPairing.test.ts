import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createFarm, openDatabase } from "../src/database";
import { createHubPairing, refreshHubPairing } from "../src/hubPairing";
import { hashPassword } from "../src/passwords";
import { installationChecks } from "../src/shared/domain/siteWorkflow";
import { LocalFarmRepository } from "../src/shared/services/localFarmRepository";
import { completeSiteSurvey } from "./siteTestFixture";

test("a laptop hub is claimed once and replacement requires admin approval", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coopguard-hub-pairing-"));
  const databasePath = join(directory, "test.sqlite");
  const configPath = join(directory, "hub.json");
  const db = await openDatabase(databasePath);
  const now = Date.UTC(2026, 9, 8, 2, 0, 0);
  const farmId = await createFarm(db, "Pairing farm", now);
  const password = "Pairing test password 123!";
  const hash = await hashPassword(password);
  await db.batch([
    {
      sql: "INSERT INTO users(id,username,name,role,password_hash,must_change,created_at) VALUES(?,?,?,?,?,0,?)",
      args: [
        "pair-tech",
        "pair.tech",
        "Pair technician",
        "technician",
        hash,
        now,
      ],
    },
    {
      sql: "INSERT INTO users(id,username,name,role,password_hash,must_change,created_at) VALUES(?,?,?,?,?,0,?)",
      args: ["pair-admin", "pair.admin", "Pair admin", "admin", hash, now],
    },
  ]);
  const first = await createHubPairing(
    db,
    {
      wifiUrl: "https://192.168.1.10:8443",
      usbUrl: "https://localhost:8443",
      hotspot: {
        ssid: "CoopGuard-Hub-TEST01",
        passphrase: "hub-test-passphrase",
      },
    },
    now,
  );
  assert.deepEqual(JSON.parse(first.qr).hotspot, {
    ssid: "CoopGuard-Hub-TEST01",
    passphrase: "hub-test-passphrase",
  });
  writeFileSync(configPath, JSON.stringify(first.config), "utf8");
  writeFileSync(`${configPath}.pairing.txt`, first.qr, "utf8");
  const app = await createApp(db, {
    clock: () => now,
    deploymentMode: "hub",
    hubId: first.config.hubId,
    databasePath,
    hubConfigPath: configPath,
  });
  t.after(async () => {
    await app.close();
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const login = async (username: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().token as string;
  };
  const technician = await login("pair.tech");
  const developer = await app.inject({ method: "GET", url: "/developer" });
  assert.equal(developer.statusCode, 200, developer.body);
  assert.match(developer.body, /CoopGuard Laptop Hub/);
  const firstClaim = await app.inject({
    method: "POST",
    url: "/v1/hubs/claim",
    headers: { authorization: `Bearer ${technician}` },
    payload: { qr: first.qr, farmId, transport: "wifi" },
  });
  assert.equal(firstClaim.statusCode, 200, firstClaim.body);
  assert.equal(firstClaim.json().status, "claimed");
  assert.equal(firstClaim.json().server, "https://192.168.1.10:8443");
  // Hub commissioning no longer invents nodes. Each node is explicitly
  // registered by the technician under the selected farm and hub.
  assert.equal(
    Number(
      (
        await db
          .prepare("SELECT COUNT(*) n FROM telemetry_nodes WHERE active=1")
          .get()
      )?.n,
    ),
    0,
  );
  for (const section of ["A", "B", "C"]) {
    const added = await app.inject({
      method: "POST",
      url: `/v1/farms/${farmId}/nodes`,
      headers: { authorization: `Bearer ${technician}` },
      payload: { section },
    });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().source, "simulated");
  }
  const inventory = await app.inject({
    method: "GET",
    url: `/v1/farms/${farmId}/devices`,
    headers: { authorization: `Bearer ${technician}` },
  });
  assert.equal(inventory.statusCode, 200, inventory.body);
  assert.equal(inventory.json().hub.id, first.config.hubId);
  assert.equal(inventory.json().nodes.length, 3);
  assert.equal(inventory.json().nodes[0].source, "simulated");

  let preparedState: string | null = null;
  const workflow = new LocalFarmRepository(
    {
      getItem: async () => preparedState,
      setItem: async (_key, value) => {
        preparedState = value;
      },
    },
    () => now,
  );
  await workflow.load();
  await workflow.dispatch({
    type: "context",
    patch: { role: "technician", connection: "local" },
  });
  await workflow.dispatch({ type: "saveSiteSurvey", value: completeSiteSurvey() });
  await workflow.dispatch({ type: "approveSitePlan" });
  await workflow.dispatch({ type: "startInstallation" });
  for (const [key] of installationChecks)
    await workflow.dispatch({
      type: "siteChecklist",
      stage: "installation",
      key,
      value: "passed",
    });
  await db
    .prepare("UPDATE farms SET state=? WHERE id=?")
    .run(preparedState!, farmId);

  const telemetry = await app.inject({
    method: "POST",
    url: "/v1/telemetry/ingest",
    headers: {
      "x-coopguard-hub-id": first.config.hubId,
      "x-coopguard-hub-token": first.config.hubSecret,
    },
    payload: {
      schemaVersion: 1,
      source: "simulated",
      farmCode: firstClaim.json().farmCode,
      hubId: first.config.hubId,
      sentAt: new Date(now).toISOString(),
      readings: inventory.json().nodes.map(
        (node: { nodeId: string; section: string }, index: number) => ({
          messageId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          nodeId: node.nodeId,
          sequence: 0,
          section: node.section,
          sampledAt: new Date(now).toISOString(),
          firmwareVersion: "simulator-test",
          configVersion: "test-v1",
          readings: {
            temperatureC: 28,
            humidityPercent: 70,
            ammoniaPpm: 8,
            co2Ppm: 900,
            litterMoisturePercent: 24,
          },
          quality: { calibrated: true, warmingUp: false, sensorsValid: true },
          power: { batteryPercent: null },
          radio: { rssiDbm: -70, snrDb: 8 },
        }),
      ),
    },
  });
  assert.equal(telemetry.statusCode, 200, telemetry.body);

  const beginCommissioning = await app.inject({
    method: "POST",
    url: `/v1/farms/${farmId}/actions`,
    headers: { authorization: `Bearer ${technician}` },
    payload: {
      key: "00000000-0000-4000-8000-000000000099",
      revision: 0,
      action: { type: "beginCommissioning" },
    },
  });
  assert.equal(beginCommissioning.statusCode, 200, beginCommissioning.body);
  assert.equal(beginCommissioning.json().state.site.status, "commissioning");

  const duplicate = await app.inject({
    method: "POST",
    url: `/v1/farms/${farmId}/nodes`,
    headers: { authorization: `Bearer ${technician}` },
    payload: { section: "A", nodeId: inventory.json().nodes[0].nodeId },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);

  const removed = await app.inject({
    method: "DELETE",
    url: `/v1/farms/${farmId}/nodes/${inventory.json().nodes[0].nodeId}`,
    headers: { authorization: `Bearer ${technician}` },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const replacementNode = await app.inject({
    method: "POST",
    url: `/v1/farms/${farmId}/nodes`,
    headers: { authorization: `Bearer ${technician}` },
    payload: { section: "A" },
  });
  assert.equal(replacementNode.statusCode, 200, replacementNode.body);
  assert.equal(replacementNode.json().nodeId, `${first.config.hubId}-N04`);

  const refreshed = await refreshHubPairing(
    db,
    first.config,
    {
      wifiUrl: "https://192.168.137.1:8443",
      usbUrl: "https://localhost:8443",
      hotspot: {
        ssid: "CoopGuard-Hub-TEST01",
        passphrase: "hub-test-passphrase",
      },
    },
    now + 1,
  );
  assert.equal(JSON.parse(refreshed.qr).hubId, first.config.hubId);
  const refreshedClaim = await app.inject({
    method: "POST",
    url: "/v1/hubs/claim",
    headers: { authorization: `Bearer ${technician}` },
    payload: { qr: refreshed.qr, farmId, transport: "wifi" },
  });
  assert.equal(refreshedClaim.statusCode, 200, refreshedClaim.body);
  assert.equal(refreshedClaim.json().status, "claimed");
  assert.equal(refreshedClaim.json().server, "https://192.168.137.1:8443");
  assert.equal(
    Number(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM hub_replacement_requests WHERE status='pending'",
          )
          .get()
      )?.n,
    ),
    0,
  );

  const second = await createHubPairing(
    db,
    { wifiUrl: "https://192.168.1.11:8443", usbUrl: "https://localhost:8443" },
    now,
  );
  const replacement = await app.inject({
    method: "POST",
    url: "/v1/hubs/claim",
    headers: { authorization: `Bearer ${technician}` },
    payload: { qr: second.qr, farmId, transport: "usb" },
  });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal(replacement.json().status, "replacement_pending");
  assert.equal(
    String(
      (
        await db
          .prepare("SELECT id FROM telemetry_hubs WHERE farm_id=? AND active=1")
          .get(farmId)
      )?.id,
    ),
    first.config.hubId,
  );

  const admin = await login("pair.admin");
  const list = await app.inject({
    method: "GET",
    url: "/v1/admin/hub-replacements",
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.equal(list.statusCode, 200, list.body);
  const requestId = list.json().requests[0].id as string;
  const approval = await app.inject({
    method: "POST",
    url: `/v1/admin/hub-replacements/${requestId}/review`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { decision: "approve" },
  });
  assert.equal(approval.statusCode, 200, approval.body);
  assert.equal(approval.json().status, "approved");
  assert.equal(
    String(
      (
        await db
          .prepare("SELECT id FROM telemetry_hubs WHERE farm_id=? AND active=1")
          .get(farmId)
      )?.id,
    ),
    second.config.hubId,
  );
  assert.equal(
    Number(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM telemetry_hubs WHERE farm_id=? AND active=1",
          )
          .get(farmId)
      )?.n,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM telemetry_nodes WHERE farm_id=? AND active=1",
          )
          .get(farmId)
      )?.n,
    ),
    0,
  );
});
