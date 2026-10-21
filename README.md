# Qoneqt Test Runner

Upload an Android APK from a web UI, have it installed and tested with Maestro
on a Mac Mini, watch every flow's status live, and download an Excel report.

```
 Vercel (Next.js frontend)                Mac Mini
 ┌────────────────────────┐   Cloudflare  ┌──────────────────────────────┐
 │ upload .apk            ─┼── tunnel ───▶ │ Express backend (:4000)      │
 │ live step-by-step view ◀┼── SSE ──────  │  ├─ adb install <apk>        │
 │ download .xlsx         ◀┼── file ─────  │  ├─ maestro test index.yml   │
 └────────────────────────┘               │  ├─ stream each step (SSE)    │
                                           │  └─ exceljs → report.xlsx     │
                                           │  Android emulator (adb)      │
                                           └──────────────────────────────┘
```

## Prerequisites (Mac Mini)

- Node 18+
- `adb` on PATH with the emulator/device running (`adb devices`)
- Maestro installed (`~/.maestro/bin/maestro`)
- The Qoneqt app repo present (its `tests/android/index.yml` is what runs)
- Metro running for Debug builds (`npx expo start` in the app repo)
- `cloudflared` for the tunnel: `brew install cloudflared`

## Backend (Mac Mini)

```bash
cd backend
cp .env.example .env        # edit paths/device if needed
npm install
npm start                   # http://localhost:4000
npm run tunnel              # in another terminal → prints the public https URL
```

## Frontend (local dev, then Vercel)

```bash
cd frontend
cp .env.local.example .env.local     # set NEXT_PUBLIC_BACKEND_URL
npm install
npm run dev                          # http://localhost:3000
```

Deploy the `frontend/` folder to Vercel. Set the env var
`NEXT_PUBLIC_BACKEND_URL` to the Cloudflare tunnel URL, and add that same URL to
the backend's `CORS_ORIGIN` (in `.env`), then restart the backend.

## Flow

1. Open the frontend, drop in an `.apk`, click **Upload & run tests**.
2. Backend picks a device: it reuses an emulator/simulator that is already
   running (preferring `ANDROID_SERIAL` / `IOS_UDID`), and only if none is
   running does it launch one (`ANDROID_AVD`, or boot `IOS_UDID` / the newest
   iPhone simulator — creating a new iPhone simulator if none exists). iOS
   simulators are opened in Simulator.app so the run can be watched, and are
   brought up before the build is checked. Then it uninstalls the old build,
   installs the new one, and runs Maestro.
3. The UI shows each flow turning green/red and highlights the step in progress.
4. When finished, click **Download Excel report**.
5. Every run is listed under **Test history** on the home page — open one to
   see its flows, errors and screenshots again, or download its Excel report.

## Run modes

Set `RUN_MODE` in the backend `.env`:

- **`cof` (default) — continue-on-failure.** Runs `_login.yml` first to log in,
  then each flow listed in `index.yml` as its **own** Maestro process, continuing
  past failures. Every flow runs, the Excel covers all of them, and the UI shows
  the full checklist up front (pending → running → pass/fail) with live per-step
  detail for the flow in progress.
- **`chained` — the raw index.** Runs `tests/android/index.yml` as one flow;
  Maestro aborts on the first failed `runFlow`, so later flows won't run.

The flow list is read automatically from `index.yml`'s `runFlow: file:` entries,
so adding a flow there is enough — no runner change needed.

## Notes / limits

- **APK size through a Cloudflare free tunnel**: requests are capped (~100 MB).
  Larger APKs need a paid tunnel or a direct upload path.
- One run at a time per device is assumed (a single shared emulator).
- Run history is saved as one JSON file per run in `backend/history/` and
  reloaded on start. A run that was still going when the backend stopped is
  marked as an error. Excel reports are kept forever; screenshot folders are
  pruned after 30 days (`scripts/auto-tunnel-deploy.sh`). Reports from before
  history existed can be imported with `node scripts/import-reports.js`.
- **iOS device .ipa uploads** can't launch on the simulator, so the backend
  runs them on a prebuilt *simulator shell* of the same app version: it copies
  the .ipa's compiled JavaScript (`main.jsbundle` + `assets/`) into the shell
  and signs it like Xcode does. Shells live in `backend/sim-shells/`; make one
  for a new app version with `bash backend/scripts/make-sim-shell.sh` from that
  version's source. Face detection (GoogleMLKit) is left out of shells.
- iOS is intentionally not wired up here (its simulator build is currently
  blocked by GoogleMLKit's missing arm64-simulator slice — see the app repo).
# qt
