import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    api: { type: "string" },
    once: { type: "boolean" },
    interval: { type: "string", default: "60" },
    "backfill-days": { type: "string", default: "183" },
    "backfill-interval": { type: "string", default: "60" },
  },
});
if (!values.config)
  throw new Error(
    "Use --config with the private JSON created by npm run provision:telemetry.",
  );
const configPath = resolve(values.config);
const readConfig = () => {
  const value = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    value.schemaVersion !== 1 ||
    typeof value.hubId !== "string" ||
    typeof value.hubSecret !== "string" ||
    typeof value.farmCode !== "string" ||
    !Array.isArray(value.nodes) ||
    !value.nodes.length
  )
    throw new Error("The gateway configuration is incomplete.");
  return value;
};
let config = readConfig();
const api = (
  values.api ??
  process.env.COOPGUARD_API_URL ??
  "https://localhost:8443"
).replace(/\/$/, "");
const intervalSeconds = Number(values.interval);
if (
  !Number.isFinite(intervalSeconds) ||
  intervalSeconds < 10 ||
  intervalSeconds > 3600
)
  throw new Error("--interval must be between 10 and 3600 seconds.");
const backfillDays = Number(values["backfill-days"]);
const backfillIntervalMinutes = Number(values["backfill-interval"]);
if (!Number.isInteger(backfillDays) || backfillDays < 0 || backfillDays > 730)
  throw new Error("--backfill-days must be between 0 and 730.");
if (
  !Number.isInteger(backfillIntervalMinutes) ||
  backfillIntervalMinutes < 15 ||
  backfillIntervalMinutes > 1440
)
  throw new Error("--backfill-interval must be between 15 and 1440 minutes.");

const statePath = `${configPath}.state.json`;
const spoolPath = `${configPath}.spool.json`;
const lockPath = `${configPath}.simulator.lock`;

function acquireLock() {
  if (existsSync(lockPath)) {
    const prior = Number(readFileSync(lockPath, "utf8").trim());
    try {
      if (Number.isInteger(prior) && prior > 0) process.kill(prior, 0);
      throw new Error(
        `Another gateway simulator is already running for this hub (process ${prior || "unknown"}).`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Another gateway"))
        throw error;
      unlinkSync(lockPath);
    }
  }
  const descriptor = openSync(lockPath, "wx", 0o600);
  writeFileSync(descriptor, String(process.pid), "utf8");
  closeSync(descriptor);
}

let ownsLock = false;
const releaseLock = () => {
  if (!ownsLock) return;
  ownsLock = false;
  try {
    unlinkSync(lockPath);
  } catch {}
};
acquireLock();
ownsLock = true;
process.once("exit", releaseLock);
process.once("SIGINT", () => {
  releaseLock();
  process.exit(0);
});
process.once("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
const load = (path, fallback) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `Could not read ${path}. Preserve it and repair the JSON before retrying.`,
    );
  }
};
const save = (path, value) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
};
let state = load(statePath, { sequences: {}, historyGeneratedFor: {} });
let spool = load(spoolPath, []);
if (!state || typeof state.sequences !== "object" || !Array.isArray(spool))
  throw new Error("The simulator state files are invalid.");
if (!state.historyGeneratedFor || typeof state.historyGeneratedFor !== "object")
  state.historyGeneratedFor = {};

const simulatorIdentity = `${config.farmCode}:${config.hubId}`;
const savedIdentity =
  typeof state.identity === "string" ? state.identity : undefined;
const foreignQueue = spool.some(
  (queued) =>
    !queued ||
    queued.farmCode !== config.farmCode ||
    queued.hubId !== config.hubId,
);

if ((savedIdentity && savedIdentity !== simulatorIdentity) || foreignQueue) {
  const suffix = Date.now();
  if (existsSync(statePath))
    renameSync(statePath, `${statePath}.stale-${suffix}`);
  if (existsSync(spoolPath))
    renameSync(spoolPath, `${spoolPath}.stale-${suffix}`);
  state = {
    identity: simulatorIdentity,
    sequences: {},
    historyGeneratedFor: {},
  };
  spool = [];
  console.warn(
    `Quarantined simulator state from a different hub or farm before generating telemetry for ${config.farmCode} / ${config.hubId}.`,
  );
} else {
  state.identity = simulatorIdentity;
}

