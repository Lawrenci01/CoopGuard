# Contributing to CoopGuard

CoopGuard uses one Git repository for the mobile app, backend, AI work, hardware firmware, and
project documentation. Run Git commands from the repository root. Do not initialize `.git`
directories inside component folders.

## Repository areas

- `frontend/` — React Native mobile application
- `backend/` — Node.js API, laptop/Pi hub service, local database, and cloud synchronization
- `ai/` — model training, evaluation, and hub inference work
- `hardware/` — node firmware, radio gateway, and hardware integration
- `docs/` — current specifications, contracts, decisions, and clearly labeled historical references

## Development workflow

1. Pull the latest `main` branch.
2. Create a short-lived branch such as `feature/technician-scan` or `fix/hub-ingestion`.
3. Keep changes scoped, but update every affected component and contract in the same branch.
4. Run `npm run check` from the repository root.
5. Open a pull request into `main` and describe behavior, verification, deployment impact, and any
   remaining hardware or site-dependent assumptions.
6. Merge only after required checks and review pass.

Do not commit directly to `main` for normal feature work. Avoid long-lived component branches,
because they make cross-component contracts drift.

## Installation

```powershell
npm run bootstrap
```

This installs the backend and frontend from their committed lockfiles. Python and embedded tooling
remain component-specific and should be documented in their component README files as they mature.

## Required verification

```powershell
npm run check
```

The root command runs backend and frontend type checks, backend tests, frontend domain tests, and
frontend UI tests. Hardware-dependent checks should be documented in the pull request when they
cannot run in CI.

## Documentation and contracts

Commit `docs/` changes whenever behavior, roles, APIs, hardware boundaries, installation steps, or
deployment assumptions change. Current plans and interface contracts take precedence over files
under `docs/reference/`, which are retained as decision history.

## Secrets and generated files

Never commit `.env` files, passwords, API tokens, Turso credentials, private keys, signing keys,
local SQLite databases, backups, generated APK/AAB files, or files under `.local/`. Use the
committed component `.env.example` files for non-secret configuration names.
