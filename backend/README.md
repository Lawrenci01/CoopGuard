# CoopGuard backend

Implemented **Node.js + TypeScript, Fastify and SQLite-compatible storage** service for real shared accounts and farm records. Version 0.7.0 uses Turso on Render Free, assigns each farm a unique Farm ID, stores the simulated QR device workflow, and supports a Pi hub with a local Turso Sync replica. The hub reads and writes locally during an outage, then pushes and pulls changes when internet returns. Authenticated telemetry ingestion, normalized sensor history, replay protection, stale/invalid sensor alerts, and latest/history APIs are implemented. Physical sensors, LoRa transport, equipment responses and virtual device heartbeats remain simulated or unimplemented.

## Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Lawrenci01/CoopGuard_Backend)

The repository-root [`render.yaml`](render.yaml) defines one Singapore-region **free** Node web service with Render-managed public HTTPS. Render's free filesystem is temporary, so persistent accounts and farm records are stored in a separate Turso database on its free plan. Render terminates public TLS, forwards HTTP to the process, supplies `PORT`, and is trusted as the application proxy.

1. Create a free Turso account and one database. In its **Connect** page, copy the database URL and create a database token. Never commit or send the token in chat.
2. In the Render service's **Environment** page, add `TURSO_DATABASE_URL` and secret `TURSO_AUTH_TOKEN`. Remove the old `CG_DB_PATH=/var/data/coopguard.sqlite` variable.
3. Keep Render **Compute** on Free. Use `npm ci && npm run typecheck` as the build command and `npm start` as the start command.
4. Redeploy and wait for `https://<service>.onrender.com/health` to return the CoopGuard service response.
5. Render Free has no Shell. Provision the first farm from a private PowerShell window on a trusted developer PC, using the same Turso credentials:

```powershell
cd C:\Vault\Projects\CG\backend
$env:TURSO_DATABASE_URL="libsql://your-database-your-account.turso.io"
$env:TURSO_AUTH_TOKEN="paste-your-private-database-token"
npm ci
npm run provision -- --require-cloud --admin team.admin --output .local/render-admin-account.txt
npm run provision -- --require-cloud --farm "Pilot farm" --owner cg.owner --technician cg.technician --output .local/render-initial-accounts.txt
Remove-Item Env:TURSO_DATABASE_URL
Remove-Item Env:TURSO_AUTH_TOKEN
```

Save the generated temporary credentials securely, sign in and change every temporary password. Delete the private output files after the credentials have been transferred. The backend never creates an administrator with a fixed password.

If an earlier development build created `team.admin` with the retired fixed password, the current backend disables that account and revokes its sessions during startup. Reactivate it with a new random temporary password:

```powershell
npm run provision -- --require-cloud --reset-user team.admin --output .local/render-admin-reset.txt
```

To replace every account assigned to an existing pilot farm while preserving its survey and farm records, run the private prompt helper:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reprovision-render.ps1 -DatabaseUrl "libsql://your-database-your-account.turso.io"
```

The helper asks for the Turso token with hidden input and writes fresh temporary passwords only to a timestamped private file under `.local`. If Turso is empty, it creates the initial cloud farm and accounts. If that farm exists, it replaces its owner account while preserving the shared technician and farm records. It refuses to create a second farm when a different farm already exists. It defaults to farm `CoopGuard pilot farm` and usernames `cg.owner` / `cg.technician`; pass `-Farm`, `-Owner`, or `-Technician` to change them. The underlying CLI requires the farm name after `--confirm` as its destructive-action safeguard.

Render Free sleeps after inactivity, so the first request can be slow while it wakes. Turso keeps the database durable across Render restarts and redeploys. Both free services have usage and availability limits and are suitable for development and an early pilot, not a commercial uptime commitment.

## Start on this PC

The server has already been provisioned under `.local/`. Start it after a PC restart:

```powershell
cd C:\Vault\Projects\CG\backend
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-pc.ps1
```

The helper starts Node in the background, stores a PID and redirects logs to `.local/server.out.log` / `server.err.log`. `npm start` instead runs in the current terminal. Keep the PC awake. The phone must use the laptop's current Wi-Fi IPv4 address, such as **`https://192.168.x.x:8443`**; do not reuse an address from a previous network.

