import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINTS, resolveEndpoints } from "../src/core/endpoints.js";

describe("clinepass endpoint resolution", () => {
  it("defaults to the Cline API limits endpoint", () => {
    expect(DEFAULT_ENDPOINTS.clinepassUsage).toBe(
      "https://api.cline.bot/api/v1/users/me/plan/usage-limits",
    );
    expect(resolveEndpoints({}).clinepassUsage).toBe(DEFAULT_ENDPOINTS.clinepassUsage);
  });

  it("follows CLINE_API_BASE, the base override the ClinePass packages use", () => {
    // Chat traffic would go to the proxy; reporting quota from the real Cline
    // API would then describe a different account.
    expect(resolveEndpoints({ CLINE_API_BASE: "https://proxy.test/" }).clinepassUsage).toBe(
      "https://proxy.test/api/v1/users/me/plan/usage-limits",
    );
  });

  it("lets the exact-endpoint variable win over the derived base", () => {
    expect(
      resolveEndpoints({
        CLINE_API_BASE: "https://proxy.test",
        PI_CLINEPASS_USAGE_ENDPOINT: " https://exact.test/limits ",
      }).clinepassUsage,
    ).toBe("https://exact.test/limits");
  });

  it("ignores an empty base override", () => {
    expect(resolveEndpoints({ CLINE_API_BASE: "   " }).clinepassUsage).toBe(DEFAULT_ENDPOINTS.clinepassUsage);
  });
});
