import { describe, it, expect } from "vitest";
import {
  createItem,
  getItem,
  updateItem,
  searchItems,
  attachSnapshot,
  getAttachmentContent,
  getLibraryStats,
  listCollections,
} from "../../src/zotero";
import { apiKey, libraryId, testState, trackItem, trackCollection } from "./setup";

describe("getAttachmentContent", () => {
  let parentKey: string;
  let snapshotKey: string;

  it("creates a parent item and attaches a snapshot", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_attachment_content",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test"],
    });
    expect(result.success).toBe(true);
    parentKey = result.item_key;
    trackItem(parentKey);

    const snap = await attachSnapshot(
      apiKey,
      libraryId,
      parentKey,
      "https://httpbin.org/html",
      "HTTPBin Test"
    );
    if (!snap.success) console.log("snapshot error:", snap.error);
    expect(snap.success).toBe(true);
    snapshotKey = snap.attachment_key!;
    trackItem(snapshotKey);
  });

  it("reads HTML snapshot content", async () => {
    const result = await getAttachmentContent(apiKey, libraryId, snapshotKey);
    expect(result.error).toBeUndefined();
    expect(result.content).toBeTruthy();
    expect(result.contentType).toContain("html");
    expect(result.content).toContain("<");
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it("returns error for non-attachment item", async () => {
    const result = await getAttachmentContent(apiKey, libraryId, parentKey);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not an attachment");
  });

  it("returns error for nonexistent key", async () => {
    const result = await getAttachmentContent(apiKey, libraryId, "ZZZZZZZZ");
    expect(result.error).toBeDefined();
  });
});

describe("getLibraryStats", () => {
  it("returns library overview", async () => {
    const result = await getLibraryStats(apiKey, libraryId);
    expect(result.error).toBeUndefined();
    expect(result.total_items).toBeGreaterThanOrEqual(1);
    expect(result.total_collections).toBeGreaterThanOrEqual(1);
    expect(result.collections).toBeDefined();
    expect(Array.isArray(result.collections)).toBe(true);
    expect(result.top_tags).toBeDefined();
    expect(Array.isArray(result.top_tags)).toBe(true);
    expect(result.last_modified_item).toBeDefined();
  });
});

describe("update_item collection management", () => {
  let itemKey: string;
  let secondCollectionKey: string;

  it("creates a test item and a second collection", async () => {
    const item = await createItem(apiKey, libraryId, {
      title: "__mcp_test_collection_move",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test"],
    });
    expect(item.success).toBe(true);
    itemKey = item.item_key;
    trackItem(itemKey);

    // Create a second collection
    const collections = await listCollections(apiKey, libraryId);
    // Find a non-test collection to use, or create one
    const { createCollection } = await import("../../src/zotero");
    const col = await createCollection(
      apiKey,
      libraryId,
      "__mcp_test_second_collection"
    );
    expect(col.success).toBe(true);
    secondCollectionKey = col.collection_key!;
    trackCollection(secondCollectionKey);
  });

  it("add_collections adds to a new collection without removing from original", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      add_collections: [secondCollectionKey],
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    expect(fetched.collections).toContain(testState.collectionKey);
    expect(fetched.collections).toContain(secondCollectionKey);
  });

  it("remove_collections removes from one collection, keeps the other", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      remove_collections: [testState.collectionKey],
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    expect(fetched.collections).not.toContain(testState.collectionKey);
    expect(fetched.collections).toContain(secondCollectionKey);
  });
});

describe("search_items qmode", () => {
  it("searches with default titleCreatorYear mode", async () => {
    const result = await searchItems(apiKey, libraryId, {
      query: "__mcp_test",
      qmode: "titleCreatorYear",
    });
    expect(result.items).toBeDefined();
    // Should find test items by title
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
  });

  it("searches with everything mode", async () => {
    const result = await searchItems(apiKey, libraryId, {
      query: "__mcp_test",
      qmode: "everything",
    });
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
  });

  it("supports negative tag filter", async () => {
    const result = await searchItems(apiKey, libraryId, {
      tag: "-nonexistent_tag_xyz",
    });
    expect(result.items).toBeDefined();
    // Should return items (none have this tag, so nothing excluded)
    expect(result.items!.length).toBeGreaterThanOrEqual(1);
  });
});
