import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ServerOptions } from "node:https";
import { z } from "zod";
import { hashPassword, verifyPassword, temporaryPassword } from "./passwords";
import { mutationSchema, username, password, name } from "./schemas";
import {
  LocalFarmRepository,
  validLocalFarm,
  seedLocalFarm,
  type LocalAction,
  type LocalFarmState,
} from "./shared/services/localFarmRepository";
import { surveyRecommendation } from "./shared/domain/setup";
import type { Role, Section } from "./shared/domain/types";
import { houseGrid, positionInSection } from "./shared/domain/houseLayout";
import type { FarmResponse, Identity, Session } from "./apiTypes";
import { createFarm, type BatchStatement, type CoopDatabase } from "./database";
import {
  applyTelemetryToState,
  latestTelemetry,
  readingInsert,
  telemetryBatchSchema,
  telemetryHistory,
  validTelemetrySecret,
} from "./telemetry";
import {
  claimHub,
  hubBootstrap,
  parseHubPairingQr,
  replacementRequests,
  reviewReplacement,
  type HubPrivateConfig,
} from "./hubPairing";
import { registerDeveloperConsole } from "./developerConsole";

type User = {
  id: string;
  username: string;
  name: string;
  role: Role;
  password_hash: string;
  active: number;
  must_change: number;
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function connectionForHeaders(
  headers: Record<string, unknown>,
): "local" | "cloud" {
  if (typeof headers["cf-connecting-ip"] === "string") return "cloud";
  const host = typeof headers.host === "string" ? headers.host : "";
  let hostname = "";
  try {
    hostname = new URL(`https://${host}`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
  } catch {
    return "cloud";
  }
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname)
  )
    return "local";
  const match = hostname.match(/^172\.(\d{1,3})\./);
  return match && Number(match[1]) >= 16 && Number(match[1]) <= 31
    ? "local"
    : "cloud";
}
const requestConnection = (request: FastifyRequest) =>
  connectionForHeaders(request.headers);
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(400, result.error.issues[0]?.message ?? "Invalid request.");
  return result.data;
};

