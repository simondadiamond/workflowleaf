/**
 * The WorkflowLeaf SQLite connection.
 *
 * A separate database file under the WorkflowLeaf home, never the T3 store.
 * The one T3 import allowed outside the adapter is the node:sqlite client
 * itself, which is a generic Effect SQL driver with no T3 domain in it.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { workflowleafHome } from "../profile.ts";

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The CLI and a worker write from separate processes; wait rather than
    // fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
  }),
);

export const layerFile = (dbPath: string) =>
  Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: { "db.name": "workflowleaf", "service.name": "workflowleaf" },
    }),
  );

export const layerMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

/** `$WORKFLOWLEAF_HOME/state.sqlite`, created on first use. */
export const layerDefault = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* workflowleafHome();
    yield* fs.makeDirectory(home, { recursive: true });
    return layerFile(path.join(home, "state.sqlite"));
  }),
);
