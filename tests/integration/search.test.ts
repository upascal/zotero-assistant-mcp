import { describe, it, expect } from "vitest";
import {
  listCollections,
  createCollection,
  searchItems,
  getCollectionItems,
  getRecentItems,
  listTags,
  createItem,
} from "../../src/zotero";
import { apiKey, libraryId, testState, trackItem, trackCollection, sleep } from "./setup";

describe("collections", () => {
  it("listCollections returns array including test collection", async () => {
    const result = await listCollections(apiKey, libraryId);
    expect(Array.isArray(result)).toBe(true);
    const found = result.find((c: any) => c.key === testState.collectionKey);
    expect(found).toBeDefined();
    expect(found.name).toMatch(/^__mcp_test_/);
  });

  it("createCollection creates a nested collection", async () => {
    const result = await createCollection(
      apiKey,
      libraryId,
      "__mcp_test_nested",
      testState.collectionKey
    );
    expect(result.success).toBe(true);
    expect(result.collection_key).toBeTruthy();
    trackCollection(result.collection_key!);
  });

  it("createCollection rejects empty name", async () => {
    const result = await createCollection(apiKey, libraryId, "");
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });
});

describe("search and browse", () => {
  // Create a test item for search tests
  let testItemKey: string;

  it("creates a searchable test item", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_searchable_item",
      itemType: "webpage",
      tags: ["__mcp_test"],
      collectionId: testState.collectionKey,
      url: "https://example.com/test",
    });
    expect(result.success).toBe(true);
    testItemKey = result.item_key;
    trackItem(testItemKey);

    // Brief wait for indexing
    await sleep(2000);
  });

  it("searchItems finds item by text query", async () => {
    const result = await searchItems(apiKey, libraryId, {
      query: "__mcp_test_searchable_item",
    });
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
    expect(result.items![0].title).toContain("__mcp_test_searchable");
  });

  it("searchItems filters by tag", async () => {
    const result = await searchItems(apiKey, libraryId, {
      tag: "__mcp_test",
    });
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
  });

  it("searchItems respects limit and offset", async () => {
    const result = await searchItems(apiKey, libraryId, {
      limit: 1,
      offset: 0,
    });
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBeLessThanOrEqual(1);
  });

  it("getCollectionItems returns items in test collection", async () => {
    const result = await getCollectionItems(
      apiKey,
      libraryId,
      testState.collectionKey,
      {}
    );
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
  });

  it("getRecentItems returns items", async () => {
    const result = await getRecentItems(apiKey, libraryId, { limit: 5 });
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
  });

  it("listTags returns tags including test tag", async () => {
    const result = await listTags(apiKey, libraryId, { limit: 500 });
    expect(result.tags).toBeDefined();
    const found = result.tags!.find((t: any) => t.tag === "__mcp_test");
    expect(found).toBeDefined();
  });
});
