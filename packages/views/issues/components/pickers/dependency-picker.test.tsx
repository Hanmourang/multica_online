import { describe, expect, it } from "vitest";

import { collectCycleCandidates } from "./dependency-picker";

describe("collectCycleCandidates", () => {
  it("returns nothing without a self id (draft mode has no node to cycle back to)", () => {
    const edges = new Map([["A", ["B"] as const]]);
    expect(collectCycleCandidates(undefined, ["A"], edges).size).toBe(0);
  });

  it("flags the direct mutual edge (B already depends on self)", () => {
    const edges = new Map<string, readonly string[]>([
      ["self", []],
      ["B", ["self"]],
    ]);
    expect([...collectCycleCandidates("self", ["B"], edges)]).toEqual(["B"]);
  });

  it("flags transitive cycles (B → C → self) but not acyclic candidates", () => {
    const edges = new Map<string, readonly string[]>([
      ["self", []],
      ["B", ["C"]],
      ["C", ["self"]],
      ["D", ["E"]],
      ["E", []],
    ]);
    const cyclic = collectCycleCandidates("self", ["B", "D", "E"], edges);
    expect(cyclic.has("B")).toBe(true);
    expect(cyclic.has("D")).toBe(false);
    expect(cyclic.has("E")).toBe(false);
  });

  it("sees the pending selection as self's edges", () => {
    // self depends on X; X depends on nothing; Y depends on X. Adding Y as a
    // dependency of self is fine, but adding X is (self → X is the pending
    // edge; X can reach self only if something else points back — it can't).
    const edges = new Map<string, readonly string[]>([
      ["self", ["X"]],
      ["X", []],
      ["Y", ["X"]],
    ]);
    const cyclic = collectCycleCandidates("self", ["X", "Y"], edges);
    expect(cyclic.size).toBe(0);
  });

  it("survives missing edge entries and self-loops in the graph", () => {
    const edges = new Map<string, readonly string[]>([["Z", ["Z"]]]);
    const cyclic = collectCycleCandidates("self", ["Z", "ghost"], edges);
    expect(cyclic.size).toBe(0);
  });
});
