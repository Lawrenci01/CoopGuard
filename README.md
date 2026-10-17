# CoopGuard

Offline-first poultry-house monitoring and climate-control pilot. This is one Git repository with four components:

| Folder      | Responsibility                                                                   |
| ----------- | -------------------------------------------------------------------------------- |
| `frontend/` | React Native mobile app                                                          |
| `backend/`  | Node.js/TypeScript hub API, CRUD, ordinary rules, local database, and cloud sync |
| `ai/`       | Python AI training, evaluation, and hub inference                                |
| `hardware/` | ESP32 node firmware and hub LoRa gateway                                         |

The components share one repository so changes to their interfaces can be reviewed together.

There is exactly one Git repository, rooted in this directory. Component folders are not separate
repositories. Clone once, create a feature branch from the root, and include coordinated app,
backend, hardware, AI, and documentation changes in the same pull request when appropriate.

## Collaborative development

Install both JavaScript applications from the repository root:

```powershell
npm run bootstrap
```

Run the standard verification suite before opening a pull request:

```powershell
npm run check
```

Useful component commands:

```powershell
npm run start:backend
npm run start:frontend
npm run test:backend
npm run test:frontend
npm run build:android
```

Dependencies and lockfiles remain component-local because Render deploys `backend/` independently
and the mobile toolchain builds from `frontend/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
branch, review, ownership, and secrets policy.

## Android mobile app

The native React Native/TypeScript app now has real shared username/password accounts, role-specific screens, offline cached records, inspection-note synchronization, automatic paired-hub/cloud selection, and a technician workflow from site survey through installation, commissioning, monitoring trial and activation. The Node.js/TypeScript backend is live on Render/Turso and has a Pi hub mode backed by a synchronized local database. Version 0.7 adds an authenticated telemetry boundary, normalized live reading history, replay protection, stale/invalid sensor alerts, and a JavaScript gateway simulator with an offline retry queue. Equipment responses, LoRa radio transport, and physical sensors remain simulated or unimplemented.

```powershell
npm run bootstrap
cd backend
npm run tls
cd ../frontend
$env:EXPO_PUBLIC_API_URL = 'https://YOUR-RENDER-SERVICE.onrender.com'
npm run build:android
```

Install `frontend/dist/android/CoopGuard.apk`, then sign in with a provisioned account. The team creates owners/technicians; owners create only workers. Render works through any internet connection; a commissioned hub works over farm WiFi without internet; a phone with neither uses bounded cached access. See the [frontend guide](frontend/README.md) for installation, roles, old-phone-record import and offline behavior. The simulator can exercise the live data path before physical nodes exist; equipment control, physical Pi/radio commissioning and AI inference still require their services.

## Working documents

- [Current plan](docs/CURRENT_PLAN.md) — current decisions, safety boundaries, pilot gates, and open items.
- [Accounts and roles](docs/ACCOUNTS_AND_ROLES.md) — authority, role screens, real credentials and offline session policy.
- [Edge AI and JavaScript replan](docs/EDGE_AI_REPLAN.md) — both AI tracks, data collection, recommended hub inference, and component language ownership.
- [End-to-end interface contract](docs/INTERFACE_CONTRACT.md) — how a reading, control action, alert, and remote request cross components.
- [Site survey checklist](docs/SITE_SURVEY_CHECKLIST.md) — information required before hardware and control decisions.
- [Pilot product claims](docs/PRODUCT_CLAIMS.md) — accurate wording for what the design can and cannot yet establish.
- [Decision-history snapshots](docs/reference/README.md) — copies of the earlier build docs, handoff, and flows for context.

The original v1.0 technical specification and problem/solution PDF are historical baselines. Their SMS/GSM, Pi-per-node, WiFi-mesh, and outage-related claims are not the current design.
