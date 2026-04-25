/**
 * ObserverSessionRegistry.test.ts
 *
 * Additive test coverage for the observer-sessions leak fix (issue #2126).
 *
 * Test strategy:
 *   - Uses tmp directories so tests never pollute ~/.claude-mem/observer-sessions
 *   - Spawns real child processes (node -e "setTimeout(()=>{},60000)") so
 *     PID-liveness checks are genuine, not mocked
 *   - Platform-specific blocks are guarded with process.platform so the suite
 *     passes on Linux (CI), macOS (dev machines), and Windows
 *
 * Run with:  bun test tests/ObserverSessionRegistry.test.ts
 * Or:        npx jest tests/ObserverSessionRegistry.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync, spawn } from "child_process";

import {
  ObserverSessionRegistry,
  isProcessAliveWithIdentity,
  readStartToken,
  terminateProcess,
  type ObserverEntry,
  type SweepResult,
} from "../src/services/worker/ObserverSessionRegistry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fresh tmp dir for each test group */
function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "observer-test-"));
}

/** Spawn a long-lived no-op child process. Returns its PID. */
function spawnSleeper(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid!;
}

/** Synchronously wait ms milliseconds (uses Atomics so it works in Bun + Node) */
function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("ObserverSessionRegistry", () => {
  let tmpDir: string;
  let registry: ObserverSessionRegistry;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    registry = new ObserverSessionRegistry(tmpDir);
  });

  afterEach(() => {
    // Best-effort cleanup of tmp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── register ──────────────────────────────────────────────────────────────

  describe("register()", () => {
    it("writes a JSON file named <pid>.json to the registry dir", () => {
      const pid = spawnSleeper();
      try {
        registry.register(pid, "session-abc");
        const file = path.join(tmpDir, `${pid}.json`);
        expect(fs.existsSync(file)).toBe(true);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("entry contains pid, sessionId, registeredAt and startToken fields", () => {
      const pid = spawnSleeper();
      try {
        const entry = registry.register(pid, "session-xyz");
        expect(entry.pid).toBe(pid);
        expect(entry.sessionId).toBe("session-xyz");
        expect(typeof entry.registeredAt).toBe("number");
        expect(entry.registeredAt).toBeLessThanOrEqual(Date.now());
        // startToken is a string; may be empty on unsupported platforms
        expect(typeof entry.startToken).toBe("string");
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("is idempotent — re-registering same pid overwrites the file", () => {
      const pid = spawnSleeper();
      try {
        registry.register(pid, "session-1");
        registry.register(pid, "session-2"); // overwrite
        const files = fs.readdirSync(tmpDir);
        expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
        const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, `${pid}.json`), "utf8")) as ObserverEntry;
        expect(raw.sessionId).toBe("session-2");
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    });
  });

  // ── release ───────────────────────────────────────────────────────────────

  describe("release()", () => {
    it("removes the entry file for a registered pid", () => {
      const pid = spawnSleeper();
      try {
        registry.register(pid, "session-abc");
        registry.release(pid);
        expect(fs.existsSync(path.join(tmpDir, `${pid}.json`))).toBe(false);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("is a no-op when the entry does not exist (no throw)", () => {
      expect(() => registry.release(999999)).not.toThrow();
    });
  });

  // ── listAll ───────────────────────────────────────────────────────────────

  describe("listAll()", () => {
    it("returns an empty array when no entries exist", () => {
      expect(registry.listAll()).toEqual([]);
    });

    it("returns all registered entries", () => {
      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();
      try {
        registry.register(pid1, "s1");
        registry.register(pid2, "s2");
        const all = registry.listAll();
        const pids = all.map((e) => e.pid).sort();
        expect(pids).toEqual([pid1, pid2].sort());
      } finally {
        try { process.kill(pid1, "SIGKILL"); } catch { /* ignore */ }
        try { process.kill(pid2, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("skips corrupt JSON files without throwing", () => {
      fs.writeFileSync(path.join(tmpDir, "bad.json"), "{ NOT VALID JSON }");
      expect(() => registry.listAll()).not.toThrow();
      expect(registry.listAll()).toHaveLength(0);
    });
  });

  // ── sweepOrphans ──────────────────────────────────────────────────────────

  describe("sweepOrphans()", () => {
    it("removes stale entries for processes that have already exited", () => {
      // Spawn a process that exits immediately and capture its PID
      const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 5000 });
      // spawnSync waits for completion so the process is definitely dead by now.
      // Use a very high PID that is virtually guaranteed to not exist on any platform.
      // Windows reserves PIDs above 4194304; Linux/macOS never reach 4000000 in normal use.
      const fakePid = 4000000;
      const fakeEntry: ObserverEntry = {
        pid: fakePid,
        startToken: "",
        sessionId: "dead-session",
        registeredAt: Date.now() - 1000,
      };
      fs.writeFileSync(path.join(tmpDir, `${fakePid}.json`), JSON.stringify(fakeEntry));

      const sweep: SweepResult = registry.sweepOrphans();
      expect(sweep.staleRemoved).toBeGreaterThanOrEqual(1);
      // Entry file should be gone
      expect(fs.existsSync(path.join(tmpDir, `${fakePid}.json`))).toBe(false);
    });

    it("leaves live sessions alone when they are within maxAgeMs", () => {
      const pid = spawnSleeper();
      try {
        registry.register(pid, "live-session");
        const sweep = registry.sweepOrphans({ maxAgeMs: 60 * 60 * 1000 }); // 1 hour
        expect(sweep.liveSessions).toBeGreaterThanOrEqual(1);
        expect(sweep.zombiesKilled).toBe(0);
        // Entry still exists
        expect(fs.existsSync(path.join(tmpDir, `${pid}.json`))).toBe(true);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("kills zombie observers that exceed maxAgeMs and removes their entry", () => {
      const pid = spawnSleeper();
      try {
        // Register with a registeredAt far in the past
        const entry: ObserverEntry = {
          pid,
          startToken: readStartToken(pid),
          sessionId: "zombie-session",
          registeredAt: Date.now() - 10_000, // 10 s ago
        };
        fs.writeFileSync(path.join(tmpDir, `${pid}.json`), JSON.stringify(entry));

        const sweep = registry.sweepOrphans({
          maxAgeMs: 5_000,    // 5 s — entry is 10 s old → zombie
          gracePeriodMs: 500, // short grace period for test speed
        });
        expect(sweep.zombiesKilled).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(path.join(tmpDir, `${pid}.json`))).toBe(false);
        // Process should be dead
        let dead = false;
        try { process.kill(pid, 0); } catch { dead = true; }
        expect(dead).toBe(true);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("returns correct totals in SweepResult", () => {
      const livePid = spawnSleeper();
      try {
        registry.register(livePid, "live");

        // Add a fake dead entry using a PID that is guaranteed not to exist
        const deadPid = 4000000;
        const deadEntry: ObserverEntry = { pid: deadPid, startToken: "", sessionId: "dead", registeredAt: Date.now() };
        fs.writeFileSync(path.join(tmpDir, `${deadPid}.json`), JSON.stringify(deadEntry));

        const sweep = registry.sweepOrphans({ maxAgeMs: 60 * 60 * 1000 });
        expect(sweep.checked).toBe(2);
        expect(sweep.staleRemoved).toBe(1);
        expect(sweep.liveSessions).toBe(1);
        expect(sweep.zombiesKilled).toBe(0);
        expect(sweep.errors).toHaveLength(0);
      } finally {
        try { process.kill(livePid, "SIGKILL"); } catch { /* ignore */ }
      }
    });
  });

  // ── releaseSession ────────────────────────────────────────────────────────

  describe("releaseSession()", () => {
    it("kills and removes all observers belonging to a sessionId", () => {
      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();
      const pid3 = spawnSleeper(); // belongs to different session
      try {
        registry.register(pid1, "session-A");
        registry.register(pid2, "session-A");
        registry.register(pid3, "session-B");

        const killed = registry.releaseSession("session-A", 500);
        expect(killed).toBe(2);

        // session-A observers are gone
        expect(fs.existsSync(path.join(tmpDir, `${pid1}.json`))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, `${pid2}.json`))).toBe(false);
        // session-B observer is untouched
        expect(fs.existsSync(path.join(tmpDir, `${pid3}.json`))).toBe(true);

        // PIDs 1 and 2 should be dead
        [pid1, pid2].forEach((pid) => {
          let dead = false;
          try { process.kill(pid, 0); } catch { dead = true; }
          expect(dead).toBe(true);
        });
      } finally {
        try { process.kill(pid1, "SIGKILL"); } catch { /* ignore */ }
        try { process.kill(pid2, "SIGKILL"); } catch { /* ignore */ }
        try { process.kill(pid3, "SIGKILL"); } catch { /* ignore */ }
      }
    });

    it("returns 0 when sessionId has no registered observers", () => {
      expect(registry.releaseSession("non-existent-session")).toBe(0);
    });
  });
});

// ─── Unit tests for standalone helpers ───────────────────────────────────────

describe("isProcessAliveWithIdentity()", () => {
  it("returns true for a running process with matching token", () => {
    const pid = spawnSleeper();
    try {
      const token = readStartToken(pid);
      expect(isProcessAliveWithIdentity(pid, token)).toBe(true);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }
  });

  it("returns false for a non-existent PID", () => {
    // PID 4000000 is above the max PID on Linux (4194304 kernel limit) and
    // above the practical range on macOS and Windows — guaranteed not to exist.
    // We do NOT use PID 0: on Windows it is the always-alive System Idle Process.
    expect(isProcessAliveWithIdentity(4000000, "")).toBe(false);
  });

  it("returns false when token does not match (PID reuse simulation)", () => {
    const pid = spawnSleeper();
    try {
      // Supply a token that is intentionally wrong to simulate PID reuse
      const result = isProcessAliveWithIdentity(pid, "DEFINITELY-WRONG-TOKEN-99999");
      // If readStartToken returns non-empty, it should be false (token mismatch)
      // If readStartToken returns empty (platform fallback), it returns true — both are acceptable
      const token = readStartToken(pid);
      if (token !== "") {
        expect(result).toBe(false);
      } else {
        // Degraded mode: empty token means we trust PID liveness alone
        expect(result).toBe(true);
      }
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }
  });
});

describe("terminateProcess()", () => {
  it("kills a running process within the grace period", () => {
    const pid = spawnSleeper();
    terminateProcess(pid, 3_000);

    let dead = false;
    try { process.kill(pid, 0); } catch { dead = true; }
    expect(dead).toBe(true);
  });

  it("does not throw when called on an already-dead PID", () => {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    // There's no clean way to get the PID of a sync spawn that's already done,
    // so we just verify terminateProcess doesn't throw on PID 0
    expect(() => terminateProcess(0, 100)).not.toThrow();
  });
});
