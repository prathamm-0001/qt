"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  fetchHealth,
  fetchHistory,
  fetchRun,
  reportUrl,
  shotUrl,
  uploadBuild,
  RunGoneError,
  UploadError,
  type ActiveSession,
  type Flow,
  type Health,
  type Platform,
  type RunSnapshot,
  type RunSummary,
} from "@/lib/api";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  installing: "Installing build",
  testing: "Testing",
  reporting: "Building report",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
};

const dotChar: Record<string, string> = {
  COMPLETED: "✓",
  FAILED: "✕",
  SKIPPED: "–",
  WARNED: "!",
};

const PLATFORM_LABEL: Record<Platform, string> = { android: "Android", ios: "iOS" };

// Shorter status words for the narrow badge in the history list.
const HISTORY_LABEL: Record<string, string> = {
  ...STATUS_LABEL,
  installing: "Installing",
  testing: "Running",
  reporting: "Running",
};
const HISTORY_PAGE = 10;

// Cloudflare's free quick tunnel rejects request bodies above ~100 MB.
const TUNNEL_LIMIT_MB = 100;
const RUN_KEY = "qoneqt.runId";
const RELOAD_KEY = "qoneqt.lastAutoReload";
const NAME_KEY = "qoneqt.testerName";
const MY_RUNS_KEY = "qoneqt.myRuns";

// Runs started from this browser - only their owner gets the "Stop run" button,
// so testers watching someone else's session can't stop it by accident.
function myRuns(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MY_RUNS_KEY) || "[]");
  } catch {
    return [];
  }
}
function addMyRun(id: string) {
  try {
    localStorage.setItem(MY_RUNS_KEY, JSON.stringify([id, ...myRuns()].slice(0, 20)));
  } catch {}
}

// Rough time left for a session, from its average flow duration so far.
function etaMs(s: { startedAt: number; done: number; total: number }, now: number) {
  if (!s.done || !s.total || s.done >= s.total) return null;
  return ((now - s.startedAt) / s.done) * (s.total - s.done);
}

