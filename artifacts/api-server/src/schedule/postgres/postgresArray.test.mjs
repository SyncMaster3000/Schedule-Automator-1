import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { postgresIntegerArray } from "./postgresArray.js";

test("serializes multiple integer identifiers as one PostgreSQL array parameter", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(
    sql`select id from teachers
        where id = any(${postgresIntegerArray([1, 2])}::integer[])`,
  );

  assert.match(query.sql, /id = any\(\$1::integer\[\]\)/);
  assert.deepEqual(query.params, ["{1,2}"]);
});

test("serializes an empty identifier list without interpolating SQL", () => {
  assert.equal(postgresIntegerArray([]), "{}");
});

test("rejects non-integer identifiers", () => {
  assert.throws(
    () => postgresIntegerArray([1, "not-an-id"]),
    /безопасным целым числом/,
  );
});
