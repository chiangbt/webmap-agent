import { describe, expect, it } from "vitest";
import { MESSAGES, t, type GeoAgentLocale } from "../src/lib/i18n";

const LOCALES: GeoAgentLocale[] = ["en", "zh-CN"];

describe("i18n messages", () => {
  it("keeps every locale's dictionary keys aligned with en", () => {
    const enKeys = Object.keys(MESSAGES.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(enKeys);
    }
  });

  it("has a non-empty string for every message in every locale", () => {
    for (const locale of LOCALES) {
      for (const value of Object.values(MESSAGES[locale])) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates named parameters", () => {
    expect(t("en", "logRunningTool", { tool: "add_marker" })).toBe(
      "Running add_marker",
    );
    expect(t("zh-CN", "logRunningTool", { tool: "add_marker" })).toBe(
      "正在运行 add_marker",
    );
    expect(t("en", "noteUsingLatestModel", { model: "gpt-test" })).toBe(
      "Using latest model: gpt-test.",
    );
    expect(t("zh-CN", "hintAddMissingToStart", { missing: "API 密钥" })).toBe(
      "请添加 API 密钥 以开始。",
    );
    expect(
      t("zh-CN", "eeStatusInitialized", { initialized: "是", count: 3 }),
    ).toBe("初始化状态：是；图层数量：3。");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(t("en", "eeStatusInitialized", { initialized: "yes" })).toContain(
      "{count}",
    );
  });

  it("substitutes parameter values literally", () => {
    // A `$` in a value must not be treated as a replacement pattern.
    expect(t("en", "logRunningTool", { tool: "$& $' add" })).toBe(
      "Running $& $' add",
    );
  });
});