function platformOf(name: string): Platform | null {
  const n = name.toLowerCase();
  if (n.endsWith(".apk")) return "android";
  if (/\.(ipa|zip|tar\.gz|tgz)$/.test(n)) return "ios";
  return null;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + " MB";

function fmtDur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtWhen(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// The active run id lives in the URL (?run=) and localStorage so a refresh or
// a shared link reopens the live run instead of losing it.
function rememberRun(id: string | null) {
  try {
    if (id) localStorage.setItem(RUN_KEY, id);
    else localStorage.removeItem(RUN_KEY);
  } catch {}
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("run", id);
    else url.searchParams.delete("run");
    window.history.replaceState(null, "", url);
  } catch {}
}
function recalledRun(): string | null {
  try {
    const q = new URLSearchParams(window.location.search).get("run");
    if (q) return q;
  } catch {}
  try {
    return localStorage.getItem(RUN_KEY);
  } catch {
    return null;
  }
}

// Polls /api/health. `online` is null until the first answer.
function useHealth(pauseReload: () => boolean) {
  const [health, setHealth] = useState<Health | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let stop = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    const tick = async () => {
      try {
        const h = await fetchHealth();
        if (stop) return;
        setHealth(h);
        setOnline(true);
        fails = 0;
        busy = !!h.active;
      } catch {
        if (stop) return;
        fails += 1;
        if (fails >= 2) setOnline(false);
        // The tunnel URL changes when the Mac restarts it, and the site is
        // redeployed with the new one. Reload (at most every 2 min) to pick
        // up that redeploy instead of staying stuck on a dead address.
        if (fails >= 4 && !pauseReload()) {
          try {
            const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
            if (Date.now() - last > 120_000) {
              sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
              window.location.reload();
              return;
            }
          } catch {}
        }
      }
      // Poll faster while someone's session is running so waiting testers see
      // the Mac free up promptly.
      if (!stop) timer = setTimeout(tick, fails || busy ? 5000 : 15000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pauseReload]);
  return { health, online };
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [pageDrag, setPageDrag] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [lost, setLost] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    loaded: number;
    total: number;
    startedAt: number;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [name, setName] = useState("");
  const [mine, setMine] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [history, setHistory] = useState<RunSummary[] | null>(null);
  const [histFilter, setHistFilter] = useState<"all" | Platform>("all");
  const [histAll, setHistAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<{ abort: () => void } | null>(null);

  const uploading = progress !== null;
  const pauseReload = useCallback(() => uploadRef.current !== null, []);
  const { health, online } = useHealth(pauseReload);

  const terminal =
    run?.status === "passed" || run?.status === "failed" || run?.status === "error";
  const platform = file ? platformOf(file.name) : null;
  // Someone else's session occupying the Mac (only one runs at a time).
  const active: ActiveSession | null = health?.active ?? null;
  const othersSession = active && active.id !== runId ? active : null;

  // Reopen a run from ?run= / localStorage on load; restore the tester name.
  useEffect(() => {
    const id = recalledRun();
    if (id) {
      setRunId(id);
      setMine(myRuns().includes(id));
    }
    try {
      setName(localStorage.getItem(NAME_KEY) || "");
    } catch {}
  }, []);

  const pickFile = useCallback((f: File | null | undefined) => {
    setUploadErr(null);
    setConflictId(null);
    if (!f) return;
    if (!platformOf(f.name)) {
      setFile(null);
      setFileErr(
        `"${f.name}" isn't a supported build. Use an .apk for Android, or an ` +
          `.ipa / .app.zip (simulator build) for iOS.`,
      );
      return;
    }
    setFileErr(null);
    setFile(f);
  }, []);

  // Accept a drop anywhere on the page, not just on the drop zone.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setPageDrag(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setPageDrag(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // never let the browser navigate to the file
      depth = 0;
      setPageDrag(false);
      setOver(false);
      if (!runId && !uploadRef.current) pickFile(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [runId, pickFile]);

  const openRun = useCallback((id: string) => {
    setRun(null);
    setLost(false);
    setRunId(id);
    setMine(myRuns().includes(id));
    rememberRun(id);
  }, []);

  const start = useCallback(async () => {
    if (!file || !platform || uploadRef.current) return;
    setUploadErr(null);
    setConflictId(null);
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {}
    setProgress({ loaded: 0, total: file.size, startedAt: Date.now() });
    const up = uploadBuild(file, name.trim(), (loaded, total) =>
      setProgress((p) => (p ? { ...p, loaded, total } : p)),
    );
    uploadRef.current = up;
    try {
      const id = await up.promise;
      addMyRun(id);
      openRun(id);
    } catch (e: any) {
      if (e instanceof UploadError && e.activeRunId) setConflictId(e.activeRunId);
      setUploadErr(e.message);
    } finally {
      uploadRef.current = null;
      setProgress(null);
    }
  }, [file, platform, name, openRun]);

  // Poll the snapshot endpoint once we have a runId.
  //
  // We poll rather than use SSE because the Cloudflare quick tunnel buffers
  // text/event-stream responses (the browser's EventSource never receives
  // events through it), which left the UI stuck on "Queued". Plain snapshot
  // GETs go through the tunnel fine and carry everything the UI needs.
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const snap = await fetchRun(runId);
        if (stop) return;
        setRun(snap);
        if (
          snap.status === "passed" ||
          snap.status === "failed" ||
          snap.status === "error"
        )
          return; // terminal - stop polling
      } catch (e) {
        if (stop) return;
        if (e instanceof RunGoneError) {
          setLost(true);
          return;
        }
        // transient (network blip / tunnel restarting) - keep polling
      }
      if (!stop) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 300);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runId]);

  // Load the run history on the home screen; reload it whenever a session
  // starts, makes progress or finishes (seen via the health poll).
  const activeKey = active ? `${active.id}:${active.status}:${active.done}` : "";
  useEffect(() => {
    if (runId || !online) return;
    let stop = false;
    fetchHistory()
      .then((h) => !stop && setHistory(h))
      .catch(() => {}); // keep showing the last list; the next change retries
    return () => {
      stop = true;
    };
  }, [runId, online, activeKey]);

  // Tick the elapsed-time clock while something is in flight.
  const ticking = uploading || (!!runId && !terminal) || !!othersSession;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const reset = () => {
    rememberRun(null);
    setRunId(null);
    setRun(null);
    setLost(false);
    setFile(null);
    setFileErr(null);
    setUploadErr(null);
    setConflictId(null);
    setCancelling(false);
  };

  const cancel = async () => {
    if (!runId || !confirm("Stop this test run?")) return;
    setCancelling(true);
    try {
      await cancelRun(runId);
      setRun(await fetchRun(runId));
    } catch {
      // the next poll will reflect whatever state the backend ended up in
    } finally {
      setCancelling(false);
    }
  };

  const flows: Flow[] = run?.flows ?? [];
  const plan: string[] = run?.plan ?? [];
  const current = run?.current?.name ?? null;
  const passed = flows.filter((f) => f.status === "COMPLETED").length;
  const failed = flows.filter((f) => f.status === "FAILED").length;
  const visibleOnly = flows.filter((f) => f.status === "WARNED").length;
  const total = plan.length || flows.length;
  const pct = total ? Math.round((flows.length / total) * 100) : 0;
  const byName = new Map(flows.map((f) => [f.name, f]));

  // Merge the planned flow list with results so pending flows are visible too.
  type Row = { name: string; flow: Flow | null; running: boolean };
  const rows: Row[] =
    plan.length > 0
      ? plan.map((name) => ({
          name,
          flow: byName.get(name) ?? null,
          running:
            !terminal &&
            !byName.has(name) &&
            (run?.currentFlows?.includes(name) || current === name),
        }))
      : [...flows]
          .sort((a, b) => a.index - b.index)
          .map((f) => ({ name: f.name, flow: f, running: false }));

  const runPlatform = run?.platform ?? (run ? platformOf(run.apkName) : null);
  const deviceReady = (p: Platform) =>
    p === "android"
      ? health?.platforms.android.online
      : health?.platforms.ios.booted;

  const upPct = progress ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const upSecs = progress ? (now - progress.startedAt) / 1000 : 0;
  const upRate = progress && upSecs > 0.5 ? progress.loaded / upSecs : 0;
  const upEta =
    upRate > 0 && progress ? (progress.total - progress.loaded) / upRate : null;

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Qoneqt Test Runner</h1>
          <p className="sub">
            Drop an Android or iOS build — it installs on the Mac Mini and every
            Maestro flow runs live below, with an Excel report at the end.
          </p>
        </div>
        <div className="health" aria-live="polite">
          <span className={`pill ${online === null ? "unk" : online ? "on" : "off"}`}>
            <i className="led" />
            {online === null ? "Connecting…" : online ? "Test machine online" : "Test machine offline"}
          </span>
          {online && health && (
            <>
              <span
                className={`pill ${health.platforms.android.online ? "on" : "idle"}`}
                title={
                  health.platforms.android.online
                    ? `Running: ${health.platforms.android.device}`
                    : `No emulator running — ${health.platforms.android.device} is launched when a run starts`
                }
              >
                <i className="led" />
                Android {health.platforms.android.online ? "ready" : "asleep"}
              </span>
              <span
                className={`pill ${health.platforms.ios.booted ? "on" : "idle"}`}
                title={
                  health.platforms.ios.device
                    ? `Running: ${health.platforms.ios.device}`
                    : "No simulator running — one is booted when a run starts"
                }
              >
                <i className="led" />
                iOS {health.platforms.ios.booted ? "ready" : "asleep"}
              </span>
            </>
          )}
        </div>
      </header>

      {online === false && (
        <div className="banner">
          <span className="spinner" />
          <div>
            <b>Can&apos;t reach the test machine.</b> Its tunnel is probably
            restarting — the site is redeployed with the new address
            automatically, and this page reloads itself to pick it up.
          </div>
          <button className="ghost small" onClick={() => window.location.reload()}>
            Reload now
          </button>
        </div>
      )}

      {!runId && othersSession && (
        <div className="busy-card">
          <div className="busy-head">
            <span className="spinner" />
            <b>The test Mac is busy</b>
            <span className={`plat ${othersSession.platform}`}>
              {PLATFORM_LABEL[othersSession.platform]}
            </span>
          </div>
          <div className="busy-body">
            <span className="busy-file" title={othersSession.apkName}>
              {othersSession.apkName}
            </span>
            {othersSession.by && <> · started by <b>{othersSession.by}</b></>}
            {" · "}running for {fmtDur(now - othersSession.startedAt)}
          </div>
          {othersSession.total > 0 && (
            <>
              <div className="bar">
                <span
                  style={{
                    width: `${Math.round((othersSession.done / othersSession.total) * 100)}%`,
                  }}
                />
              </div>
              <div className="upmeta">
                <span>
                  {othersSession.done} / {othersSession.total} flows
                  {othersSession.current && <> · now: {othersSession.current}</>}
                </span>
                {etaMs(othersSession, now) !== null && (
                  <span>~{fmtDur(etaMs(othersSession, now)!)} left</span>
                )}
              </div>
            </>
          )}
          <div className="busy-foot">
            <span>
              Only one session runs at a time. You can pick your build now — the
              button unlocks automatically when the Mac is free.
            </span>
            <button className="ghost small" onClick={() => openRun(othersSession.id)}>
              Watch live →
            </button>
          </div>
        </div>
      )}

      {!runId && (
        <div className="card">
          <div
            className={`drop${over || pageDrag ? " over" : ""}${file ? " has-file" : ""}${
              uploading ? " busy" : ""
            }`}
            role="button"
            tabIndex={0}
            aria-label="Choose a build to upload"
            onClick={() => !uploading && inputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !uploading) {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragEnter={() => setOver(true)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".apk,.ipa,.zip,.gz,.tgz"
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = ""; // allow re-picking the same file
              }}
            />

            {!file ? (
              <>
                <svg className="drop-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <div className="drop-title">
                  {over || pageDrag ? "Release to add the build" : "Drop a build here"}
                </div>
                <div className="drop-hint">
                  or <u>browse</u> · <b>.apk</b> for Android · <b>.ipa / .app.zip</b>{" "}
                  (simulator build) for iOS
                </div>
              </>
            ) : (
              <div className="filecard" onClick={(e) => e.stopPropagation()}>
                <span className={`plat ${platform}`}>{platform && PLATFORM_LABEL[platform]}</span>
                <div className="filemeta">
                  <div className="fname" title={file.name}>
                    {file.name}
                  </div>
                  <div className="fsize">
                    {mb(file.size)}
                    {platform && !uploading && (
                      <>
                        {" · "}
                        {deviceReady(platform)
                          ? `${platform === "android" ? "emulator" : "simulator"} ready`
                          : `${platform === "android" ? "emulator" : "simulator"} will be booted first (~1 min)`}
                      </>
                    )}
                  </div>
                </div>
                {!uploading && (
                  <button
                    className="x"
                    aria-label="Remove file"
                    title="Remove file"
                    onClick={() => setFile(null)}
                  >
                    ×
                  </button>
                )}
              </div>
            )}

            {uploading && (
              <div className="upload" onClick={(e) => e.stopPropagation()}>
                <div className="bar">
                  <span style={{ width: `${upPct}%` }} />
                </div>
                <div className="upmeta">
                  <span>
                    {upPct < 100
                      ? `Uploading… ${upPct}% · ${mb(progress!.loaded)} of ${mb(progress!.total)}`
                      : "Upload complete — starting the run…"}
                  </span>
                  {upPct < 100 && upRate > 0 && (
                    <span>
                      {mb(upRate)}/s{upEta !== null && ` · ${fmtDur(upEta * 1000)} left`}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {file && platform === "ios" && !uploading && (
            <div className="note">
              A <b>simulator</b> build (.app.zip) always works. A device .ipa
              works for app versions the test Mac has a simulator shell for
              {health?.platforms.ios.shells?.length ? (
                <>
                  {" "}
                  (<b>{health.platforms.ios.shells.join(", ")}</b>)
                </>
              ) : (
                " (none yet)"
              )}
              ; other versions are rejected.
            </div>
          )}
          {file && file.size > TUNNEL_LIMIT_MB * 1024 * 1024 && !uploading && (
            <div className="warn">
              This file is over {TUNNEL_LIMIT_MB} MB. The free Cloudflare tunnel
              usually rejects uploads that large.
            </div>
          )}
          {fileErr && <div className="error">{fileErr}</div>}

          <div className="actions">
            <input
              className="name"
              type="text"
              placeholder="Your name (optional)"
              aria-label="Your name"
              maxLength={40}
              value={name}
              disabled={uploading}
              onChange={(e) => setName(e.target.value)}
            />
            {!uploading ? (
              <button
                className="primary"
                disabled={!file || !platform || online === false || !!othersSession}
                onClick={start}
              >
                {othersSession
                  ? "Waiting for the current session…"
                  : platform
                    ? `Upload & run ${PLATFORM_LABEL[platform]} tests`
                    : "Upload & run tests"}
              </button>
            ) : (
              <button className="ghost" onClick={() => uploadRef.current?.abort()}>
                Cancel upload
              </button>
            )}
          </div>

          {uploadErr && (
            <div className="error">
              {uploadErr}
              {conflictId && (
                <>
                  {" "}
                  <button className="link" onClick={() => openRun(conflictId)}>
                    View the running test →
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!runId && history && (
        <HistoryCard
          runs={history}
          filter={histFilter}
          setFilter={setHistFilter}
          showAll={histAll}
          setShowAll={setHistAll}
          onOpen={openRun}
        />
      )}

      {runId && (
        <div className="card">
          <div className="statusbar">
            <span className={`badge ${lost ? "error" : run?.status ?? "queued"}`}>
              {lost ? "Unavailable" : STATUS_LABEL[run?.status ?? "queued"]}
            </span>
            {runPlatform && <span className={`plat ${runPlatform}`}>{PLATFORM_LABEL[runPlatform]}</span>}
            {run?.apkName && (
              <span className="runfile" title={run.apkName}>
                {run.apkName}
                {run.by && <> · by {run.by}</>}
              </span>
            )}
            {run && (
              <span className="elapsed">
                {fmtDur((run.endedAt ?? now) - run.startedAt)}
              </span>
            )}
          </div>
          {run && (
            <div className="runmeta">
              Started {fmtWhen(run.startedAt)}
              {(run.devices?.length ?? 0) > 1 ? (
                <>
                  {` · ${run.devices!.length} devices in parallel: `}
                  {run.devices!.map((d) => d.name || d.serial).join(", ")}
                </>
              ) : (
                run.device && (
                  <>
                    {" · on "}
                    {run.device.name || run.device.serial}
                    {run.device.launched && " (booted for this run)"}
                  </>
                )
              )}
            </div>
          )}

          {lost ? (
            <div className="error">
              The test machine has no record of this run (it predates the run
              history). Upload the build again to start a fresh run.
            </div>
          ) : (
            <>
              <div className="progress">
                <div className="bar">
                  <span
                    className={failed ? "has-fail" : ""}
                    style={{ width: `${terminal ? 100 : pct}%` }}
                  />
                </div>
                <div className="counts">
                  <span className="c-pass">
                    <b>{passed}</b> passed
                  </span>
                  <span className="c-fail">
                    <b>{failed}</b> failed
                  </span>
                  {visibleOnly > 0 && (
                    <span
                      className="c-warn"
                      title="A step failed, but what it looked for is visible on screen (checked by OCR) - working, just hidden from accessibility"
                    >
                      <b>{visibleOnly}</b> works (visible)
                    </span>
                  )}
                  {total > 0 && (
                    <span>
                      <b>{flows.length}</b> / {total} done
                    </span>
                  )}
                </div>
              </div>

              {!terminal && (
                <div className="now">
                  <span className="spinner" />
                  <span className="now-text">
                    {current ? (
                      <>
                        Testing now: <b>{current}</b>
                      </>
                    ) : (
                      STATUS_LABEL[run?.status ?? "queued"] + "…"
                    )}
                  </span>
                  {mine && (
                    <button
                      className="ghost small danger"
                      onClick={cancel}
                      disabled={cancelling}
                    >
                      {cancelling ? "Stopping…" : "Stop run"}
                    </button>
                  )}
                </div>
              )}

              {run?.error && <div className="error">{run.error}</div>}

              <ul className="flows">
                {rows.map((row, i) => {
                  const f = row.flow;
                  return (
                    <li key={row.name + i} className={row.running ? "running" : ""}>
                      {f ? (
                        <span className={`dot ${f.status}`}>{dotChar[f.status]}</span>
                      ) : row.running ? (
                        <span className="spinner" style={{ margin: "1px 0" }} />
                      ) : (
                        <span className="dot pending">·</span>
                      )}
                      <span className="flowname">
                        {row.name}
                        {f?.error && <div className="flowerr">{f.error}</div>}
                      </span>
                      {f?.screenshot && (
                        <img
                          className="thumb"
                          src={shotUrl(runId, f.screenshot)}
                          alt={`screenshot of ${row.name}`}
                          onClick={() => setZoom(shotUrl(runId, f.screenshot!))}
                          title="Click to enlarge"
                        />
                      )}
                      {f && <span className="dur">{(f.durationMs / 1000).toFixed(1)}s</span>}
                    </li>
                  );
                })}
                {rows.length === 0 && (
                  <li>
                    <span className="sub" style={{ margin: 0 }}>
                      {run?.status === "installing"
                        ? "Installing the build on the device…"
                        : terminal
                          ? "No flows ran."
                          : "Waiting for the first flow…"}
                    </span>
                  </li>
                )}
              </ul>
            </>
          )}

          <div className="actions">
            {terminal && run?.hasReport && (
              <a className="download" href={reportUrl(runId)}>
                ⬇ Download Excel report
              </a>
            )}
            {(terminal || lost) && (
              <button className="ghost" onClick={reset}>
                Run another build
              </button>
            )}
            {!terminal && !lost && (
              // Leaving doesn't stop the run; the busy panel links back to it.
              <button className="ghost" onClick={reset}>
                ← Back
              </button>
            )}
          </div>
        </div>
      )}

      {pageDrag && !runId && !uploading && <div className="page-drop" aria-hidden="true" />}

      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="screenshot" />
          <div className="lightbox-hint">click anywhere to close</div>
        </div>
      )}
    </div>
  );
}

function HistoryCard({
  runs,
  filter,
  setFilter,
  showAll,
  setShowAll,
  onOpen,
}: {
  runs: RunSummary[];
  filter: "all" | Platform;
  setFilter: (f: "all" | Platform) => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const filtered = filter === "all" ? runs : runs.filter((r) => r.platform === filter);
  const shown = showAll ? filtered : filtered.slice(0, HISTORY_PAGE);
  const filters: ["all" | Platform, string][] = [
    ["all", "All"],
    ["android", "Android"],
    ["ios", "iOS"],
  ];
  return (
    <div className="card">
      <div className="hist-head">
        <h2>
          Test history <span className="count">{filtered.length}</span>
        </h2>
        <div className="seg" role="group" aria-label="Filter by platform">
          {filters.map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? "on" : ""}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="hist-empty">
          No {filter === "all" ? "" : PLATFORM_LABEL[filter] + " "}runs yet. Every
          run started here is saved to this list.
        </div>
      ) : (
        <ul className="hist">
          {shown.map((r) => {
            const finished = r.status === "passed" || r.status === "failed" || r.status === "error";
            return (
              <li key={r.id}>
                <button className="hist-row" onClick={() => onOpen(r.id)} title="Open this run">
                  <span className={`badge ${r.status}`}>{HISTORY_LABEL[r.status] ?? r.status}</span>
                  <span className={`plat ${r.platform}`}>{PLATFORM_LABEL[r.platform]}</span>
                  <span className="hist-main">
                    <span className="hist-file">{r.apkName}</span>
                    <span className="hist-meta">
                      {fmtWhen(r.startedAt)}
                      {r.endedAt && <> · {fmtDur(r.endedAt - r.startedAt)}</>}
                      {r.device && <> · {r.device}</>}
                      {r.by && <> · by {r.by}</>}
                    </span>
                  </span>
                  <span className="hist-score">
                    {r.total === 0 ? (
                      finished ? "no flows ran" : ""
                    ) : finished ? (
                      <>
                        <b className="p">{r.passed}</b> passed
                        {r.failed > 0 && (
                          <>
                            {" · "}
                            <b className="f">{r.failed}</b> failed
                          </>
                        )}
                        {(r.visible ?? 0) > 0 && (
                          <>
                            {" · "}
                            <b className="w">{r.visible}</b> visible
                          </>
                        )}
                      </>
                    ) : (
                      `${r.done} / ${r.total} done`
                    )}
                  </span>
                </button>
                {r.hasReport && (
                  <a className="hist-xlsx" href={reportUrl(r.id)} title="Download Excel report">
                    ⬇ Excel
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {filtered.length > HISTORY_PAGE && (
        <div className="actions">
          <button className="ghost small" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show all ${filtered.length} runs`}
          </button>
        </div>
      )}
    </div>
  );
}
