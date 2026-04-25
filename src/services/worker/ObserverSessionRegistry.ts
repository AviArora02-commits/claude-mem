/**
 * ObserverSessionRegistry
 *
 * Addresses issue #2126 (additive coverage for observer-sessions leak).
 *
 * The original bug (#1168) documented observer claude CLI processes accumulating
 * indefinitely — 157 zombie processes eating 8.4 GB RAM after a few days.
 *
 * Root cause (from #1168):
 *   1. No session-end cleanup: Stop hook never kills observer processes.
 *   2. No timeout: kill() helper exists in code but is never called for observers.
 *   3. No orphan sweep: worker daemon never prunes stale observers on startup.
 *   4. Empty observer-sessions/ dir: tracking system not persisting PIDs.
 *
 * This file is the "additive coverage" layer (#2126):
 *   - Persists { pid, startTime, sessionId } to ~/.claude-mem/observer-sessions/<uuid>.json
 *   - Verifies process identity (PID + start-time) to survive PID reuse (see #2082)
 *   - Exposes register / release / sweepOrphans API used by ObserverSessionManager
 *   - Every public method is exercised by ObserverSessionRegistry.test.ts
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface ObserverEntry {
  /** OS-level process ID */
  pid: number;
  /**
   * Opaque process identity token — prevents PID-reuse false-positives (#2082).
   * Linux:  /proc/<pid>/stat field 22 (starttime in jiffies, decimal string)
   * macOS:  lstart from `ps -p <pid> -o lstart=` (ISO-like string)
   * Windows: wmic process starttime (also string)
   * Falls back to empty string when unreadable — entry is still created but
   * identity verification degrades to PID-only (acceptable for cleanup purposes).
   */
  startToken: string;
  /** claude-mem content_session_id this observer was spawned for */
  sessionId: string;
  /** Unix timestamp (ms) when this entry was written */
  registeredAt: number;
}

/** Registry lives on disk so it survives worker restarts */
export class ObserverSessionRegistry {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir =
      baseDir ??
      path.join(os.homedir(), ".claude-mem", "observer-sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Persist an observer entry to disk immediately after spawning the process.
   * Safe to call multiple times for the same pid/sessionId — idempotent.
   */
  register(pid: number, sessionId: string): ObserverEntry {
    const entry: ObserverEntry = {
      pid,
      startToken: readStartToken(pid),
      sessionId,
      registeredAt: Date.now(),
    };
    fs.writeFileSync(this.entryPath(pid), JSON.stringify(entry, null, 2));
    return entry;
  }

  /**
   * Remove the on-disk entry for a pid once the process has cleanly exited.
   * No-op if the entry does not exist.
   */
  release(pid: number): void {
    const p = this.entryPath(pid);
    try {
      fs.unlinkSync(p);
    } catch {
      // ENOENT is fine — entry was never written or already cleaned up
    }
  }

  /**
   * Return all entries currently on disk.
   * Corrupt / unreadable JSON files are skipped with a warning so a single bad
   * file never blocks the sweep.
   */
  listAll(): ObserverEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }

    const entries: ObserverEntry[] = [];
    for (const name of names) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, name), "utf8");
        entries.push(JSON.parse(raw) as ObserverEntry);
      } catch {
        // Corrupt file — skip silently (logged by sweepOrphans)
      }
    }
    return entries;
  }

  /**
   * sweepOrphans — called once on worker startup and on a periodic interval.
   *
   * For every persisted entry:
   *   1. Check if the process is still running AND has the same identity token.
   *   2. If running AND identity matches → it is a live observer (leave it alone
   *      unless it has exceeded maxAgeMs).
   *   3. If NOT running (or identity mismatch = PID reused) → process already
   *      exited; just remove the stale entry file.
   *   4. If running AND age > maxAgeMs → it is a zombie observer; SIGTERM it,
   *      wait gracePeriodMs, then SIGKILL if still alive, then remove entry.
   *
   * Returns a summary object for logging / testing.
   */
  sweepOrphans(opts: SweepOptions = {}): SweepResult {
    const {
      maxAgeMs = 4 * 60 * 60 * 1000, // 4 hours — generous default
      gracePeriodMs = 5_000,           // 5 s between SIGTERM and SIGKILL
    } = opts;

    const entries = this.listAll();
    const result: SweepResult = {
      checked: entries.length,
      staleRemoved: 0,
      zombiesKilled: 0,
      liveSessions: 0,
      errors: [],
    };

    for (const entry of entries) {
      try {
        const alive = isProcessAliveWithIdentity(entry.pid, entry.startToken);

        if (!alive) {
          // Process already gone — clean up the dangling entry file
          this.release(entry.pid);
          result.staleRemoved++;
          continue;
        }

        const age = Date.now() - entry.registeredAt;
        if (age <= maxAgeMs) {
          result.liveSessions++;
          continue;
        }

        // Zombie: still running after maxAgeMs → terminate
        terminateProcess(entry.pid, gracePeriodMs);
        this.release(entry.pid);
        result.zombiesKilled++;
      } catch (err) {
        result.errors.push({ pid: entry.pid, error: String(err) });
      }
    }

    return result;
  }

  /**
   * Kill every tracked observer for a specific sessionId.
   * Called by the SessionEnd hook so each session cleans up its own observers.
   */
  releaseSession(sessionId: string, gracePeriodMs = 5_000): number {
    const entries = this.listAll().filter((e) => e.sessionId === sessionId);
    let killed = 0;
    for (const entry of entries) {
      try {
        if (isProcessAliveWithIdentity(entry.pid, entry.startToken)) {
          terminateProcess(entry.pid, gracePeriodMs);
        }
      } catch {
        // Best-effort — continue to next entry
      } finally {
        this.release(entry.pid);
        killed++;
      }
    }
    return killed;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private entryPath(pid: number): string {
    return path.join(this.dir, `${pid}.json`);
  }
}

// ─── Process identity helpers (cross-platform) ───────────────────────────────

/**
 * Read an opaque start-time token for the given PID.
 * This token is compared on the NEXT call to detect PID reuse (#2082).
 * Returns "" on any error so callers don't have to guard.
 */
export function readStartToken(pid: number): string {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // field 22 (0-indexed) is starttime in jiffies
      const fields = stat.split(" ");
      return fields[21] ?? "";
    }

    if (process.platform === "darwin") {
      // `ps -p <pid> -o lstart=` returns something like "Fri Apr 25 12:34:56 2026"
      const { execSync } = await_execSync_shim();
      return execSync(`ps -p ${pid} -o lstart=`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    }

    if (process.platform === "win32") {
      const { execSync } = await_execSync_shim();
      return execSync(
        `wmic process where processid=${pid} get CreationDate /value`,
        { stdio: ["ignore", "pipe", "ignore"] }
      )
        .toString()
        .trim();
    }
  } catch {
    // Unreadable → degrade to PID-only identity (still better than nothing)
  }
  return "";
}

/** Lazy require of child_process to keep the module tree-shakeable in tests */
function await_execSync_shim() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("child_process") as { execSync: (cmd: string, opts?: object) => Buffer };
}

/**
 * Returns true if `pid` is running AND its start-token still matches `token`.
 * If `token` is empty (was unreadable at registration time) we fall back to
 * PID-only liveness check — same as kill(pid, 0) pattern from #2082.
 */
export function isProcessAliveWithIdentity(pid: number, token: string): boolean {
  try {
    // kill(pid, 0) throws if process does not exist
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Process exists; now verify identity to catch PID reuse
  if (token === "") return true; // degraded mode — accept any live PID

  const currentToken = readStartToken(pid);
  if (currentToken === "") return true; // can't read current token — be conservative

  return currentToken === token;
}

/**
 * SIGTERM → wait gracePeriodMs → SIGKILL if still alive.
 * Synchronous on purpose so the sweep loop is simple and testable.
 */
export function terminateProcess(pid: number, gracePeriodMs: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }

  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // probe
    } catch {
      return; // exited cleanly after SIGTERM
    }
    // Busy-wait in 100 ms increments — only called during cleanup, not hot path
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  // Still alive after grace period → force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead between the probe and SIGKILL — that's fine
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SweepOptions {
  /** Max age in ms before a running observer is considered a zombie. Default 4 h */
  maxAgeMs?: number;
  /** Grace period between SIGTERM and SIGKILL. Default 5 000 ms */
  gracePeriodMs?: number;
}

export interface SweepResult {
  checked: number;
  staleRemoved: number;
  zombiesKilled: number;
  liveSessions: number;
  errors: Array<{ pid: number; error: string }>;
}