export async function createApp(
  db: CoopDatabase,
  options: {
    clock?: () => number;
    https?: ServerOptions;
    trustProxy?: boolean;
    deploymentMode?: "cloud" | "hub" | "standalone";
    hubId?: string;
    databasePath?: string;
    hubConfigPath?: string;
    developerConsole?: boolean;
    localApiUrl?: string;
  } = {},
) {
  const now = options.clock ?? Date.now;
  const connectionForRequest = (request: FastifyRequest) =>
    options.deploymentMode === "hub" &&
    typeof request.headers["cf-connecting-ip"] !== "string"
      ? "local"
      : requestConnection(request);
  const app = Fastify({
    logger: false,
    bodyLimit: 4_200_000,
    requestTimeout: 30_000,
    trustProxy: options.trustProxy ?? false,
    ...(options.https ? { https: options.https } : {}),
  });
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  const dummyHash = await hashPassword(temporaryPassword());
  const currentHubId = () => {
    if (options.hubConfigPath && existsSync(options.hubConfigPath)) {
      try {
        const value = JSON.parse(
          readFileSync(options.hubConfigPath, "utf8"),
        ) as { hubId?: unknown };
        if (typeof value.hubId === "string" && value.hubId) return value.hubId;
      } catch {}
    }
    return options.hubId;
  };
  const saveHubAssignment = (assignment: {
    hubId: string;
    farmCode: string;
    nodes: { id: string; number: string; section: string }[];
  }) => {
    const path = options.hubConfigPath;
    if (!path || !existsSync(path)) return;
    try {
      const config = JSON.parse(readFileSync(path, "utf8")) as HubPrivateConfig;
      if (config.hubId !== assignment.hubId) return;
      const temporary = `${path}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({ ...config, farmCode: assignment.farmCode, nodes: assignment.nodes }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      renameSync(temporary, path);
    } catch (error) {
      console.error("Could not update the private hub config:", error);
    }
  };
  const saveCurrentHubAssignment = async (farmId: string) => {
    const hub = await db
      .prepare(
        `SELECT h.id hubId,c.code farmCode FROM telemetry_hubs h
         JOIN farm_codes c ON c.farm_id=h.farm_id
         WHERE h.farm_id=? AND h.active=1`,
      )
      .get(farmId);
    if (!hub) return;
    const nodes = await db
      .prepare(
        "SELECT id,number,section FROM telemetry_nodes WHERE farm_id=? AND hub_id=? AND active=1 ORDER BY created_at,id",
      )
      .all(farmId, hub.hubId as string);
    saveHubAssignment({
      hubId: String(hub.hubId),
      farmCode: String(hub.farmCode),
      nodes: nodes.map((node) => ({
        id: String(node.id),
        number: String(node.number),
        section: String(node.section),
      })),
    });
  };
  const persistentDeviceSetupReady = async (
    farmId: string,
    state: LocalFarmState,
  ) => {
    if (!state.site.survey || !state.site.plan) return false;
    const status = await db
      .prepare(
        `SELECT h.last_seen_at lastSeenAt,
          (SELECT COUNT(*) FROM telemetry_nodes n
           WHERE n.farm_id=h.farm_id AND n.hub_id=h.id AND n.active=1
             AND EXISTS (SELECT 1 FROM sensor_readings r WHERE r.node_id=n.id LIMIT 1)) reportingNodes
         FROM telemetry_hubs h WHERE h.farm_id=? AND h.active=1`,
      )
      .get(farmId);
    return (
      status?.lastSeenAt != null &&
      Number(status.reportingNodes ?? 0) >= state.site.plan.nodeCount
    );
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const auditStatement = (
    user: User,
    farm: string | null,
    event: string,
    target: string | null = null,
  ): BatchStatement => ({
    sql: "INSERT INTO audit(user_id,farm_id,event,target_id,at) VALUES(?,?,?,?,?)",
    args: [user.id, farm, event, target, now()],
  });
  const audit = async (
    user: User,
    farm: string | null,
    event: string,
    target: string | null = null,
  ) => db.batch([auditStatement(user, farm, event, target)]);
  async function identity(user: User): Promise<Identity> {
    return {
      account: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        mustChangePassword: !!user.must_change,
      },
      farms:
        user.role === "admin"
          ? []
          : ((await db
              .prepare(
                user.role === "technician"
                  ? "SELECT f.id,f.name,c.code FROM farms f JOIN farm_codes c ON c.farm_id=f.id ORDER BY f.name"
                  : user.role === "owner"
                    ? "SELECT f.id,f.name,c.code FROM farms f JOIN farm_codes c ON c.farm_id=f.id JOIN memberships m ON m.farm_id=f.id WHERE m.user_id=? AND (SELECT COUNT(*) FROM memberships own_m WHERE own_m.user_id=m.user_id)=1 ORDER BY f.name"
                    : "SELECT f.id,f.name,c.code FROM farms f JOIN farm_codes c ON c.farm_id=f.id JOIN memberships m ON m.farm_id=f.id WHERE m.user_id=? ORDER BY f.name",
              )
              .all(...(user.role === "technician" ? [] : [user.id]))) as {
              id: string;
              name: string;
              code: string;
            }[]),
    };
  }
  async function issue(user: User): Promise<Session> {
    const token = randomBytes(32).toString("base64url"),
      expiresAt = now() + 7 * 86_400_000;
    await db.batch([
      { sql: "DELETE FROM sessions WHERE expires_at<=?", args: [now()] },
      {
        sql: "INSERT INTO sessions(digest,user_id,expires_at) VALUES(?,?,?)",
        args: [digest(token), user.id, expiresAt],
      },
    ]);
    return { ...(await identity(user)), token, expiresAt };
  }
  async function account(
    request: FastifyRequest,
    complete = true,
  ): Promise<User> {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) fail(401, "Sign in to continue.");
    const user = (await db
      .prepare(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.digest=? AND s.expires_at>? AND u.active=1",
      )
      .get(digest(token), now())) as User | undefined;
    if (!user) fail(401, "Your session has ended. Sign in again.");
    if (complete && user.must_change)
      fail(403, "Change your temporary password first.");
    return user;
  }
  async function access(
    request: FastifyRequest,
    roles: Role[] = ["owner", "worker", "technician"],
  ) {
    const user = await account(request);
    const farmId = (request.params as { farmId?: string }).farmId;
    if (!farmId || !roles.includes(user.role))
      fail(403, "You do not have access to this action or farm.");
    if (user.role !== "technician") {
      const membership = await db
        .prepare("SELECT 1 FROM memberships WHERE user_id=? AND farm_id=?")
        .get(user.id, farmId);
      if (!membership)
        fail(403, "You do not have access to this action or farm.");
      if (user.role === "owner") {
        const result = await db
          .prepare("SELECT COUNT(*) AS count FROM memberships WHERE user_id=?")
          .get(user.id);
        if (Number(result?.count) !== 1)
          fail(403, "Owner accounts can only be assigned to one farm.");
      }
    }
    return { user, farmId };
  }
  async function row(farmId: string) {
    const farm = (await db
      .prepare("SELECT state,revision FROM farms WHERE id=?")
      .get(farmId)) as { state: string; revision: number } | undefined;
    if (!farm) fail(404, "Farm not found.");
    return farm;
  }
  async function readFarm(
    farmId: string,
    user: User,
    request: FastifyRequest,
  ): Promise<FarmResponse> {
    const farm = await row(farmId);
    const repo = new LocalFarmRepository(
      {
        getItem: async () => farm.state,
        setItem: async (_key, value) => {
          farm.state = value;
        },
      },
      now,
    );
    let state = await repo.load();
    const telemetry = await latestTelemetry(db, farmId);
    const hasTelemetry = telemetry.some((node) => node.readings !== null);
    const readingSource = telemetry.some(
      (node) => node.readings !== null && node.source === "hardware",
    )
      ? "hardware"
      : hasTelemetry
        ? "simulated"
        : "sample";
    state = await applyTelemetryToState(db, farmId, state, now(), telemetry);
    // Cache reads do not refresh sensor timestamps or replay commands.
    state.context = {
      ...state.context,
      role: user.role,
      connection: connectionForRequest(request),
    };
    state.started = true;
    return {
      state,
      revision: farm.revision,
      readings: readingSource,
    };
  }
  const workers = async (farmId: string) =>
    (
      await db
        .prepare(
          `SELECT u.id,u.username,u.name,u.active,u.must_change FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.farm_id=? AND u.role='worker' ORDER BY u.name`,
        )
        .all(farmId)
    ).map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      active: !!u.active,
      mustChangePassword: !!u.must_change,
    }));
  async function targetWorker(farmId: string, id: string) {
    const user = (await db
      .prepare(
        `SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=? AND m.farm_id=? AND u.role='worker'`,
      )
      .get(id, farmId)) as User | undefined;
    if (!user) fail(404, "Worker not found in this farm.");
    // Owners cannot change a credential that grants access outside their farm.
    if (
      ((
        await db
          .prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id=?")
          .get(id)
      )?.n as number) !== 1
    )
      fail(403, "Contact the CoopGuard team to manage this account.");
    return user;
  }
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string };
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    reply.code(status).send({
      error:
        status < 500
          ? err.message
          : "The server could not complete the request.",
    });
  });
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.get("/health", async () => {
    const hubId = currentHubId();
    return {
      service: "CoopGuard",
      version: "0.7.0",
      readings: "live-or-sample",
      mode: options.deploymentMode ?? "standalone",
      ...(options.deploymentMode === "hub" && hubId ? { hubId } : {}),
      ...(db.syncState ? { sync: await db.syncState() } : {}),
    };
  });
  app.post("/v1/hubs/claim", (request) =>
    serial(async () => {
      const user = await account(request);
      if (user.role !== "technician")
        fail(403, "Only a CoopGuard technician can register a farm hub.");
      const body = parse(
        z
          .object({
            qr: z.string().min(20).max(4096),
            farmId: z.uuid(),
            transport: z.enum(["wifi", "usb"]),
          })
          .strict(),
        request.body,
      );
      const qr = parseHubPairingQr(body.qr);
      const result = await claimHub(db, body.qr, body.farmId, user.id, now());
      if (result.status === "claimed") saveHubAssignment(result);
      await audit(user, body.farmId, `hub_${result.status}`, result.hubId);
      return {
        ...result,
        server: body.transport === "wifi" ? qr.wifiUrl : qr.usbUrl,
        message:
          result.status === "claimed"
            ? "Hub registered to this farm."
            : "This farm already has an active hub. An administrator must approve the replacement.",
      };
    }),
  );
  app.get("/v1/hubs/bootstrap", async (request) => {
    const hubIdHeader = request.headers["x-coopguard-hub-id"],
      secretHeader = request.headers["x-coopguard-hub-token"];
    const hubId = Array.isArray(hubIdHeader) ? hubIdHeader[0] : hubIdHeader;
    const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    if (!hubId || !secret) fail(401, "Valid hub credentials are required.");
    return hubBootstrap(db, hubId, secret);
  });
  app.get("/v1/admin/hub-replacements", async (request) => {
    const user = await account(request);
    if (user.role !== "admin")
      fail(403, "Only a team admin can review hub replacements.");
    return { requests: await replacementRequests(db) };
  });
  app.post("/v1/admin/hub-replacements/:id/review", (request) =>
    serial(async () => {
      const user = await account(request);
      if (user.role !== "admin")
        fail(403, "Only a team admin can review hub replacements.");
      const id = parse(z.uuid(), (request.params as { id?: string }).id);
      const body = parse(
        z.object({ decision: z.enum(["approve", "reject"]) }).strict(),
        request.body,
      );
      const result = await reviewReplacement(
        db,
        id,
        user.id,
        body.decision,
        now(),
      );
      if (result.status === "approved") saveHubAssignment(result);
      await audit(user, null, `hub_replacement_${result.status}`, id);
      return result;
    }),
  );
  app.post(
    "/v1/telemetry/ingest",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    (request) =>
      serial(async () => {
        const hubIdHeader = request.headers["x-coopguard-hub-id"],
          secretHeader = request.headers["x-coopguard-hub-token"];
        const hubId = Array.isArray(hubIdHeader) ? hubIdHeader[0] : hubIdHeader;
        const secret = Array.isArray(secretHeader)
          ? secretHeader[0]
          : secretHeader;
        if (!hubId || !secret || secret.length < 32 || secret.length > 256)
          fail(401, "Valid hub credentials are required.");
        const hub = (await db
          .prepare(
            `SELECT h.id,h.farm_id,h.secret_digest,c.code
             FROM telemetry_hubs h JOIN farm_codes c ON c.farm_id=h.farm_id
             WHERE h.id=? AND h.active=1`,
          )
          .get(hubId)) as
          | { id: string; farm_id: string; secret_digest: string; code: string }
          | undefined;
        if (!hub || !validTelemetrySecret(secret, hub.secret_digest))
          fail(401, "Valid hub credentials are required.");
        const body = parse(telemetryBatchSchema, request.body);
        if (body.hubId !== hub.id || body.farmCode !== hub.code)
          fail(
            403,
            "This telemetry packet is bound to a different hub or farm.",
          );
        const receivedAt = now();
        if (Date.parse(body.sentAt) > receivedAt + 5 * 60_000)
          fail(400, "The gateway time is too far in the future.");
        const registered = (await db
          .prepare(
            "SELECT id,section FROM telemetry_nodes WHERE hub_id=? AND farm_id=? AND active=1",
          )
          .all(hub.id, hub.farm_id)) as { id: string; section: string }[];
        const nodes = new Map(
          registered.map((node) => [node.id, node.section]),
        );
        const messagePlaceholders = body.readings.map(() => "?").join(",");
        const existingRows = (await db
          .prepare(
            `SELECT message_id,sequence,node_id FROM sensor_readings
             WHERE hub_id=? AND message_id IN (${messagePlaceholders})`,
          )
          .all(hub.id, ...body.readings.map((reading) => reading.messageId))) as {
          message_id: string;
          sequence: number;
          node_id: string;
        }[];
        const existingMessages = new Map(
          existingRows.map((reading) => [reading.message_id, reading]),
        );
        const existingSequenceRows: {
          message_id: string;
          sequence: number;
          node_id: string;
        }[] = [];
        for (let index = 0; index < body.readings.length; index += 60) {
          const chunk = body.readings.slice(index, index + 60);
          const predicates = chunk
            .map(() => "(node_id=? AND sequence=?)")
            .join(" OR ");
          existingSequenceRows.push(
            ...((await db
              .prepare(
                `SELECT message_id,sequence,node_id FROM sensor_readings
                 WHERE hub_id=? AND (${predicates})`,
              )
              .all(
                hub.id,
                ...chunk.flatMap((reading) => [
                  reading.nodeId,
                  reading.sequence,
                ]),
              )) as {
              message_id: string;
              sequence: number;
              node_id: string;
            }[]),
          );
        }
        const existingSequences = new Map(
          existingSequenceRows.map((reading) => [
            `${reading.node_id}:${Number(reading.sequence)}`,
            reading,
          ]),
        );
        const maximumRows = (await db
          .prepare(
            "SELECT node_id,MAX(sequence) maximum FROM sensor_readings WHERE hub_id=? GROUP BY node_id",
          )
          .all(hub.id)) as { node_id: string; maximum: number }[];
        const accepted: typeof body.readings = [],
          rejected: { messageId: string; reason: string }[] = [];
        let duplicates = 0;
        const maxSequences = new Map(
          maximumRows.map((row) => [row.node_id, Number(row.maximum)]),
        );
        const batchMessages = new Map<string, string>();
        const batchSequences = new Map<string, string>();
        for (const reading of body.readings) {
          const identity = `${reading.nodeId}:${reading.sequence}`;
          const sequenceKey = `${reading.nodeId}:${reading.sequence}`;
          const messageIdentity = batchMessages.get(reading.messageId);
          const sequenceMessage = batchSequences.get(sequenceKey);
          if (messageIdentity !== undefined || sequenceMessage !== undefined) {
            if (
              messageIdentity === identity &&
              sequenceMessage === reading.messageId
            )
              duplicates += 1;
            else
              rejected.push({
                messageId: reading.messageId,
                reason: "identity_conflict",
              });
            continue;
          }
          if (!nodes.has(reading.nodeId)) {
            rejected.push({
              messageId: reading.messageId,
              reason: "node_not_registered",
            });
            continue;
          }
          if (nodes.get(reading.nodeId) !== reading.section) {
            rejected.push({
              messageId: reading.messageId,
              reason: "section_mismatch",
            });
            continue;
          }
          const sampledAt = Date.parse(reading.sampledAt);
          if (sampledAt > receivedAt + 5 * 60_000) {
            rejected.push({
              messageId: reading.messageId,
              reason: "sample_time_in_future",
            });
            continue;
          }
          const existingMessage = existingMessages.get(reading.messageId);
          const existingSequence = existingSequences.get(sequenceKey);
          if (existingMessage || existingSequence) {
            if (
              existingMessage?.message_id === reading.messageId &&
              existingMessage.node_id === reading.nodeId &&
              Number(existingMessage.sequence) === reading.sequence &&
              existingSequence?.message_id === reading.messageId
            )
              duplicates += 1;
            else
              rejected.push({
                messageId: reading.messageId,
                reason: "identity_conflict",
              });
            continue;
          }
          const maximum = maxSequences.get(reading.nodeId) ?? -1;
          if (reading.sequence <= maximum) {
            rejected.push({
              messageId: reading.messageId,
              reason: "sequence_replayed",
            });
            continue;
          }
          maxSequences.set(reading.nodeId, reading.sequence);
          batchMessages.set(reading.messageId, identity);
          batchSequences.set(sequenceKey, reading.messageId);
          accepted.push(reading);
        }
        if (accepted.length)
          await db.batch([
            ...accepted.map((reading) =>
              readingInsert(
                hub.farm_id,
                hub.id,
                reading,
                receivedAt,
                body.source,
              ),
            ),
            {
              sql: "UPDATE telemetry_hubs SET last_seen_at=? WHERE id=?",
              args: [receivedAt, hub.id],
            },
          ]);
        return {
          accepted: accepted.length,
          duplicates,
          rejected,
          serverReceivedAt: new Date(receivedAt).toISOString(),
        };
      }),
  );
  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(
        z.object({ username, password: z.string().min(1).max(128) }).strict(),
        request.body,
      );
      const key = digest(body.username),
        attempt = (await db
          .prepare("SELECT count,until_at FROM login_attempts WHERE key=?")
          .get(key)) as { count: number; until_at: number } | undefined;
      if (attempt && attempt.count >= 10 && attempt.until_at > now())
        fail(429, "Too many sign-in attempts. Try again in 15 minutes.");
      await db
        .prepare("DELETE FROM login_attempts WHERE until_at<=?")
        .run(now());
      // Count before expensive work so concurrent requests cannot skip the limit.
      await db
        .prepare(
          "INSERT INTO login_attempts(key,count,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        )
        .run(key, now() + 15 * 60_000);
      const user = (await db
        .prepare("SELECT * FROM users WHERE username=?")
        .get(body.username)) as User | undefined;
      const valid = await verifyPassword(
        body.password,
        user?.password_hash ?? dummyHash,
      );
      const fresh =
        user &&
        ((await db.prepare("SELECT * FROM users WHERE id=?").get(user.id)) as
          | User
          | undefined);
      if (
        !valid ||
        !fresh?.active ||
        fresh.password_hash !== user?.password_hash
      )
        fail(401, "Incorrect username or password.");
      await db.prepare("DELETE FROM login_attempts WHERE key=?").run(key);
      await audit(fresh, null, "login");
      return await issue(fresh);
    },
  );
  app.get("/v1/me", async (request) => identity(await account(request, false)));
  app.post("/v1/auth/logout", async (request) => {
    const user = await account(request, false);
    await db
      .prepare("DELETE FROM sessions WHERE digest=?")
      .run(digest(request.headers.authorization!.slice(7)));
    await audit(user, null, "logout");
    return { ok: true };
  });
  app.post(
    "/v1/auth/password",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request) => {
      const user = await account(request, false);
      const body = parse(
        z
          .object({
            currentPassword: z.string().min(1).max(128),
            newPassword: password,
          })
          .strict(),
        request.body,
      );
      if (!(await verifyPassword(body.currentPassword, user.password_hash)))
        fail(400, "Current password is incorrect.");
      if (body.currentPassword === body.newPassword)
        fail(400, "Choose a different password.");
      const hash = await hashPassword(body.newPassword);
      const fresh = await account(request, false);
      if (fresh.password_hash !== user.password_hash)
        fail(409, "The password changed. Sign in again.");
      await db.batch([
        {
          sql: "UPDATE users SET password_hash=?,must_change=0 WHERE id=?",
          args: [hash, user.id],
        },
        { sql: "DELETE FROM sessions WHERE user_id=?", args: [user.id] },
        auditStatement(user, null, "password_changed"),
      ]);
      return await issue({ ...fresh, must_change: 0, password_hash: hash });
    },
  );
  app.post("/v1/admin/farms", async (request) => {
    const user = await account(request, false);
    if (user.role !== "admin") fail(403, "Only a team admin can create farms.");
    const body = parse(
      z
        .object({
          farmName: z.string().trim().min(1).max(80),
          customerName: z.string().trim().min(1).max(120).optional(),
          contactName: z.string().trim().min(1).max(120).optional(),
          contactPhone: z.string().trim().min(1).max(40).optional(),
          address: z.string().trim().min(1).max(200).optional(),
          ownerUsername: username,
          ownerName: name,
        })
        .strict(),
      request.body,
    );
    const ownerUsername = body.ownerUsername;
    if (
      await db
        .prepare("SELECT 1 FROM users WHERE username=?")
        .get(ownerUsername)
    )
      fail(
        409,
        "This owner username is unavailable. Choose a unique account name.",
      );
    const ownerPassword = temporaryPassword();
    const farmId = await createFarm(db, body.farmName, now(), {
      customerName: body.customerName,
      contactName: body.contactName,
      contactPhone: body.contactPhone,
      address: body.address,
    });
    const farmCode = (await db
      .prepare("SELECT code FROM farm_codes WHERE farm_id=?")
      .get(farmId)) as { code: string } | undefined;
    if (!farmCode) fail(500, "Farm code generation failed.");
    const ownerHash = await hashPassword(ownerPassword);
    const ownerUserId = randomUUID();
    await db.batch([
      {
        sql: "INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES(?,?,?,'owner',?,?)",
        args: [ownerUserId, ownerUsername, body.ownerName, ownerHash, now()],
      },
      {
        sql: "INSERT INTO memberships(user_id,farm_id) VALUES(?,?)",
        args: [ownerUserId, farmId],
      },
      auditStatement(user, farmId, "farm_created", farmId),
    ]);
    return {
      farmId,
      farmCode: farmCode.code,
      qr: `coopguard://farm/open?version=1&farm=${encodeURIComponent(farmCode.code)}`,
      owner: {
        username: ownerUsername,
        name: body.ownerName,
        password: ownerPassword,
      },
    };
  });
  app.get("/v1/admin/farms", async (request) => {
    const user = await account(request, false);
    if (user.role !== "admin")
      fail(403, "Only a team admin can view all farms.");
    const farms = await db
      .prepare(
        `SELECT f.id,f.name,f.customer_name customerName,f.contact_name contactName,
                f.contact_phone contactPhone,f.address,c.code,
                h.id hubId,h.source hubSource,h.last_seen_at hubLastSeenAt,
                (SELECT COUNT(*) FROM telemetry_nodes n WHERE n.farm_id=f.id AND n.active=1) nodeCount
         FROM farms f JOIN farm_codes c ON c.farm_id=f.id
         LEFT JOIN telemetry_hubs h ON h.farm_id=f.id AND h.active=1
         ORDER BY f.created_at DESC,f.name`,
      )
      .all();
    return {
      farms: await Promise.all(
        farms.map(async (farm) => {
          const nodes = await latestTelemetry(db, String(farm.id));
          return {
            ...farm,
            nodeCount: Number(farm.nodeCount ?? 0),
            latest:
              nodes
                .filter((node) => node.readings !== null)
                .sort((a, b) => (b.sampledAt ?? 0) - (a.sampledAt ?? 0))[0] ??
              null,
          };
        }),
      ),
    };
  });
  app.get("/v1/farms/:farmId/devices", async (request) => {
    const { farmId } = await access(request);
    const hub = await db
      .prepare(
        `SELECT id,farm_id farmId,source,created_at createdAt,last_seen_at lastSeenAt
         FROM telemetry_hubs WHERE farm_id=? AND active=1`,
      )
      .get(farmId);
    return { hub: hub ?? null, nodes: await latestTelemetry(db, farmId) };
  });
  app.post("/v1/farms/:farmId/nodes", (request) =>
    serial(async () => {
      const { user, farmId } = await access(request, ["technician"]);
      const body = parse(
        z
          .object({
            nodeId: z
              .string()
              .trim()
              .min(3)
              .max(64)
              .regex(/^[A-Za-z0-9_-]+$/)
              .optional(),
            section: z.string().regex(/^[A-Z]{1,4}$/),
          })
          .strict(),
        request.body,
      );
      const hub = await db
        .prepare("SELECT id FROM telemetry_hubs WHERE farm_id=? AND active=1")
        .get(farmId);
      if (!hub)
        fail(409, "Pair a hub to this farm before adding sensor nodes.");
      const farm = await row(farmId);
      const state = JSON.parse(farm.state) as LocalFarmState;
      const house = state.site.survey?.house ?? state.house;
      const layout = houseGrid(
        house?.lengthMetres ?? 90,
        house?.widthMetres ?? 12,
      );
      if (!layout.sections.includes(body.section as Section))
        fail(400, "Choose a section from this farm's approved house map.");
      const existingNodes = await db
        .prepare(
          "SELECT id,section FROM telemetry_nodes WHERE farm_id=? AND hub_id=? AND active=1 ORDER BY created_at,id",
        )
        .all(farmId, hub.id as string);
      const nextNumber = await db
        .prepare(
          "SELECT COALESCE(MAX(CAST(number AS INTEGER)),0)+1 value FROM telemetry_nodes WHERE hub_id=?",
        )
        .get(hub.id as string);
      const number = String(Number(nextNumber?.value ?? 1)).padStart(2, "0");
      const nodeId = body.nodeId ?? `${String(hub.id)}-N${number}`;
      if (
        await db.prepare("SELECT 1 FROM telemetry_nodes WHERE id=?").get(nodeId)
      )
        fail(409, "This sensor node is already registered.");
      const peers = existingNodes.filter(
        (node) => String(node.section) === body.section,
      );
      const placement = positionInSection(
        body.section as Section,
        layout,
        peers.length,
        peers.length + 1,
      );
      await db.batch([
        {
          sql: "INSERT INTO telemetry_nodes(id,farm_id,hub_id,number,section,x,y,control,source,active,created_at) VALUES(?,?,?,?,?,?,?,0,'simulated',1,?)",
          args: [
            nodeId,
            farmId,
            hub.id as string,
            number,
            body.section,
            placement.x,
            placement.y,
            now(),
          ],
        },
        auditStatement(user, farmId, "telemetry_node_registered", nodeId),
      ]);
      await saveCurrentHubAssignment(farmId);
      return {
        hub: hub.id,
        nodeId,
        section: body.section,
        source: "simulated",
      };
    }),
  );
  app.delete("/v1/farms/:farmId/nodes/:nodeId", (request) =>
    serial(async () => {
      const { user, farmId } = await access(request, ["technician"]);
      const nodeId = parse(
        z.string().trim().min(3).max(64),
        (request.params as { nodeId?: string }).nodeId,
      );
      const result = await db
        .prepare(
          "UPDATE telemetry_nodes SET active=0 WHERE id=? AND farm_id=? AND active=1",
        )
        .run(nodeId, farmId);
      if (!result.changes) fail(404, "Sensor node not found in this farm.");
      await audit(user, farmId, "telemetry_node_deactivated", nodeId);
      await saveCurrentHubAssignment(farmId);
      return { ok: true };
    }),
  );
  app.get("/v1/farms/:farmId", (request) =>
    serial(async () => {
      const { user, farmId } = await access(request);
      return readFarm(farmId, user, request);
    }),
  );
  app.get("/v1/farms/:farmId/telemetry/latest", async (request) => {
    const { farmId } = await access(request);
    return {
      thresholdProfile: null,
      classification: "reading_only",
      staleAfterSeconds: 180,
      nodes: await latestTelemetry(db, farmId),
    };
  });
  app.get("/v1/farms/:farmId/telemetry/history", async (request) => {
    const { farmId } = await access(request);
    const query = parse(
      z
        .object({
          nodeId: z.string().trim().min(3).max(64),
          metric: z.enum([
            "temperature",
            "humidity",
            "ammonia",
            "co2",
            "moisture",
          ]),
          from: z.coerce.number().int().nonnegative(),
          to: z.coerce.number().int().positive(),
          limit: z.coerce.number().int().min(1).max(1000).default(500),
          bucketMs: z.coerce
            .number()
            .int()
            .min(60_000)
            .max(7 * 86_400_000)
            .optional(),
        })
        .strict(),
      request.query,
    );
    if (query.from > query.to)
      fail(400, "The history start must be before its end.");
    return {
      nodeId: query.nodeId,
      metric: query.metric,
      points: await telemetryHistory(
        db,
        farmId,
        query.nodeId,
        query.metric,
        query.from,
        query.to,
        query.limit,
        query.bucketMs,
      ),
    };
  });
  app.post("/v1/farms/:farmId/actions", (request) =>
    serial(async () => {
      const { user, farmId } = await access(request),
        body = parse(mutationSchema, request.body);
      const action = body.action as LocalAction;
      if (
        action.type === "createVirtualHub" ||
        action.type === "createVirtualNode"
      ) {
        const target = (await db
          .prepare("SELECT code FROM farm_codes WHERE farm_id=?")
          .get(farmId)) as { code: string } | undefined;
        if (!target || action.farmCode !== target.code)
          fail(400, "The device Farm ID does not match the selected farm.");
      }
      if (
        [
          "addSensor",
          "moveSensor",
          "retireSensor",
          "calibrate",
          "saveSiteSurvey",
          "approveSitePlan",
          "startInstallation",
          "beginCommissioning",
          "startMonitoringTrial",
          "siteChecklist",
          "activateSite",
          "createVirtualHub",
          "createVirtualNode",
          "pairVirtualDevice",
          "removeVirtualDevice",
          "updateVirtualFirmware",
        ].includes(action.type) &&
        user.role !== "technician"
      )
        fail(403, "Only a technician can manage devices.");
      if (
        ["startFlock", "endFlock"].includes(action.type) &&
        user.role !== "owner"
      )
        fail(403, "Only the owner can manage flock cycles.");
      if (action.type === "house" && user.role !== "technician")
        fail(403, "Only a technician can complete or change the site survey.");
      const fingerprint = digest(JSON.stringify(body.action));
      const duplicate = await db
        .prepare(
          "SELECT body_hash FROM mutations WHERE farm_id=? AND user_id=? AND key=?",
        )
        .get(farmId, user.id, body.key);
      if (duplicate) {
        if (duplicate.body_hash !== fingerprint)
          fail(409, "This request identifier was already used.");
        return readFarm(farmId, user, request);
      }
      const farm = await row(farmId),
        before = await applyTelemetryToState(
          db,
          farmId,
          JSON.parse(farm.state) as LocalFarmState,
          now(),
        );
      const appendNote = action.type === "saveInspection" && !action.id;
      if (
        !appendNote &&
        action.type !== "ack" &&
        body.revision !== farm.revision
      )
        fail(
          409,
          "Farm records changed on another phone. Refresh and try again.",
        );
      if (
        (action.type === "saveInspection" && action.id) ||
        action.type === "deleteInspection"
      ) {
        const note = before.inspections.find((n) => n.id === action.id);
        if (!note || (user.role !== "owner" && note.authorId !== user.id))
          fail(403, "You can only change your own inspection notes.");
      }
      let saved = JSON.stringify(before);
      const repo = new LocalFarmRepository(
        {
          getItem: async () => saved,
          setItem: async (_key, value) => {
            saved = value;
          },
        },
        now,
        { deviceSetupReady: await persistentDeviceSetupReady(farmId, before) },
      );
      await repo.load();
      await repo.dispatch({
        type: "context",
        patch: { role: user.role, connection: connectionForRequest(request) },
      });
      let state: LocalFarmState;
      try {
        state = await repo.dispatch(action);
      } catch (error) {
        fail(
          400,
          error instanceof Error
            ? error.message
            : "The action could not be completed.",
        );
      }
      if (appendNote)
        Object.assign(state.inspections[0]!, {
          authorId: user.id,
          authorName: user.name,
        });
      await access(request);
      await db.batch([
        {
          sql: "UPDATE farms SET state=?,revision=revision+1 WHERE id=?",
          args: [JSON.stringify(state), farmId],
        },
        {
          sql: "INSERT INTO mutations(farm_id,user_id,key,body_hash) VALUES(?,?,?,?)",
          args: [farmId, user.id, body.key, fingerprint],
        },
        auditStatement(user, farmId, action.type),
      ]);
      return readFarm(farmId, user, request);
    }),
  );
  app.post("/v1/farms/:farmId/import", (request) =>
    serial(async () => {
      const { user, farmId } = await access(request, ["technician"]);
      if (connectionForRequest(request) !== "local")
        fail(
          403,
          "Import previous phone records while connected on the farm WiFi.",
        );
      if ((await row(farmId)).revision !== 0)
        fail(
          409,
          "Import is only available before this farm has saved changes.",
        );
      const draft = request.body;
      if (!validLocalFarm(draft))
        fail(400, "The saved phone records are invalid.");
      const state = structuredClone(draft);
      state.context = {
        role: "technician",
        connection: "local",
        controlMode:
          state.house && surveyRecommendation(state.house) === "eligible"
            ? "full"
            : "monitor",
      };
      state.snapshot.request = null;
      state.snapshot.fanStage = "high";
      state.started = true;
      state.people = seedLocalFarm().people;
      state.inspections.forEach((n) => {
        n.authorId = user.id;
        n.authorName = user.name;
      });
      if (state.flock?.id === "flock-1") state.flock = null;
      await db
        .prepare("UPDATE farms SET state=?,revision=1 WHERE id=?")
        .run(JSON.stringify(state), farmId);
      await audit(user, farmId, "phone_records_imported");
      return { state, revision: 1, readings: "sample" };
    }),
  );
  app.get("/v1/farms/:farmId/workers", async (request) => {
    const { farmId } = await access(request, ["owner"]);
    return await workers(farmId);
  });
  app.post(
    "/v1/farms/:farmId/workers",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const { farmId } = await access(request, ["owner"]);
      const body = parse(
        z.object({ username, name, temporaryPassword: password }).strict(),
        request.body,
      );
      const hash = await hashPassword(body.temporaryPassword);
      const { user } = await access(request, ["owner"]),
        id = randomUUID();
      if (
        await db
          .prepare("SELECT 1 FROM users WHERE username=?")
          .get(body.username)
      )
        fail(409, "This username is unavailable.");
      await db.batch([
        {
          sql: "INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES(?,?,?,'worker',?,?)",
          args: [id, body.username, body.name, hash, now()],
        },
        {
          sql: "INSERT INTO memberships(user_id,farm_id) VALUES(?,?)",
          args: [id, farmId],
        },
        auditStatement(user, farmId, "worker_created", id),
      ]);
      return await workers(farmId);
    },
  );
  app.patch("/v1/farms/:farmId/workers/:id", async (request) => {
    const { user, farmId } = await access(request, ["owner"]),
      id = (request.params as { id: string }).id;
    await targetWorker(farmId, id);
    const body = parse(
      z.object({ name, active: z.boolean() }).strict(),
      request.body,
    );
    await db
      .prepare("UPDATE users SET name=?,active=? WHERE id=?")
      .run(body.name, Number(body.active), id);
    if (!body.active)
      await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    await audit(
      user,
      farmId,
      body.active ? "worker_updated" : "worker_disabled",
      id,
    );
    return await workers(farmId);
  });
  app.post(
    "/v1/farms/:farmId/workers/:id/password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const { farmId } = await access(request, ["owner"]),
        id = (request.params as { id: string }).id;
      await targetWorker(farmId, id);
      const body = parse(
          z.object({ temporaryPassword: password }).strict(),
          request.body,
        ),
        hash = await hashPassword(body.temporaryPassword);
      const { user } = await access(request, ["owner"]);
      await targetWorker(farmId, id);
      await db.batch([
        {
          sql: "UPDATE users SET password_hash=?,must_change=1 WHERE id=?",
          args: [hash, id],
        },
        { sql: "DELETE FROM sessions WHERE user_id=?", args: [id] },
        auditStatement(user, farmId, "worker_password_reset", id),
      ]);
      return { ok: true };
    },
  );
  if (options.databasePath && options.hubConfigPath)
    registerDeveloperConsole(app, db, {
      enabled: options.developerConsole ?? options.deploymentMode !== "cloud",
      mode: options.deploymentMode ?? "standalone",
      databasePath: options.databasePath,
      hubConfigPath: options.hubConfigPath,
      apiUrl: options.localApiUrl ?? "https://localhost:8443",
    });
  return app;
}
