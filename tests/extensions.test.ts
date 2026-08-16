import { describe, expect, it } from "vitest";
import { ExtensionCatalog } from "../src/extensions.js";

describe("context extension lifecycle", () => {
  it("probes, gates execution and records transitions", () => {
    const catalog = new ExtensionCatalog([
      {
        providerId: "context-source.test",
        family: "context-source",
        version: "1.0.0",
        contractVersion: "1.0",
        displayName: "Test Context Source",
        isolation: "in-process",
        capabilities: { retrieve: true },
      },
    ]);
    expect(catalog.probe("context-source.test").status).toBe("ready");
    catalog.transition("context-source.test", "disabled");
    expect(() => catalog.require("context-source.test")).toThrow("disabled");
    expect(() => catalog.transition("context-source.test", "canary")).toThrow(
      "Cannot move",
    );
    expect(catalog.logs("context-source.test")).toHaveLength(2);
  });
});