The connected Redmi successfully reached this PC's port 8443 over WiFi using the existing network policy. Windows denied adding an explicit firewall rule without administrator rights, so none was added. If another phone cannot connect, run this once in **Administrator PowerShell**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Vault\Projects\CG\backend\scripts\allow-local-network.ps1
```

The rule allows TCP 8443 only from the local subnet on Private networks. It does not open router/internet forwarding. Phones must be on the same network without client isolation. USB testing can use `adb reverse tcp:8443 tcp:8443` and the app address `https://localhost:8443`.

## Pi hub local and online mode

The same backend runs on the Pi with a local synchronized database. Commission it once while the Pi has internet:

```powershell
$env:CG_MODE="hub"
$env:CG_HUB_ID="pilot-house-1"
$env:CG_DB_PATH=".local/hub.sqlite"
$env:TURSO_DATABASE_URL="libsql://your-database-your-account.turso.io"
$env:TURSO_AUTH_TOKEN="paste-your-private-database-token"
npm start
```

The first start downloads the cloud database and therefore requires internet. Later starts use the commissioned local database when the internet is unavailable. The hub attempts push then pull every 30 seconds by default. LoRa remains the node-to-hub network; the Android app reaches the hub over farm WiFi. Use a hub certificate signed by the CoopGuard CA included in the APK.

Each Pi has its own hub ID, HTTPS address and local database replica. Hubs configured with the same Turso URL synchronize the same shared database; accounts and farms are not isolated into a separate database per hub. The Pi keeps a local copy of those records for WiFi access during an internet outage, then synchronizes changes when connectivity returns. LoRa devices connect to their own nearby hub, while account access is controlled by each user's farm membership. The team admin is global and has no farm membership.

The technician pairs the hub's HTTPS address once in the app. After that, the app probes both endpoints using the same opaque session token, prefers the hub while it is reachable, uses Render on any internet connection when the hub is absent, and displays cached phone data if neither can be reached.

## Temporary online access without Render

The pilot can expose this PC through an outbound Cloudflare Quick Tunnel without router port forwarding:

```powershell
cd C:\Vault\Projects\CG\backend
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-cloudflared.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-online.ps1
```

The second command starts the backend if needed, verifies the public `/health` endpoint and saves the HTTPS address in `.local/public-url.txt`. This fallback now requires an internal build whose `EXPO_PUBLIC_API_URL` points to that tunnel. Normal pilot builds use the fixed Render URL. The phone can then use any internet-connected WiFi or mobile-data network. Public-host requests are classified as remote/cloud; private `localhost`, `.local`, `10.x`, `172.16-31.x` and `192.168.x` hosts remain on-farm connections. The server enforces that distinction as well as the UI.

Keep the PC awake and both background processes running. Stop only the public route with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-online.ps1
```

A Quick Tunnel is only a development fallback: its hostname changes whenever the tunnel is recreated and it has no uptime guarantee. The SQLite database on this PC remains authoritative while this fallback is used.

## First setup on another developer PC

Requires Node.js 24 (tested on 24.13.0; its built-in `node:sqlite` emits an experimental warning) and OpenSSL. Windows defaults to Git's `C:\Program Files\Git\usr\bin\openssl.exe`; set `OPENSSL_PATH` if elsewhere.

```powershell
cd backend
npm ci
npm run tls
npm run provision -- --admin team.admin --output .local/admin-account.txt
npm run provision -- --farm "Pilot farm" --owner cg.owner --technician cg.technician --output .local/initial-accounts.txt
npm start
```

The CLI provisions the private team administrator separately, then provisions the farm, its owner and the shared technician. It generates unique temporary passwords into the named private files and requires a new file path each run. Protect `.local/` with account-specific OS permissions; on this PC it is restricted to Lawrence, SYSTEM and administrators. Never commit or distribute private keys, the database or credentials. Only `.local/tls/ca.crt`, the **public** CA certificate, goes into internal Android builds.

`npm run tls` creates a private CA once and renews the server certificate with localhost and current IPv4 addresses. It retains the CA; deleting/replacing it breaks trust in installed builds. Server certificates last one year; renew before expiry or after an IP change and restart the server. Android checks both trust and hostnames. The tunnel validates this private origin CA and provides a publicly trusted certificate to phones.

Optional environment variables: `CG_DB_PATH`, `CG_TLS_KEY`, `CG_TLS_CERT`, `CG_HTTPS` (set `false` only behind Render's trusted HTTPS proxy), `CG_TRUST_PROXY`, `CG_MODE`, `CG_HUB_ID`, `CG_SYNC_INTERVAL_MS`, `HOST` (default 0.0.0.0), and `PORT` (default 8443). `TURSO_DATABASE_URL` together with `TURSO_AUTH_TOKEN` selects Turso. `CG_MODE=hub` changes that connection into a local-first synchronized replica at `CG_DB_PATH`. The background helper is for the local default port. No password is embedded in app code.

## Account management

- No public signup. A team admin can use the admin-only mobile workspace to register a customer and farm, create its owner account, and receive the generated Farm ID, QR and temporary credentials. The shared technician and team admin are created only through the private operator CLI. The API rejects farm creation from all other roles.
- Team admins have no farm membership and use a separate administration workspace. Owners and workers are limited to farms with explicit membership; an owner created by the admin flow has exactly one farm.
- The one active technician account can access every registered farm. Farm IDs or QRs select a farm; they do not authenticate users. Technician authorization is based on the signed-in role rather than a membership row.
- Owners create **workers only** within their own farm, and can rename, disable/enable or reset them. They cannot create/edit owners or technicians.

To start with no farms while preserving only administrator accounts and `cg.technician`, first rotate any exposed Turso token and update Render, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reset-render-data.ps1 `
  -DatabaseUrl "libsql://your-database-your-account.turso.io"
