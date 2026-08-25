import { SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
  DEFAULT_COMPACTION_TRIGGER_PERCENT,
  createCompactionPolicyBinding,
  deriveCompactionSettings,
  parseGlobalCompactionPolicy,
} from "./compaction-policy";

describe("global compaction policy", () => {
  it("defaults to a globally enabled 70 percent policy without settings", () => {
    expect(parseGlobalCompactionPolicy({})).toEqual({
      triggerPercent: DEFAULT_COMPACTION_TRIGGER_PERCENT,
      globalEnabled: true,
      globalKeepRecentTokens: DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
    });
  });

  it("accepts every integer boundary and preserves native global inputs", () => {
    expect(parseGlobalCompactionPolicy({
      compaction: { enabled: false, keepRecentTokens: 7_000 },
      easyresearch: { compaction: { triggerPercent: 10 } },
    })).toEqual({ triggerPercent: 10, globalEnabled: false, globalKeepRecentTokens: 7_000 });
    expect(parseGlobalCompactionPolicy({
      easyresearch: { compaction: { triggerPercent: 90 } },
    }).triggerPercent).toBe(90);
  });

  it.each([9, 91, 70.5, Number.NaN, "70", null])(
    "rejects invalid configured trigger percentage %s",
    (triggerPercent) => {
      expect(() => parseGlobalCompactionPolicy({
        easyresearch: { compaction: { triggerPercent } },
      })).toThrow(/integer.*10.*90/i);
    },
  );

  it("rejects non-object EasyResearch policy ancestors", () => {
    expect(() => parseGlobalCompactionPolicy({ easyresearch: "invalid" })).toThrow(/easyresearch.*object/i);
    expect(() => parseGlobalCompactionPolicy({ easyresearch: { compaction: [] } })).toThrow(/compaction.*object/i);
  });

  it.each([0, -1, 2.5, Number.POSITIVE_INFINITY, "20000"])(
    "falls back when keepRecentTokens is not a positive finite integer: %s",
    (keepRecentTokens) => {
      expect(parseGlobalCompactionPolicy({ compaction: { keepRecentTokens } }).globalKeepRecentTokens)
        .toBe(DEFAULT_COMPACTION_KEEP_RECENT_TOKENS);
    },
  );
});

describe("session compaction policy binding", () => {
  it("applies model-aware settings while preserving the uncapped retained-tail base", () => {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    });
    const binding = createCompactionPolicyBinding(settings);
    const policy = { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 };

    binding.apply(policy, { contextWindow: 8_192 }, { recaptureBase: true });
    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 2_458,
      keepRecentTokens: 2_867,
    });

    binding.apply(policy, { contextWindow: 128_000 });
    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 38_400,
      keepRecentTokens: 20_000,
    });
  });

  it("recaptures user settings after reload and retains native disable", async () => {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 6_000 },
    });
    const binding = createCompactionPolicyBinding(settings);
    const policy = { triggerPercent: 80, globalEnabled: false, globalKeepRecentTokens: 6_000 };

    binding.apply(policy, { contextWindow: 128_000 }, { recaptureBase: true });
    expect(binding.current()).toEqual({ triggerPercent: 80, enabled: false });
    expect(settings.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 25_600,
      keepRecentTokens: 6_000,
    });

    await settings.reload();
    binding.apply(policy, { contextWindow: 20_000 }, { recaptureBase: true });
    expect(settings.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 4_000,
      keepRecentTokens: 6_000,
    });
  });

  it("does not fabricate an override without a model context window", () => {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 9_000 },
    });
    const binding = createCompactionPolicyBinding(settings);

    binding.apply(
      { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
      undefined,
      { recaptureBase: true },
    );

    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 9_000,
    });
    expect(binding.current()).toEqual({ triggerPercent: 70, enabled: true });
  });

  it.each([0, 1, "false", null, undefined])(
    "normalizes malformed native enabled value %s to enabled",
    (enabled) => {
      const current = { enabled, reserveTokens: 16_384, keepRecentTokens: 20_000 };
      const applied: unknown[] = [];
      const binding = createCompactionPolicyBinding({
        getCompactionSettings: () => current as never,
        applyOverrides: (overrides) => applied.push(overrides),
      });

      expect(binding.apply(
        { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
        { contextWindow: 100_000 },
      )).toEqual({ triggerPercent: 70, enabled: true });
      expect(applied).toEqual([
        { compaction: { enabled: true, reserveTokens: 30_000, keepRecentTokens: 20_000 } },
      ]);
    },
  );
});

describe("model-aware compaction mapping", () => {
  it("maps 70 percent exactly for a 128k model and preserves a lower retained-tail ceiling", () => {
    expect(deriveCompactionSettings(128_000, 70, 20_000)).toEqual({
      triggerTokens: 89_600,
      reserveTokens: 38_400,
      keepRecentTokens: 20_000,
    });
    expect(deriveCompactionSettings(128_000, 70, 8_000).keepRecentTokens).toBe(8_000);
  });

  it.each([
    [8_192, 10, 7_373],
    [128_000, 10, 115_200],
    [8_192, 90, 820],
    [128_000, 90, 12_800],
  ])("maps a %i-token window at %i percent to the exact reserve", (window, percent, reserveTokens) => {
    expect(deriveCompactionSettings(window, percent, 20_000).reserveTokens).toBe(reserveTokens);
  });

  it("caps the retained tail for a small-window model", () => {
    expect(deriveCompactionSettings(8_192, 70, 20_000)).toEqual({
      triggerTokens: 5_734,
      reserveTokens: 2_458,
      keepRecentTokens: 2_867,
    });
  });

  it("falls back from an invalid base retained-tail value", () => {
    expect(deriveCompactionSettings(8_192, 70, Number.NaN).keepRecentTokens).toBe(2_867);
  });

  it("matches Pi's strict threshold boundary", () => {
    const mapped = deriveCompactionSettings(200_000, 80, 20_000);
    const settings = { enabled: true, reserveTokens: mapped.reserveTokens, keepRecentTokens: mapped.keepRecentTokens };

    expect(mapped.triggerTokens).toBe(160_000);
    expect(shouldCompact(mapped.triggerTokens, 200_000, settings)).toBe(false);
    expect(shouldCompact(mapped.triggerTokens + 1, 200_000, settings)).toBe(true);
  });
});
