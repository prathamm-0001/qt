export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export type FlowStatus = "COMPLETED" | "FAILED" | "SKIPPED" | "WARNED";
export type Platform = "android" | "ios";

export interface Flow {
  index: number;
  name: string;
  status: FlowStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  error: string | null;
  screenshot?: string | null;
}

export function shotUrl(runId: string, file: string): string {
  return `${BACKEND_URL}/api/runs/${runId}/shot/${file}`;
}

export interface RunSnapshot {
  id: string;
  platform?: Platform;
  status:
    | "queued"
    | "installing"
    | "testing"
    | "reporting"
    | "passed"
    | "failed"
    | "error";
  apkName: string;
  by?: string | null;
  serial: string | null;
  /** The emulator/simulator the run used; `launched` = booted for this run. */
  device?: { serial: string; name: string | null; launched: boolean } | null;
  /** Parallel mode: every device the suite is split across (first = primary). */
  devices?: { serial: string; name: string | null; launched: boolean }[];
  /** Flows running right now (one per device in parallel mode). */
  currentFlows?: string[];
  startedAt: number;
  endedAt: number | null;
  flows: Flow[];
  plan: string[];
  current: { name: string; depth: number } | null;
  hasReport: boolean;
  error: string | null;
}

/** The session currently occupying the Mac (only one runs at a time). */
export interface ActiveSession {
  id: string;
  platform: Platform;
  apkName: string;
  by: string | null;
  status: RunSnapshot["status"];
  startedAt: number;
  done: number;
  total: number;
  current: string | null;
}

export interface Health {
  ok: boolean;
  platforms: {
    android: { device: string; online: boolean };
    // android.device: the running emulator's serial, or the AVD that will be
    // launched. ios.device: the booted simulator, or null (one gets booted).
    // shells: app versions whose DEVICE .ipa can run on the simulator
    ios: { device: string | null; booted: boolean; shells?: string[] };
  };
  active?: ActiveSession | null;
}

/** One row of the run history (GET /api/runs). */
export interface RunSummary {
  id: string;
  platform: Platform;
  apkName: string;
  by: string | null;
  status: RunSnapshot["status"];
  startedAt: number;
  endedAt: number | null;
  device: string | null;
  passed: number;
  failed: number;
  /** failed a step, but its target is visible on screen (OCR) - counts as working */
  visible?: number;
  done: number;
  total: number;
  hasReport: boolean;
  error: string | null;
}

/** Upload failed; `activeRunId` is set when a run on that device is already going. */
export class UploadError extends Error {
  constructor(
    message: string,
    public status: number,
    public activeRunId?: string,
  ) {
    super(message);
  }
}

/** The backend has no record of this run. */
export class RunGoneError extends Error {}

/**
 * Upload a build (.apk / .ipa / .app.zip) and start a run. Uses XHR rather than
 * fetch so large builds can report upload progress. Resolves to the runId.
 */
export function uploadBuild(
  file: File,
  by: string,
  onProgress: (loaded: number, total: number) => void,
): { promise: Promise<string>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<string>((resolve, reject) => {
    xhr.open("POST", `${BACKEND_URL}/api/runs`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300 && body.runId) {
        resolve(body.runId);
        return;
      }
      const msg =
        body.error ||
        (xhr.status === 413
          ? "File is too large for the tunnel (Cloudflare caps uploads at ~100 MB)."
          : `Upload failed (HTTP ${xhr.status}).`);
      reject(new UploadError(msg, xhr.status, body.activeRunId));
    };
    xhr.onerror = () =>
      reject(
        new UploadError(
          "Couldn't reach the test machine. Its tunnel may be restarting — " +
            "this page picks up the new address automatically; try again in a minute.",
          0,
        ),
      );
    xhr.onabort = () => reject(new UploadError("Upload cancelled.", 0));
    const fd = new FormData();
    if (by) fd.append("by", by); // text fields before the file so multer sees them
    fd.append("apk", file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function fetchRun(runId: string): Promise<RunSnapshot> {
  const res = await fetch(`${BACKEND_URL}/api/runs/${runId}`, {
    cache: "no-store",
  });
  if (res.status === 404) throw new RunGoneError("run not found");
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

/** All past and current runs, newest first. */
export async function fetchHistory(): Promise<RunSummary[]> {
  const res = await fetch(`${BACKEND_URL}/api/runs`, { cache: "no-store" });
  if (!res.ok) throw new Error(`history ${res.status}`);
  return res.json();
}

export async function fetchHealth(): Promise<Health> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/runs/${runId}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`cancel ${res.status}`);
}

export function reportUrl(runId: string): string {
  return `${BACKEND_URL}/api/runs/${runId}/report`;
}

export function streamUrl(runId: string): string {
  return `${BACKEND_URL}/api/runs/${runId}/stream`;
}
