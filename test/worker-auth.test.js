// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  hashPassword, timingSafeEqual, sha256Hex, normalizeEmail,
  isLoginLocked, nextLoginFailureState, nextSignupThrottleState, checkProjectSize
} from "../worker/index.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Avery@Firm.com ")).toBe("avery@firm.com");
  });
  it("handles null/undefined without throwing", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });
});

describe("hashPassword", () => {
  it("is deterministic for the same password+salt", async () => {
    const a = await hashPassword("hunter2", "somesalt");
    const b = await hashPassword("hunter2", "somesalt");
    expect(a).toBe(b);
  });

  it("differs for different passwords or different salts", async () => {
    const base = await hashPassword("hunter2", "somesalt");
    const diffPassword = await hashPassword("hunter3", "somesalt");
    const diffSalt = await hashPassword("hunter2", "othersalt");
    expect(diffPassword).not.toBe(base);
    expect(diffSalt).not.toBe(base);
  });

  it("never returns the plaintext password", async () => {
    const hash = await hashPassword("hunter2", "somesalt");
    expect(hash).not.toContain("hunter2");
  });
});

describe("timingSafeEqual", () => {
  it("returns true only for exactly equal strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });
  it("returns false for different-length inputs or non-strings", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual(null, "abc")).toBe(false);
    expect(timingSafeEqual("abc", undefined)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("produces a stable 64-char hex digest", async () => {
    const digest = await sha256Hex("test-token");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("test-token")).toBe(digest);
  });
});

describe("login rate limiting", () => {
  it("isLoginLocked: not locked when no row exists", () => {
    expect(isLoginLocked(null).locked).toBe(false);
  });

  it("isLoginLocked: locked while locked_until is in the future", () => {
    const now = Date.now();
    const row = { locked_until: new Date(now + 60_000).toISOString() };
    const result = isLoginLocked(row, now);
    expect(result.locked).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("isLoginLocked: not locked once locked_until has passed", () => {
    const now = Date.now();
    const row = { locked_until: new Date(now - 1000).toISOString() };
    expect(isLoginLocked(row, now).locked).toBe(false);
  });

  it("nextLoginFailureState: does not lock before the attempt cap", () => {
    const now = Date.now();
    let row = null;
    for (let i = 0; i < 4; i += 1) {
      const next = nextLoginFailureState(row, now);
      row = { count: next.count, window_start: next.windowStart, locked_until: next.lockedUntil };
      expect(next.lockedUntil).toBeNull();
    }
    expect(row.count).toBe(4);
  });

  it("nextLoginFailureState: locks out exactly at the 5th failure within the window", () => {
    const now = Date.now();
    let row = null;
    for (let i = 0; i < 5; i += 1) {
      const next = nextLoginFailureState(row, now);
      row = { count: next.count, window_start: next.windowStart, locked_until: next.lockedUntil };
    }
    expect(row.count).toBe(5);
    expect(row.locked_until).not.toBeNull();
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(now);
  });

  it("nextLoginFailureState: an old failure outside the window resets the count instead of accumulating", () => {
    const now = Date.now();
    const staleRow = { count: 4, window_start: new Date(now - 20 * 60 * 1000).toISOString(), locked_until: null }; // 20 min ago, window is 15 min
    const next = nextLoginFailureState(staleRow, now);
    expect(next.count).toBe(1); // restarted, not 5
    expect(next.lockedUntil).toBeNull();
  });
});

describe("signup throttling", () => {
  it("allows signups under the per-window cap", () => {
    const now = Date.now();
    let row = null;
    for (let i = 0; i < 5; i += 1) {
      const { throttled, next } = nextSignupThrottleState(row, now);
      expect(throttled).toBe(false);
      row = { count: next.count, window_start: next.windowStart };
    }
  });

  it("throttles once the cap is hit within the window", () => {
    const now = Date.now();
    const row = { count: 5, window_start: new Date(now - 1000).toISOString() };
    expect(nextSignupThrottleState(row, now).throttled).toBe(true);
  });

  it("does not throttle once the window has rolled over", () => {
    const now = Date.now();
    const row = { count: 5, window_start: new Date(now - 2 * 60 * 60 * 1000).toISOString() }; // 2h ago, window is 1h
    expect(nextSignupThrottleState(row, now).throttled).toBe(false);
  });
});

describe("checkProjectSize", () => {
  it("accepts a normal-sized project", () => {
    expect(checkProjectSize({ name: "Acme", findings: { Financial: [{ title: "x" }] } })).toBeNull();
  });

  it("rejects a project blob over the size cap", () => {
    const huge = { name: "Acme", blob: "x".repeat(9 * 1024 * 1024) }; // 9MB, cap is 8MB
    const error = checkProjectSize(huge);
    expect(error).toMatch(/too large/i);
  });
});
