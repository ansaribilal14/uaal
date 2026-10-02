import { describe, it, expect } from "vitest";
import {
  platformPreview,
  formatBytes,
  friendlyFailure,
  storageChoices,
  expandHome,
  type StorageOption
} from "../../src/interfaces/wizard.js";

describe("wizard: platform preview (local, no network)", () => {
  it("detects X/Twitter", () => {
    expect(platformPreview("https://x.com/pinksbabymon/status/1946856344989864248").label).toBe("X (Twitter)");
    expect(platformPreview("https://mobile.twitter.com/jack/status/20").label).toBe("X (Twitter)");
  });
  it("detects YouTube with an honest capability hint", () => {
    const p = platformPreview("https://youtu.be/dQw4w9WgXcQ");
    expect(p.label).toBe("YouTube");
    expect(p.hint).toMatch(/yt-dlp/);
  });
  it("detects Reddit", () => {
    expect(platformPreview("https://www.reddit.com/r/aww/comments/abc123/pup/").label).toBe("Reddit");
  });
  it("detects Threads and Instagram with honest limited-access hints", () => {
    expect(platformPreview("https://www.threads.net/@zuck/post/xyz").label).toBe("Threads");
    expect(platformPreview("https://www.threads.net/@zuck/post/xyz").hint).toMatch(/generic web/);
    expect(platformPreview("https://www.instagram.com/p/Cabc123/").label).toBe("Instagram");
    expect(platformPreview("https://www.instagram.com/p/Cabc123/").hint).toMatch(/never bypasses/i);
  });
  it("falls back to generic web and garbage handling", () => {
    expect(platformPreview("https://example.com/page").label).toBe("Generic web page");
    expect(platformPreview("not a url").label).toBe("Unknown link");
  });
});

describe("wizard: formatBytes", () => {
  it("formats human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(382150)).toBe("373.2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe("3.50 GB");
    expect(formatBytes(Number.NaN)).toBe("?");
  });
});

describe("wizard: friendly failure mapping (fail-closed preserved)", () => {
  it("maps common codes to human reasons", () => {
    expect(friendlyFailure("failed", "RATE_LIMIT")).toMatch(/try again/i);
    expect(friendlyFailure("failed", "TIMEOUT")).toMatch(/too long/i);
    expect(friendlyFailure("failed", "VERIFICATION_FAILURE")).toMatch(/NOT saved/i);
    expect(friendlyFailure("failed", "DEPENDENCY_FAILURE")).toMatch(/missing on this device/i);
    expect(friendlyFailure("failed", "ALL_ROUTES_FILTERED")).toMatch(/yt-dlp/i);
    expect(friendlyFailure("failed", "ALL_ROUTES_EXHAUSTED")).toMatch(/Every available route/i);
  });
  it("maps auth/blocked statuses to never-bypass language", () => {
    expect(friendlyFailure("requires_auth", "AUTH_REQUIRED")).toMatch(/never bypasses/i);
    expect(friendlyFailure("blocked", "BLOCKED")).toMatch(/nothing faked/i);
  });
  it("falls back to the engine message", () => {
    expect(friendlyFailure("failed", "INTERNAL_ERROR", "boom detail")).toBe("boom detail");
  });
});

describe("wizard: storage choices", () => {
  const cwd = "/home/user/uaal";
  const home = "/home/user";
  it("offers Downloads when a known Downloads dir exists (Termux first)", () => {
    const existing = new Set(["/home/user/Downloads"]);
    const list: StorageOption[] = storageChoices(cwd, home, (p) => existing.has(p));
    const dl = list.find((c) => c.key === "downloads");
    expect(dl?.available).toBe(true);
    expect(dl?.target).toBe("/home/user/Downloads");
  });
  it("marks Downloads unavailable when nothing exists, custom always available", () => {
    const list = storageChoices(cwd, home, () => false);
    expect(list.find((c) => c.key === "downloads")?.available).toBe(false);
    expect(list.find((c) => c.key === "custom")?.available).toBe(true);
    expect(list.find((c) => c.key === "default")?.target).toBe("/home/user/uaal/artifacts");
  });
  it("prefers the Termux shared storage path when present", () => {
    const existing = new Set(["/home/user/storage/downloads"]);
    const dl = storageChoices(cwd, home, (p) => existing.has(p)).find((c) => c.key === "downloads");
    expect(dl?.target).toBe("/home/user/storage/downloads");
  });
});

describe("wizard: expandHome", () => {
  it("expands ~ and ~/ paths", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/storage/downloads", "/h")).toBe("/h/storage/downloads");
    expect(expandHome("/abs/path", "/h")).toBe("/abs/path");
  });
});
