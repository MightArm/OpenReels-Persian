import { afterEach, describe, expect, it } from "vitest";
import { stockOnlyFromEnv, toStockVisualType } from "./utils.js";

describe("toStockVisualType", () => {
  it("maps AI visual types onto their stock equivalents", () => {
    expect(toStockVisualType("ai_image")).toBe("stock_image");
    expect(toStockVisualType("ai_video")).toBe("stock_video");
  });

  it("passes non-AI visual types through unchanged", () => {
    expect(toStockVisualType("stock_image")).toBe("stock_image");
    expect(toStockVisualType("stock_video")).toBe("stock_video");
    expect(toStockVisualType("text_card")).toBe("text_card");
  });
});

describe("stockOnlyFromEnv", () => {
  const KEY = "STOCK_ONLY";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("reads truthy values", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on"]) {
      process.env[KEY] = v;
      expect(stockOnlyFromEnv()).toBe(true);
    }
  });

  it("reads falsy values", () => {
    for (const v of ["false", "FALSE", "0", "no", "off"]) {
      process.env[KEY] = v;
      expect(stockOnlyFromEnv()).toBe(false);
    }
  });

  it("returns undefined when unset or unrecognized", () => {
    delete process.env[KEY];
    expect(stockOnlyFromEnv()).toBeUndefined();
    process.env[KEY] = "maybe";
    expect(stockOnlyFromEnv()).toBeUndefined();
  });
});
