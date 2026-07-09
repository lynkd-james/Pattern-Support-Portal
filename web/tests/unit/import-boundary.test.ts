// =============================================================================
// Import-boundary guard (Stage 10a): the admin and customer realms are fully
// isolated — NEITHER may import the other. Shared infrastructure lives in
// src/lib and src/server/{auth,db,env,logger,apiError,...}. This test walks the
// source of each tree and asserts no cross-realm import edge exists, in either
// direction. It is the executable form of the namespace-isolation directive.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..", "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Import specifiers referenced by a source file (import ... from "x" + dynamic import("x")). */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** A dir tree that exists under src (skip if absent so the test is robust pre-UI). */
function treeFiles(...segments: string[]): string[] {
  const dir = join(SRC, ...segments);
  try {
    return statSync(dir).isDirectory() ? walk(dir) : [];
  } catch {
    return [];
  }
}

describe("realm import isolation (admin <-> customer)", () => {
  // Admin code = server/admin + app/api/admin + app/admin + the 10b UI trees
  // (components/admin, lib/admin — tightened BEFORE any UI file exists).
  const adminFiles = [
    ...treeFiles("server", "admin"),
    ...treeFiles("app", "api", "admin"),
    ...treeFiles("app", "admin"),
    ...treeFiles("components", "admin"),
    ...treeFiles("lib", "admin"),
  ];
  // Customer code = server/customer + app/api/{tickets,session} + components/dashboard.
  const customerFiles = [
    ...treeFiles("server", "customer"),
    ...treeFiles("app", "api", "tickets"),
    ...treeFiles("app", "api", "session"),
    ...treeFiles("components", "dashboard"),
  ];

  it("has admin files to check (guards against an empty-glob false pass)", () => {
    expect(adminFiles.length).toBeGreaterThan(0);
    expect(customerFiles.length).toBeGreaterThan(0);
  });

  // Customer code lives under server/customer/ (+ the customer API route dirs,
  // which are never import targets). Admin code lives under server/admin/.
  const importsCustomer = (spec: string) => /(^|\/)customer\//.test(spec);
  const importsAdmin = (spec: string) => /(^|\/)admin\//.test(spec);

  it("no admin file imports customer code", () => {
    const offenders: string[] = [];
    for (const f of adminFiles) {
      for (const spec of importsOf(f)) {
        if (importsCustomer(spec)) offenders.push(`${f} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no customer file imports admin code", () => {
    const offenders: string[] = [];
    for (const f of customerFiles) {
      for (const spec of importsOf(f)) {
        if (importsAdmin(spec)) offenders.push(`${f} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