```

Paste the new token only at the hidden prompt. The reset removes every farm and farm-bound record, deletes owner, worker and extra technician accounts, and revokes all sessions. It aborts unless both cloud credentials are present and the preserved technician and at least one administrator exist. After the deletion, it reactivates `team.admin` with a newly generated temporary password written to a private `.local` file.

- Workers cannot manage accounts, farm setup, flock cycles or sensors. Only technicians complete or change the site survey, approve the generated plan, record installation/commissioning checks, activate a verified operating mode and manage devices; owners manage flock cycles.
- All server requests validate active session, current role and farm membership. Strict schemas reject role injection and unsupported actions.
- Temporary passwords require a change before farm access. Minimum password length is 12 characters. Changing/resetting a password or disabling a worker revokes existing sessions.
- Owners reset workers in the app. The team resets an owner or technician on this PC:

```powershell
npm run provision -- --reset-user cg.owner --output .local/owner-reset.txt
```

Initial CLI provisioning creates the shared technician if one does not already exist. Later farm creation and reprovisioning reuse that account; if multiple active technician accounts exist, consolidate them before provisioning more farms. Owners remain farm-scoped.

Passwords use salted scrypt (`N=131072,r=8,p=1`, 64-byte output). At most two expensive password jobs run concurrently. Login limits apply by IP and normalized username. Random 32-byte opaque session tokens expire after seven days; only their SHA-256 digests are stored server-side. Responses avoid caching and credentials are not logged. These choices follow the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Records and offline operation

The selected backend database is authoritative: local SQLite for PC development, Turso for Render, or a Turso Sync local replica on the hub. Survey, generated plan, virtual hub/node records, installation, commissioning, flock, notes and sample device changes are shared across assigned accounts/phones. The API verifies that a newly created virtual device uses the selected farm's server-issued Farm ID. Version checks reject stale edits. Stable operation IDs deduplicate note and offline-survey retries. Notes carry server-assigned author identity; workers/technicians can edit only their own, and owners can manage notes in their farm.

First sign-in, password changes and server mutations require connectivity to this server; local WiFi is enough and internet is unnecessary. A phone retains a validated cached session for up to 24 hours since its last account check and within session expiry. Disabling an account is immediate on the server; a disconnected phone can retain cached access for that bounded period. Only new notes enter the offline outbox. Equipment requests never replay from it.

A technician may import an old anonymous phone record only before this farm's first change, then reviews it as part of the site survey. The source copy is preserved. Imported profile roles/commands do not grant privileges or execute equipment actions.

Local SQLite uses WAL, foreign keys and serialized farm mutations. Turso writes are sent through its authenticated HTTPS client and related records use atomic batches. Keep database tokens and backups private. A separate application-level export and restore workflow is still required before commercial operation.

## API and tests

| Routes                                                      | Purpose                                               |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `GET /health`                                               | Non-sensitive service/version check                   |
| `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/me` | Session lifecycle                                     |
| `POST /v1/auth/password`                                    | Current-password-verified change and session rotation |
| `POST /v1/admin/farms`                                      | Admin-only farm/customer and owner provisioning       |
| `GET /v1/admin/farms`                                       | Admin farm, hub, node and latest-reading overview     |
| `GET /v1/farms/:farmId`                                     | Authorized farm snapshot and revision                 |
| `GET /v1/farms/:farmId/devices`                             | Shared persistent hub/node inventory                  |
| `POST /v1/farms/:farmId/nodes`                              | Technician registers a node under the active hub      |
| `DELETE /v1/farms/:farmId/nodes/:nodeId`                    | Technician deactivates a node; history is retained    |
| `POST /v1/telemetry/ingest`                                 | Hub-authenticated versioned reading batch             |
| `GET /v1/farms/:farmId/telemetry/latest`                    | Latest normalized reading and node health             |
| `GET /v1/farms/:farmId/telemetry/history`                   | Bounded per-node metric history                       |
| `POST /v1/farms/:farmId/actions`                            | Validated, authorized record mutation                 |
| `POST /v1/farms/:farmId/import`                             | Technician's one-time legacy phone import             |
| `GET/POST /v1/farms/:farmId/workers`                        | Owner lists/creates workers                           |
| `PATCH /v1/farms/:farmId/workers/:id`                       | Owner renames/enables/disables a worker               |
| `POST /v1/farms/:farmId/workers/:id/password`               | Owner resets a worker password                        |

```powershell
npm run typecheck
npm test
```

Tests use Fastify injection and an isolated temporary SQLite database, including restart persistence, farm isolation, account creation restrictions, forced password change, reset/disable revocation, independent sessions, idempotent notes and stale edits. A separate live check on the development PC verified HTTPS certificate/hostname validation, independent login sessions and logout revocation.

The backend-owned state rules and API types live under `src/shared`; the repository has no build-time or runtime dependency on the mobile frontend. Changes to these contracts must also be reflected in the mobile repository until a separately versioned shared package is introduced.

Physical LoRa ingestion, local control-rule processing, node command acknowledgment, push delivery and Python model jobs remain unimplemented. The HTTP telemetry boundary is production-shaped but currently exercised by the JavaScript gateway simulator. Because site-specific alert thresholds are still an open safety decision, valid live values are labeled `Reading only`; the service generates technical stale/invalid/warm-up alerts without inventing poultry safety limits. Physical Pi commissioning and conflict testing under simultaneous offline/cloud edits are still required. Python runs bounded AI jobs without blocking API requests. Historical FastAPI backend instructions are superseded by the JavaScript backend decision.

## Telemetry simulator setup

### Laptop hub pilot

The laptop can now operate as the local hub with the same authenticated telemetry contract that
the Raspberry Pi will use later. It must use the same Turso database as Render so accounts, farms,
sessions, hubs, nodes, and readings are shared across cloud and local connections. In the same
PowerShell window, load the Render database credentials without saving the token in command history,
then create the one-time pairing QR:

```powershell
$env:TURSO_DATABASE_URL = "libsql://your-database-your-account.turso.io"
$secureToken = Read-Host "Turso auth token" -AsSecureString
$env:TURSO_AUTH_TOKEN = [System.Net.NetworkCredential]::new("", $secureToken).Password
npm run hotspot:start
npm run hub:create
npm run hub:start
```

`hotspot:start` creates and starts a private Windows Mobile Hotspot named `CoopGuard-Hub-*`,
stores its generated credentials only in `.local/hotspot-config.json`, discovers the hotspot's
private address, and renews the server certificate for that address. The QR contains those
credentials so Android can show its protected system WiFi join dialog and connect the app to the
laptop network before pairing. The user must approve that Android dialog; the app cannot silently
change WiFi. The helper also disables Windows' five-minute no-client timeout so the pairing network
stays available while the hub is running. Run the hotspot command once from Administrator PowerShell if it warns that the local
TCP 8443 firewall rule could not be installed.

If Windows Mobile Hotspot accepts WiFi authentication but never leases the phone a
`192.168.137.x` address, enable the scoped CoopGuard DHCP fallback once from Administrator
PowerShell:

```powershell
npm run hotspot:start -- -DhcpFallback
```

The setting is saved in the private hotspot configuration and reused by `hub:start`. The
fallback binds only to the hotspot's private IPv4 address, assigns leases only on that `/24`, and
stops with `hotspot:stop`; it does not listen on the laptop's upstream WiFi connection.

The first run requires internet and creates `.local/coopguard-hub-sync.sqlite`, a local synchronized
replica of the Render/Turso database. The older `.local/coopguard.sqlite` standalone-development
database is kept separate and is not used by the commissioned hub. `hub:create` and `hub:start`
refuse to run without both Turso settings so a second, isolated set of user or farm records cannot
be created accidentally. After the background hub inherits the credentials, remove them from the
interactive shell with `Remove-Item Env:TURSO_DATABASE_URL,Env:TURSO_AUTH_TOKEN`.

The command writes the private simulator identity to `.local/hub-config.json` and a scannable SVG
to `.local/hub-config.json.qr.svg`. On the technician interface, select Hub WiFi, scan the QR,
approve Android's connection prompt, and register it to the currently selected farm. Running
`npm run hub:create` again refreshes the expiring QR while preserving the same hub identity; use
`npm run hub:create -- --new-identity` only for an intentional hardware replacement. A farm permits
one active hub, so a genuinely different hub becomes a replacement request and remains inactive
until an administrator approves it. Hub registration intentionally creates no sensor nodes: the technician adds each uniquely
identified node from Device management after the hub is paired. The database is the source of
truth for this inventory; removing a node deactivates it without deleting its history.

After setup, the normal daily startup is:

```powershell
npm run hub:start
Start-Process "https://localhost:8443/developer"
```

`hub:start` restarts the saved CoopGuard hotspot automatically. Stop the backend with
`npm run hub:stop`; stop the laptop WiFi network separately with `npm run hotspot:stop`.

For USB access, keep the cable authorized and run:

```powershell
adb reverse tcp:8443 tcp:8443
```

Open `https://localhost:8443/developer` on the laptop to inspect the live SQLite row count and
size, farm/hub/node registration, earliest/latest history coverage, reading provenance, and latest
transmission. Once a claimed hub has at least one node, the backend automatically starts a single
one-minute simulator worker. On its first run for each node, that worker generates 183 days of
hourly readings and submits them through the same authenticated ingestion API used by hardware.
It uses a per-hub process lock and a durable spool, so frontend sessions cannot duplicate readings
and an interrupted upload resumes in order. The console can stop/restart the simulator, export
readings to CSV, and create checkpointed database backups.
It is restricted to loopback access and is disabled in cloud mode. A synchronized laptop hub uses
`.local/coopguard-hub-sync.sqlite`; set `CG_DB_PATH` before both `hub:create` and `hub:start` to use
a different durable replica location.

