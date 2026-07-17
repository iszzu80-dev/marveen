#!/usr/bin/env node
// Ported from marveen-suite/scripts/check-definer-force-rls.mjs (card fa7279a6).
// Dora edition: catch the "SECURITY DEFINER function silently blocked by FORCE ROW LEVEL
// SECURITY on its target table" bug class at migration-write-time instead of after a live
// data-integrity incident. This has recurred 4 times in marveen-suite (quotes/0058,
// mk_accountant_client_grants/0068, mk_registrations/0082, dora/0029) and the root cause
// is always the same: FORCE RLS on a table comes from an OLDER, unrelated migration, not
// the file defining the function -- a "grep this migration" check misses it. This script
// walks every migration file IN ORDER, tracks each table's live FORCE state as of the end
// of the chain, and flags any SECURITY DEFINER function whose body reads a table that
// still has FORCE RLS set.
//
// Dora-specific additions (vs marveen-suite):
//   - Handles FOR <var> IN SELECT unnest(ARRAY[...]) LOOP ... END LOOP (dora's 0004 pattern)
//     in addition to the original FOREACH <var> IN ARRAY ARRAY[...] LOOP ... END LOOP.
//
// Usage: node db/check-definer-force-rls.mjs
// Exit code 1 if any mismatch found (suitable for CI/pre-merge/pre-deploy), 0 if clean.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

function loadMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function extractForceStateChanges(sql) {
  const changes = [];

  // Literal statements: ALTER TABLE <name> [NO] FORCE ROW LEVEL SECURITY
  const literalRe = /ALTER TABLE\s+(\w+)\s+(NO\s+)?FORCE ROW LEVEL SECURITY/gi;
  let m;
  while ((m = literalRe.exec(sql)) !== null) {
    changes.push({ table: m[1], force: !m[2] });
  }

  // Pattern A: FOREACH <var> IN ARRAY ARRAY['t1','t2',...] LOOP ... END LOOP
  // (marveen-suite 0001_init.sql style -- dynamic PL/pgSQL loop where table
  // names come from a static array literal)
  const foreachRe = /FOREACH\s+(\w+)\s+IN ARRAY ARRAY\[([^\]]*)\][\s\S]*?END LOOP/gi;
  let fl;
  while ((fl = foreachRe.exec(sql)) !== null) {
    const [loopBlock, loopVar, arrayContents] = fl;
    const tables = [...arrayContents.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const execRe = new RegExp(
      `EXECUTE\\s+format\\(\\s*['"]ALTER TABLE %I\\s+(NO\\s+)?FORCE ROW LEVEL SECURITY`,
      "gi",
    );
    let em;
    while ((em = execRe.exec(loopBlock)) !== null) {
      const force = !em[1];
      for (const table of tables) changes.push({ table, force });
    }
  }

  // Pattern B: FOR <var> IN SELECT unnest(ARRAY['t1','t2',...]) LOOP ... END LOOP
  // (dora 0004_eskuvo_lumaseat.sql style -- same dynamic FORCE RLS, different
  // loop syntax)
  const forSelectUnnestRe = /FOR\s+(\w+)\s+IN\s+SELECT\s+unnest\s*\(\s*ARRAY\s*\[([^\]]*)\]\s*\)[\s\S]*?END LOOP/gi;
  let fs;
  while ((fs = forSelectUnnestRe.exec(sql)) !== null) {
    const [loopBlock, loopVar, arrayContents] = fs;
    const tables = [...arrayContents.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const execRe = new RegExp(
      `EXECUTE\\s+format\\(\\s*['"]ALTER TABLE %I\\s+(NO\\s+)?FORCE ROW LEVEL SECURITY`,
      "gi",
    );
    let em;
    while ((em = execRe.exec(loopBlock)) !== null) {
      const force = !em[1];
      for (const table of tables) changes.push({ table, force });
    }
  }

  // Pattern C: FOR <var> IN SELECT unnest(ARRAY[...]) ... LOOP ... END LOOP
  // (multi-line variant with newlines between SELECT/unnest/ARRAY)
  const forSelectUnnestMultiRe = /FOR\s+(\w+)\s+IN\s+[\s\S]*?SELECT\s+unnest\s*\(\s*ARRAY\s*\[([^\]]*)\]\s*\)[\s\S]*?END LOOP/gi;
  let fsm;
  while ((fsm = forSelectUnnestMultiRe.exec(sql)) !== null) {
    const [loopBlock, loopVar, arrayContents] = fsm;
    const tables = [...arrayContents.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const execRe = new RegExp(
      `EXECUTE\\s+format\\(\\s*['"]ALTER TABLE %I\\s+(NO\\s+)?FORCE ROW LEVEL SECURITY`,
      "gi",
    );
    let em;
    while ((em = execRe.exec(loopBlock)) !== null) {
      const force = !em[1];
      for (const table of tables) changes.push({ table, force });
    }
  }

  return changes;
}

function extractDefinerFunctions(sql) {
  const found = [];
  // Matches CREATE [OR REPLACE] FUNCTION name(...) ... SECURITY DEFINER ... AS $$ body $$
  const re = /CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(\w+)\s*\([^)]*\)[\s\S]*?SECURITY DEFINER[\s\S]*?AS\s+\$\$([\s\S]*?)\$\$/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, name, body] = m;
    const tables = new Set();
    const tableRe = /\b(?:FROM|JOIN)\s+(\w+)/gi;
    let tm;
    while ((tm = tableRe.exec(body)) !== null) tables.add(tm[1]);
    found.push({ name, tables: [...tables] });
  }
  return found;
}

function main() {
  const files = loadMigrationFiles();
  const forceState = new Map(); // table -> boolean (current FORCE state)
  const definerFunctions = []; // { name, tables, file }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const { table, force } of extractForceStateChanges(sql)) {
      forceState.set(table, force);
    }
    for (const fn of extractDefinerFunctions(sql)) {
      definerFunctions.push({ ...fn, file });
    }
  }

  const problems = [];
  for (const fn of definerFunctions) {
    const forcedTables = fn.tables.filter((t) => forceState.get(t) === true);
    if (forcedTables.length > 0) {
      problems.push({ fn: fn.name, definedIn: fn.file, forcedTables });
    }
  }

  if (problems.length === 0) {
    console.log(
      `OK: ${definerFunctions.length} SECURITY DEFINER function(s) checked ` +
      `across ${files.length} migration(s), no FORCE RLS conflicts.`
    );
    process.exit(0);
  }

  console.error(
    `FOUND ${problems.length} SECURITY DEFINER function(s) targeting a table ` +
    `with FORCE ROW LEVEL SECURITY still enabled:\n`
  );
  for (const p of problems) {
    console.error(
      `  - ${p.fn}() (defined in ${p.definedIn}) reads table(s) with FORCE RLS: ` +
      `${p.forcedTables.join(", ")}`
    );
    console.error(
      `    Fix: ALTER TABLE ${p.forcedTables.join(", ")} NO FORCE ROW LEVEL SECURITY; ` +
      `(new migration, see security-definer-needs-no-force-rls memory)`
    );
  }
  process.exit(1);
}

main();
