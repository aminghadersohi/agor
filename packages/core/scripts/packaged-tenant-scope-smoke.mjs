/**
 * The tenant scope stores, driven across the REAL package entry points.
 *
 * The ESM build of `@agor/core` is split: entries share root-level chunks, so
 * `@agor/core` and `@agor/core/db` imported as ESM evaluate `db/tenant-scope.ts`
 * and `db/tenant-context.ts` once. The CJS build is not split, so every CJS
 * entry still inlines its own copy, and an ESM and a CJS entry are always two
 * copies. Until the stores were keyed on `Symbol.for`, each copy owned a
 * private `AsyncLocalStorage` and a private proxy-target `WeakMap`, so a scope
 * armed through one copy was invisible to a proxy built by another,
 * `isPostgresDatabaseHandle` could not unwrap the handle it was given, and
 * correctly scoped work was refused (§9, follow-up F4).
 *
 * `tenant-scope.test.ts` reproduces that duplication in one process with
 * `vi.resetModules()`, which is a faithful model and NOT the packaging
 * contract: under vitest `@agor/core` resolves to SOURCE, so the number of
 * copies, the export map, and the `import`/`source` conditions are all
 * different from what a daemon loads. That gap is exactly what hid F4 —
 * the fixture's evidence stopped at `getToken` while production failed
 * earlier and on both dialects — and the wrong-database defect (B1) was found
 * on built modules for the same reason. So this drives `dist`, through the
 * package's own `exports`, with no bundler and no test runner in the way.
 *
 * Run after `pnpm --filter @agor/core build`; CI runs it in the build lane,
 * next to the compiled executor smoke test.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Self-reference through the export map: Node resolves these to `dist`
// exactly as a daemon does, because the `source` condition is not set here.
const require = createRequire(import.meta.url);
const [esmRoot, esmDb] = await Promise.all([import('@agor/core'), import('@agor/core/db')]);
const cjsRoot = require('@agor/core');
const cjsDb = require('@agor/core/db');

// --------------------------------------------------------------------------
// 0. The premise. ESM entries share one evaluation; CJS entries, and any ESM
//    entry paired with a CJS one, are separate evaluations of the same module.
// --------------------------------------------------------------------------
assert.equal(
  esmRoot.runWithTenantDatabaseScope,
  esmDb.runWithTenantDatabaseScope,
  'Expected the split ESM build to share one copy of the tenant scope module ' +
    'between `@agor/core` and `@agor/core/db`.'
);
assert.notEqual(
  cjsRoot.runWithTenantDatabaseScope,
  cjsDb.runWithTenantDatabaseScope,
  'Expected the CJS `@agor/core` and `@agor/core/db` to be separate bundled ' +
    'copies. If CJS splitting was enabled, drive the remaining duplication ' +
    '(ESM against CJS) instead of deleting these checks.'
);
assert.notEqual(esmRoot.runWithTenantDatabaseScope, cjsDb.runWithTenantDatabaseScope);

/** A SQLite-shaped handle: `run` is what tells the dialect check it is not PG. */
const sqliteHandle = (name) => ({ run: () => name, marker: () => name });
/** A PostgreSQL-shaped handle: no `run`. Never actually entered here. */
const postgresHandle = () => ({ transaction: async () => undefined });

const pairs = [
  ['CJS root / CJS db', cjsRoot, cjsDb],
  ['ESM root / CJS db', esmRoot, cjsDb],
  ['CJS root / ESM db', cjsRoot, esmDb],
  ['ESM root / ESM db', esmRoot, esmDb],
];

for (const [pair, root, db] of pairs) {
  // --------------------------------------------------------------------------
  // 1. Scope creation. Armed through one entry, read through the other.
  // --------------------------------------------------------------------------
  {
    const base = sqliteHandle('A');
    let seen;
    await root.runWithTenantDatabaseScope(base, 'tenant-a', async () => {
      seen = db.getCurrentTenantId();
    });
    assert.equal(seen, 'tenant-a', 'A scope armed in one entry must be visible in another');
  }

  // --------------------------------------------------------------------------
  // 2. Proxy use. Built by one entry, guarded, admitted by the other's scope.
  // --------------------------------------------------------------------------
  {
    const base = sqliteHandle('A');
    const guarded = db.createTenantScopedDatabaseProxy(base, {
      requireScope: true,
      label: `packaged smoke test (${pair})`,
    });

    assert.throws(
      () => guarded.marker(),
      // Matched by NAME, not `instanceof`: each entry has its own class object,
      // and cross-entry `instanceof` is a separate identity question this test
      // deliberately does not assert. The daemon catches this error inside the
      // copy that threw it.
      (error) => error?.name === 'MissingTenantDatabaseScopeError',
      'A guarded proxy must refuse outside every scope'
    );

    await root.runWithTenantDatabaseScope(base, 'tenant-a', async () => {
      assert.equal(guarded.marker(), 'A', "The other entry's scope must serve this proxy");
    });
  }

  // --------------------------------------------------------------------------
  // 3. Dialect inspection. Across entries, and outside any scope — which is
  //    where F4 actually failed: the first line of `refreshAndPersistToken`.
  // --------------------------------------------------------------------------
  {
    const postgres = db.createTenantScopedDatabaseProxy(postgresHandle(), {
      requireScope: true,
      label: `packaged smoke test (${pair})`,
    });
    const sqlite = db.createTenantScopedDatabaseProxy(sqliteHandle('A'), {
      requireScope: true,
      label: `packaged smoke test (${pair})`,
    });
    assert.equal(
      root.isPostgresDatabaseHandle(postgres),
      true,
      'One entry must be able to unwrap a guarded handle another entry built'
    );
    assert.equal(root.isPostgresDatabaseHandle(sqlite), false);
  }

  // --------------------------------------------------------------------------
  // 4. Identity conflicts. Sharing the stores across copies is what made a
  //    scope on one database reachable from a proxy over another (B1); the
  //    fence is `rootDb`, and it has to hold across entries too.
  // --------------------------------------------------------------------------
  {
    const baseA = sqliteHandle('A');
    const baseB = sqliteHandle('B');
    const proxyB = db.createTenantScopedDatabaseProxy(baseB, {
      requireScope: true,
      label: `packaged smoke test (${pair})`,
    });

    await root.runWithTenantDatabaseScope(baseA, 'tenant-a', async () => {
      assert.throws(
        () => proxyB.marker(),
        (error) => error?.name === 'MissingTenantDatabaseScopeError',
        "A scope opened on database A must not serve database B's proxy"
      );
      // ...and naming B explicitly, from inside A's scope, serves B.
      await db.runWithTenantDatabaseScope(proxyB, 'tenant-a', async () => {
        assert.equal(proxyB.marker(), 'B', "B's own scope must serve B");
      });
    });
  }
}

console.log(`[core] packaged tenant-scope smoke ok (${pairs.length} entry pairs)`);