Every hub, node, and sensor reading has a `source` value of `simulated` or `hardware`. Current
dashboards and Trends are built from the same latest/history queries. Trends can show Today, 7 days,
or 30 days and can filter the whole-house average or a single node. The laptop
simulator reports the full standard five-sensor payload per node: temperature, relative humidity,
ammonia, carbon dioxide, and litter moisture. Therefore three installed nodes provide three litter
moisture measurement locations rather than three unrelated litter fields in one node.

The simulator is the replaceable transport boundary. A Raspberry Pi/LoRa gateway will use the
same private hub credentials, node inventory bootstrap, and `/v1/telemetry/ingest` schema, but send
`source: "hardware"`. Automated equipment control remains outside this monitoring-only pilot.

### Legacy virtual-device provisioning

The technician must first complete the site survey and pair the virtual hub and full-sensor nodes. Then create a one-time private hub configuration against the chosen database:

```powershell
npm run provision:telemetry -- --farm-code CG-PH-XXXXXXXX --output .local/pilot-gateway.json
```

Add `--require-cloud` after setting the Turso URL and token when provisioning the Render/Turso farm. The command stores only a digest of the generated hub secret. Run `hardware/gateway-simulator.mjs` from the monorepo to send one batch or continuous one-minute batches. Failed requests remain in a private spool beside the configuration and retry in order.