function simulatedReading(node, index, sampledAt) {
  const sequence = Number(state.sequences[node.id] ?? -1) + 1;
  state.sequences[node.id] = sequence;
  const hour = sampledAt / 3_600_000;
  const daily = Math.sin(((hour % 24) / 24) * Math.PI * 2 - Math.PI / 2);
  const seasonal = Math.sin((hour / (24 * 183)) * Math.PI * 2);
  const drift = Math.sin(hour / 19 + index * 1.7);
  return {
    messageId: randomUUID(),
    nodeId: node.id,
    sequence,
    section: node.section,
    sampledAt: new Date(sampledAt).toISOString(),
    firmwareVersion: "simulator-0.7.0",
    configVersion: "simulator-reading-only-v1",
    readings: {
      temperatureC: Number(
        (29 + index * 0.3 + daily * 1.8 + seasonal * 0.7 + drift * 0.2).toFixed(
          2,
        ),
      ),
      humidityPercent: Number(
        (68 + index * 0.35 - daily * 4 + seasonal * 1.2 + drift * 0.4).toFixed(
          2,
        ),
      ),
      ammoniaPpm: Number(
        (9 + index * 0.4 + Math.max(0, -daily) * 2 + drift * 0.35).toFixed(2),
      ),
      co2Ppm: Math.round(
        820 + index * 42 + Math.max(0, -daily) * 210 + drift * 25,
      ),
      litterMoisturePercent: Number(
        (
          25 +
          index * 0.55 +
          seasonal * 1.4 -
          daily * 0.6 +
          drift * 0.25
        ).toFixed(2),
      ),
    },
    quality: { calibrated: true, warmingUp: false, sensorsValid: true },
    power: { batteryPercent: null },
    radio: { rssiDbm: -72 - index * 3, snrDb: 8 - index * 0.5 },
  };
}

function batch(readings, sentAt) {
  return {
    schemaVersion: 1,
    source: "simulated",
    farmCode: config.farmCode,
    hubId: config.hubId,
    sentAt: new Date(sentAt).toISOString(),
    readings,
  };
}

function seedHistory() {
  if (!backfillDays) return 0;
  const missing = config.nodes.filter(
    (node) => !state.historyGeneratedFor[node.id],
  );
  if (!missing.length) return 0;
  const intervalMs = backfillIntervalMinutes * 60_000;
  const end = Date.now() - intervalMs;
  const start = end - backfillDays * 86_400_000;
  const readings = [];
  for (let sampledAt = start; sampledAt <= end; sampledAt += intervalMs)
    missing.forEach((node) => {
      const index = config.nodes.findIndex((item) => item.id === node.id);
      readings.push(simulatedReading(node, index, sampledAt));
    });
  for (let index = 0; index < readings.length; index += 200)
    spool.push(batch(readings.slice(index, index + 200), Date.now()));
  const generatedAt = Date.now();
  missing.forEach((node) => {
    state.historyGeneratedFor[node.id] = generatedAt;
  });
  save(statePath, state);
  save(spoolPath, spool);
  console.log(
    `Prepared ${readings.length} historical reading(s) covering ${backfillDays} days for ${missing.length} node(s).`,
  );
  return readings.length;
}

function enqueue() {
  const sampledAt = Date.now();
  spool.push(
    batch(
      config.nodes.map((node, index) =>
        simulatedReading(node, index, sampledAt),
      ),
      sampledAt,
    ),
  );
  if (spool.length > 10_000)
    throw new Error(
      "The offline telemetry queue reached 10,000 batches. Check storage and connectivity.",
    );
  save(statePath, state);
  save(spoolPath, spool);
}

async function flush() {
  while (spool.length) {
    let response;
    try {
      response = await fetch(`${api}/v1/telemetry/ingest`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CoopGuard-Hub-Id": config.hubId,
          "X-CoopGuard-Hub-Token": config.hubSecret,
        },
        body: JSON.stringify(spool[0]),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.log(
        `Gateway offline; ${spool.length} batch(es) queued locally. ${error instanceof Error ? error.message : "Request failed."}`,
      );
      return;
    }
    const text = await response.text();
    if (!response.ok) {
      console.error(
        `Ingestion rejected the queued batch (${response.status}): ${text.slice(0, 300)}`,
      );
      return;
    }
    spool.shift();
    save(spoolPath, spool);
    const result = JSON.parse(text);
    console.log(
      `Sent ${result.accepted} reading(s); ${result.duplicates} duplicate(s); ${result.rejected.length} rejected; ${spool.length} batch(es) queued.`,
    );
  }
}

async function cycle() {
  config = readConfig();
  seedHistory();
  enqueue();
  await flush();
}

seedHistory();
await flush();
await cycle();
if (!values.once) {
  console.log(
    `Gateway simulator running every ${intervalSeconds} seconds against ${api}.`,
  );
  setInterval(() => void cycle(), intervalSeconds * 1000);
} else releaseLock();
