import { describe, expect, it } from "vitest";
import {
  addMatrixDomain,
  addMatrixPage,
  applyCellEdits,
  applyDomainLayout,
  applyRowLayout,
  collectRowSeeds,
  matrixCellKey,
  moveListItem,
  removeMatrixDomain,
  removeMatrixRow,
  saveCellCounts,
  type BusMatrixLayout,
} from "./bus-matrix-layout";

const empty: BusMatrixLayout = {
  domainOrder: [],
  hiddenDomains: [],
  aliases: {},
  hiddenRows: [],
  rowOrder: [],
  rowAliases: {},
  moduleAliases: {},
  manualDomains: [],
  manualRows: [],
  manualPages: [],
  tableBindings: {},
  cellEdits: {},
  deletedCells: [],
  assetMounts: {},
};

const sampleCell = {
  module_name: "本体",
  module_node_id: "mod-1",
  page_name: "本体页",
  page_key: "page-ontology",
  domain: "ontology",
  table_count: 3,
  read_count: 2,
  write_count: 1,
};

describe("applyDomainLayout", () => {
  it("keeps snapshot order when no layout is stored", () => {
    expect(applyDomainLayout(["pay", "cart", "home"], empty)).toEqual([
      "pay",
      "cart",
      "home",
    ]);
  });

  it("reorders, then appends unseen domains, then drops hidden columns", () => {
    expect(
      applyDomainLayout(["pay", "cart", "home", "stock"], {
        ...empty,
        domainOrder: ["home", "pay"],
        hiddenDomains: ["cart"],
      }),
    ).toEqual(["home", "pay", "stock"]);
  });
});

describe("applyRowLayout", () => {
  it("reorders pages and drops hidden rows", () => {
    expect(
      applyRowLayout(["home", "cart", "pay"], {
        ...empty,
        rowOrder: ["pay", "home"],
        hiddenRows: ["cart"],
      }),
    ).toEqual(["pay", "home"]);
  });
});

describe("moveListItem", () => {
  it("swaps neighbors and no-ops at the edge", () => {
    expect(moveListItem(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveListItem(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  });
});

describe("applyCellEdits", () => {
  it("overlays read/write on an existing locator and keeps the original domain", () => {
    const next = applyCellEdits([sampleCell], {
      ...empty,
      cellEdits: {
        [matrixCellKey("mod-1", "page-ontology", "ontology")]: { read: 5, write: 4 },
      },
    });
    expect(next).toEqual([
      {
        ...sampleCell,
        table_count: 9,
        read_count: 5,
        write_count: 4,
      },
    ]);
  });

  it("drops deleted snapshot cells and can recreate them from an edit", () => {
    const key = matrixCellKey("mod-1", "page-ontology", "ontology");
    expect(applyCellEdits([sampleCell], { ...empty, deletedCells: [key] })).toEqual([]);
    expect(
      applyCellEdits([sampleCell], {
        ...empty,
        deletedCells: [key],
        cellEdits: { [key]: { read: 1, write: 0 } },
      }),
    ).toEqual([
      {
        ...sampleCell,
        table_count: 1,
        read_count: 1,
        write_count: 0,
      },
    ]);
  });

  it("creates a cell on a manual page that had no snapshot value", () => {
    const next = applyCellEdits([], {
      ...empty,
      manualPages: [{ id: "page-new", moduleName: "检索", pageName: "检索页" }],
      cellEdits: {
        [matrixCellKey("page-new", "page-new", "archive")]: { read: 2, write: 1 },
      },
    });
    expect(next[0]).toMatchObject({
      module_name: "检索",
      page_name: "检索页",
      domain: "archive",
      read_count: 2,
      write_count: 1,
      table_count: 3,
    });
  });
});

describe("collectRowSeeds", () => {
  it("keeps snapshot rows after cells are cleared and appends manual pages", () => {
    const seeds = collectRowSeeds([sampleCell], {
      ...empty,
      manualPages: [{ id: "page-new", moduleName: "检索", pageName: "检索页" }],
    });
    expect(seeds.map((row) => row.pageKey)).toEqual(["page-ontology", "page-new"]);
    expect(seeds[1]).toMatchObject({ moduleName: "检索", pageName: "检索页" });
  });

  it("places a manual page under an existing module when moduleKey matches", () => {
    const seeds = collectRowSeeds([sampleCell], {
      ...empty,
      manualPages: [
        { id: "page-extra", moduleName: "本体", pageName: "新页", moduleKey: "mod-1" },
      ],
    });
    expect(seeds[1]).toMatchObject({
      moduleKey: "mod-1",
      moduleName: "本体",
      pageKey: "page-extra",
      pageName: "新页",
    });
  });
});

describe("matrix mutations", () => {
  it("adds and removes manual domains without rewriting snapshot keys", () => {
    const added = addMatrixDomain(empty, "compliance", ["ontology"]);
    expect(added.manualDomains).toEqual(["compliance"]);
    expect(added.domainOrder).toEqual(["ontology", "compliance"]);
    expect(removeMatrixDomain(added, "compliance").manualDomains).toEqual([]);
    expect(removeMatrixDomain(empty, "ontology").hiddenDomains).toEqual(["ontology"]);
  });

  it("adds and removes manual pages; snapshot rows are hidden", () => {
    const added = addMatrixPage(
      empty,
      { id: "page-new", moduleName: "检索", pageName: "检索页" },
      ["page-ontology"],
    );
    expect(added.manualPages).toHaveLength(1);
    expect(removeMatrixRow(added, "page-new").manualPages).toEqual([]);
    expect(removeMatrixRow(empty, "page-ontology").hiddenRows).toEqual(["page-ontology"]);
  });

  it("saveCellCounts writes an edit or marks the locator deleted", () => {
    const edited = saveCellCounts(empty, "mod-1", "page-ontology", "ontology", 2, 3);
    expect(edited.cellEdits[matrixCellKey("mod-1", "page-ontology", "ontology")]).toEqual({
      read: 2,
      write: 3,
    });
    const cleared = saveCellCounts(edited, "mod-1", "page-ontology", "ontology", 0, 0);
    expect(cleared.cellEdits).toEqual({});
    expect(cleared.deletedCells).toEqual([matrixCellKey("mod-1", "page-ontology", "ontology")]);
  });
});
