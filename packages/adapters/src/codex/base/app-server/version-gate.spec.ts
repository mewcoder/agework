import { describe, it, expect } from "vitest";
import {
  parseVersion,
  extractCodexVersion,
  compareVersions,
  checkVersionGate,
  enforceVersionGate,
} from "./version-gate";
import type { VersionGateConfig } from "./types";

describe("version-gate", () => {
  // ── parseVersion ──────────────────────────────────────────────────────

  describe("parseVersion", () => {
    it("parses a standard semver", () => {
      expect(parseVersion("0.144.1")).toEqual([0, 144, 1]);
    });

    it("parses a version with pre-release suffix", () => {
      expect(parseVersion("1.0.0-rc.1")).toEqual([1, 0, 0]);
    });

    it("parses a dev version", () => {
      expect(parseVersion("0.200.0-dev.42")).toEqual([0, 200, 0]);
    });

    it("returns null for non-semver strings", () => {
      expect(parseVersion("not-a-version")).toBeNull();
      expect(parseVersion("1.2")).toBeNull();
      expect(parseVersion("")).toBeNull();
    });
  });

  // ── extractCodexVersion ───────────────────────────────────────────────

  describe("extractCodexVersion", () => {
    it("extracts from codex-cli/VERSION format", () => {
      expect(extractCodexVersion("codex-cli/0.144.1")).toBe("0.144.1");
    });

    it("extracts from codex-cli VERSION format (space separator)", () => {
      expect(extractCodexVersion("codex-cli 0.144.1")).toBe("0.144.1");
    });

    it("extracts from codex/VERSION format (without -cli suffix)", () => {
      expect(extractCodexVersion("codex/0.200.0")).toBe("0.200.0");
    });

    it("extracts from bare semver at string start", () => {
      expect(extractCodexVersion("0.144.1")).toBe("0.144.1");
    });

    it("extracts from userAgent with extra info", () => {
      expect(
        extractCodexVersion("codex-cli/1.2.3 (macos; arm64)"),
      ).toBe("1.2.3");
    });

    it("returns null when no version found", () => {
      expect(extractCodexVersion("unknown-agent")).toBeNull();
      expect(extractCodexVersion("")).toBeNull();
    });
  });

  // ── compareVersions ───────────────────────────────────────────────────

  describe("compareVersions", () => {
    it("returns 0 for equal versions", () => {
      expect(compareVersions([0, 144, 1], [0, 144, 1])).toBe(0);
    });

    it("returns negative for older version", () => {
      expect(compareVersions([0, 143, 0], [0, 144, 0])).toBeLessThan(0);
    });

    it("returns positive for newer version", () => {
      expect(compareVersions([0, 145, 0], [0, 144, 0])).toBeGreaterThan(0);
    });

    it("compares major first", () => {
      expect(compareVersions([1, 0, 0], [0, 999, 999])).toBeGreaterThan(0);
    });
  });

  // ── checkVersionGate ──────────────────────────────────────────────────

  describe("checkVersionGate", () => {
    const config: VersionGateConfig = {
      generatedVersion: "0.144.1",
      strict: true,
    };

    it("returns compatible for exact match", () => {
      const result = checkVersionGate(config, "0.144.1");
      expect(result.status).toBe("compatible");
      expect(result.codexVersion).toBe("0.144.1");
    });

    it("returns compatible for patch difference", () => {
      const result = checkVersionGate(config, "0.144.5");
      expect(result.status).toBe("compatible");
    });

    it("returns degraded for minor difference (older)", () => {
      const result = checkVersionGate(config, "0.143.0");
      expect(result.status).toBe("degraded");
      expect(result.reason).toContain("older");
    });

    it("returns degraded for minor difference (newer)", () => {
      const result = checkVersionGate(config, "0.145.0");
      expect(result.status).toBe("degraded");
      expect(result.reason).toContain("newer");
    });

    it("returns incompatible for major difference", () => {
      const result = checkVersionGate(config, "1.0.0");
      expect(result.status).toBe("incompatible");
      expect(result.reason).toContain("major version");
    });

    it("returns degraded for null version (best-effort, non-blocking)", () => {
      const result = checkVersionGate(config, null);
      expect(result.status).toBe("degraded");
      expect(result.codexVersion).toBe("unknown");
      expect(result.reason).toContain("best-effort");
    });

    it("returns incompatible for unparseable runtime version", () => {
      const result = checkVersionGate(config, "garbage");
      expect(result.status).toBe("incompatible");
    });

    it("returns incompatible for unparseable generated version", () => {
      const badConfig: VersionGateConfig = {
        generatedVersion: "bad",
        strict: true,
      };
      const result = checkVersionGate(badConfig, "0.144.1");
      expect(result.status).toBe("incompatible");
    });
  });

  // ── enforceVersionGate ────────────────────────────────────────────────

  describe("enforceVersionGate", () => {
    const strictConfig: VersionGateConfig = {
      generatedVersion: "0.144.1",
      strict: true,
    };
    const nonStrictConfig: VersionGateConfig = {
      generatedVersion: "0.144.1",
      strict: false,
    };

    it("does not throw for compatible", () => {
      expect(() =>
        enforceVersionGate(
          { status: "compatible", codexVersion: "0.144.1" },
          strictConfig,
        ),
      ).not.toThrow();
    });

    it("does not throw for degraded", () => {
      expect(() =>
        enforceVersionGate(
          { status: "degraded", codexVersion: "0.145.0", reason: "minor drift" },
          strictConfig,
        ),
      ).not.toThrow();
    });

    it("throws for incompatible in strict mode", () => {
      expect(() =>
        enforceVersionGate(
          { status: "incompatible", codexVersion: "1.0.0", reason: "major" },
          strictConfig,
        ),
      ).toThrow(/version mismatch/);
    });

    it("does not throw for incompatible in non-strict mode", () => {
      expect(() =>
        enforceVersionGate(
          { status: "incompatible", codexVersion: "1.0.0", reason: "major" },
          nonStrictConfig,
        ),
      ).not.toThrow();
    });

    it("does not throw for incompatible when strict is undefined (defaults to non-strict)", () => {
      const defaultConfig: VersionGateConfig = {
        generatedVersion: "0.144.1",
      };
      expect(() =>
        enforceVersionGate(
          { status: "incompatible", codexVersion: "1.0.0", reason: "major" },
          defaultConfig,
        ),
      ).not.toThrow();
    });
  });
});
