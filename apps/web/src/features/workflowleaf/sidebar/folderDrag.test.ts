import { describe, expect, it } from "vite-plus/test";

import { expandFolderOrder, planFolderMove } from "./folderDrag";

const folders: Record<string, readonly string[]> = {
  "folder:a": ["a1", "a2"],
  "folder:b": ["b1", "b2"],
};
const membersOf = (id: string) => folders[id];

describe("expandFolderOrder", () => {
  it("puts a closed folder's threads where its row sits", () => {
    expect(expandFolderOrder(["x", "folder:a", "y"], membersOf, null)).toEqual([
      "x",
      "a1",
      "a2",
      "y",
    ]);
  });

  it("keeps the listed places of an open folder's threads", () => {
    expect(expandFolderOrder(["folder:a", "a2", "x", "a1"], membersOf, null)).toEqual([
      "a2",
      "x",
      "a1",
    ]);
  });

  it("moves every thread of the dragged folder to where it was dropped", () => {
    // An open folder dragged below x: its threads are still listed at the top.
    expect(
      expandFolderOrder(["a1", "a2", "x", "folder:a", "folder:b"], membersOf, "folder:a"),
    ).toEqual(["x", "a1", "a2", "b1", "b2"]);
  });
});

describe("planFolderMove", () => {
  const sortByKey = (keys: ReadonlyMap<string, string | null | undefined>, ids: string[]) =>
    ids.toSorted((left, right) => (keys.get(left)! < keys.get(right)! ? -1 : 1));

  it("writes keys that sort the folder's threads into the new order", () => {
    const keysById = new Map([
      ["x", "a"],
      ["a1", "m"],
      ["a2", "t"],
      ["y", "z"],
    ]);
    const order = ["a1", "a2", "x", "y"];
    const writes = planFolderMove({ order, members: ["a1", "a2"], keysById });
    const after = new Map(keysById);
    for (const { id, orderKey } of writes) after.set(id, orderKey);

    expect(sortByKey(after, ["x", "a1", "a2", "y"])).toEqual(order);
  });

  it("gives every thread a key when some had none", () => {
    const keysById = new Map<string, string | null>([
      ["x", null],
      ["a1", null],
      ["a2", null],
    ]);
    const order = ["a1", "a2", "x"];
    const after = new Map(keysById);
    for (const { id, orderKey } of planFolderMove({ order, members: ["a1", "a2"], keysById })) {
      after.set(id, orderKey);
    }

    expect(sortByKey(after, ["x", "a2", "a1"])).toEqual(order);
  });
});
