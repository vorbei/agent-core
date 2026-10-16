// A Durable-Object-shaped storage over node:sqlite, for tests.
import { DatabaseSync } from "node:sqlite";

export function sqliteStorage(db = new DatabaseSync(":memory:")) {
  let depth = 0;
  return {
    db,
    sql: { exec: (/** @type {string} */ query, /** @type {any[]} */ ...bindings) => {
      const values = db.prepare(query).all(...bindings);
      return { toArray: () => values };
    } },
    transactionSync(/** @type {() => any} */ closure) {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const value = closure(); db.exec(`RELEASE ${name}`); return value; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}
