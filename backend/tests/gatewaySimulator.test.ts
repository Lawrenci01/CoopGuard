import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { createFarm, farmCode, openDatabase } from "../src/database";
import { seedLocalFarm } from "../src/shared/services/localFarmRepository";
import { provisionTelemetryGateway } from "../src/telemetry";

const run = promisify(execFile);

test("gateway simulator stores six months of marked history and preserves it after restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coopguard-gateway-history-"));
  const databasePath = join(directory, "test.sqlite");
  const configPath = join(directory, "gateway.json");
  const db = await openDatabase(databasePath);
  let appClosed = false;
  let dbClosed = false;
  const now = Date.now();
  const farmId = await createFarm(db, "Simulator history farm", now);
  const code = farmCode(farmId);
  const state = seedLocalFarm(now);
  state.deviceSimulation = {
    enabled: true,
    hub: {
      id: "HUB-HISTORY01",
      farmCode: code,
      pairingCode: "PAIRHISTORYHUB",
      status: "reporting",
      createdAt: now,
      pairedAt: now,
    },
    nodes: ["A", "B", "C"].map((section, index) => ({
      id: `NODE-HISTORY0${index + 1}`,
      farmCode: code,
      pairingCode: `PAIRHISTORY0${index + 1}`,
      section: section as "A" | "B" | "C",
      status: "reporting" as const,
      createdAt: now,
      pairedAt: now,
      hubId: "HUB-HISTORY01",
      x: 0.2 + index * 0.3,
      y: 0.5,
    })),
    history: [],
  };
  await db
    .prepare("UPDATE farms SET state=? WHERE id=?")
    .run(JSON.stringify(state), farmId);
  const credentials = await provisionTelemetryGateway(db, code, now);
  writeFileSync(
    configPath,
    `${JSON.stringify({ schemaVersion: 1, ...credentials }, null, 2)}\n`,
  );
  writeFileSync(
    `${configPath}.state.json`,
    `${JSON.stringify({
      sequences: { "NODE-OLD": 41 },
      historyGeneratedFor: { "NODE-OLD": now },
    })}\n`,
  );
  writeFileSync(
    `${configPath}.spool.json`,
    `${JSON.stringify([
      {
        schemaVersion: 1,
        source: "simulated",
        farmCode: "CG-PH-OLD00000",
        hubId: "HUB-OLD00000000",
        sentAt: new Date(now).toISOString(),
        readings: [],
      },
    ])}\n`,
  );
  const app = await createApp(db);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    if (!appClosed) await app.close();
    if (!dbClosed) await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const script = resolve(
    process.cwd(),
    "..",
    "hardware",
    "gateway-simulator.mjs",
  );
  const result = await run(
    process.execPath,
    [
      script,
      "--config",
      configPath,
      "--api",
      address,
      "--once",
      "--backfill-days",
      "183",
      "--backfill-interval",
      "60",
    ],
    { timeout: 60_000, maxBuffer: 2_000_000 },
  );
  assert.match(
    result.stderr,
    /Quarantined simulator state from a different hub or farm/,
  );
  assert.ok(
    readdirSync(directory).some((name) =>
      name.startsWith("gateway.json.spool.json.stale-"),
    ),
  );
  assert.match(result.stdout, /Prepared \d+ historical reading/);
  const coverage = await db
    .prepare(
      "SELECT COUNT(*) count,MIN(sampled_at) earliest,MAX(sampled_at) latest,COUNT(DISTINCT node_id) nodes,COUNT(DISTINCT source) sources FROM sensor_readings",
    )
    .get();
  assert.ok(Number(coverage?.count) >= 183 * 24 * 3);
  assert.equal(Number(coverage?.nodes), 3);
  assert.equal(Number(coverage?.sources), 1);
  assert.ok(Number(coverage?.earliest) <= now - 183 * 86_400_000 + 60_000);
  assert.ok(Number(coverage?.latest) >= now - 2 * 60_000);
  assert.equal(
    String(
      (await db.prepare("SELECT source FROM sensor_readings LIMIT 1").get())
        ?.source,
    ),
    "simulated",
  );

  await app.close();
  appClosed = true;
  await db.close();
  dbClosed = true;
  const reopened = await openDatabase(databasePath);
  assert.equal(
    Number(
      (
        await reopened
          .prepare("SELECT COUNT(*) count FROM sensor_readings")
          .get()
      )?.count,
    ),
    Number(coverage?.count),
  );
  await reopened.close();
});
