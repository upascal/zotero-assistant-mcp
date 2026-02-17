/**
 * Shared test setup: loads credentials from .dev.vars,
 * creates a test collection, and cleans up all test data afterward.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll } from "vitest";

// @ts-expect-error — no type declarations
import zoteroApiClient from "zotero-api-client";
const api = (zoteroApiClient as any).default || zoteroApiClient;

// ---- Credentials ----

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "../../.dev.vars");
  const content = readFileSync(path, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

const vars = loadDevVars();
export const apiKey = vars.ZOTERO_API_KEY;
export const libraryId = vars.ZOTERO_LIBRARY_ID;

if (!apiKey || !libraryId) {
  throw new Error("Missing ZOTERO_API_KEY or ZOTERO_LIBRARY_ID in .dev.vars");
}

// ---- Test state ----

export const testState = {
  collectionKey: "",
  createdItemKeys: [] as string[],
  createdCollectionKeys: [] as string[],
};

export function trackItem(key: string) {
  if (key && !testState.createdItemKeys.includes(key)) {
    testState.createdItemKeys.push(key);
  }
}

export function trackCollection(key: string) {
  if (key && !testState.createdCollectionKeys.includes(key)) {
    testState.createdCollectionKeys.push(key);
  }
}

// ---- Zotero client for cleanup ----

function zot() {
  return api(apiKey).library("user", libraryId);
}

// ---- Global setup / teardown ----

beforeAll(async () => {
  const name = `__mcp_test_${Date.now()}`;
  const resp = await zot().collections().post([{ name }]);
  const created = resp.getEntityByIndex(0);
  if (!created) throw new Error("Failed to create test collection");
  testState.collectionKey = created.key;
  trackCollection(created.key);
  console.log(`[test-setup] Created test collection: ${created.key} (${name})`);
});

afterAll(async () => {
  const z = zot();

  // Delete items in batches of 50
  const allKeys = [...testState.createdItemKeys];
  while (allKeys.length > 0) {
    const batch = allKeys.splice(0, 50);
    try {
      // Need version for each item to delete — use the batch endpoint
      // Zotero API: DELETE /users/{id}/items?itemKey=KEY1,KEY2
      const keyParam = batch.join(",");
      const resp = await fetch(
        `https://api.zotero.org/users/${libraryId}/items?itemKey=${keyParam}`,
        {
          method: "DELETE",
          headers: {
            "Zotero-API-Key": apiKey,
            "If-Unmodified-Since-Version": "9999999",
          },
        }
      );
      console.log(`[test-cleanup] Deleted ${batch.length} items: ${resp.status}`);
    } catch (err: any) {
      console.log(`[test-cleanup] Item delete error: ${err.message}`);
    }
  }

  // Delete collections
  for (const key of testState.createdCollectionKeys) {
    try {
      const resp = await fetch(
        `https://api.zotero.org/users/${libraryId}/collections/${key}`,
        {
          method: "DELETE",
          headers: {
            "Zotero-API-Key": apiKey,
            "If-Unmodified-Since-Version": "9999999",
          },
        }
      );
      console.log(`[test-cleanup] Deleted collection ${key}: ${resp.status}`);
    } catch (err: any) {
      console.log(`[test-cleanup] Collection delete error: ${err.message}`);
    }
  }
});

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
