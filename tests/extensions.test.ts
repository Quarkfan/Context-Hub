import { describe, expect, it } from "vitest";
import {
  ExtensionCatalog,
  MemoryExtensionStateRepository,
  type ExtensionDescriptor,
} from "../src/extensions.js";

const descriptor: ExtensionDescriptor = {
  providerId: "context-source.test",
  family: "context-source",
  version: "1.0.0",
  contractVersion: "1.0",
  displayName: "Test Context Source",
  isolation: "in-process",
  capabilities: { retrieve: true },
};

describe("context extension lifecycle", () => {
  it("persists probes, lifecycle gates and logs across catalog restarts", async () => {
    const repository = new MemoryExtensionStateRepository();
    const catalog = new ExtensionCatalog([descriptor], repository);
    await catalog.initialize();

    expect((await catalog.probe("context-source.test")).status).toBe("ready");
    await catalog.transition("context-source.test", "disabled");
    expect(() => catalog.require("context-source.test")).toThrow("disabled");
    await expect(
      catalog.transition("context-source.test", "canary"),
    ).rejects.toThrow("Cannot move");

    const restored = new ExtensionCatalog([descriptor], repository);
    await restored.initialize();
    expect(restored.get("context-source.test").lifecycleState).toBe("disabled");
    expect(await restored.logs("context-source.test")).toHaveLength(3);

    expect((await restored.probe("context-source.test")).status).toBe("ready");
    await restored.transition("context-source.test", "verified");
    expect(restored.get("context-source.test").lifecycleState).toBe("verified");
    expect(await restored.logs("context-source.test")).toHaveLength(6);
  });
});
