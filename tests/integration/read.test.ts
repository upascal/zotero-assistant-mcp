import { describe, it, expect } from "vitest";
import { getItem, getItemFulltext, createItem } from "../../src/zotero";
import { apiKey, libraryId, testState, trackItem } from "./setup";

describe("read operations", () => {
  let testItemKey: string;

  it("creates a test item for read tests", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_read_item",
      itemType: "webpage",
      tags: ["__mcp_test"],
      collectionId: testState.collectionKey,
      url: "https://example.com/read-test",
    });
    expect(result.success).toBe(true);
    testItemKey = result.item_key;
    trackItem(testItemKey);
  });

  it("getItem returns full metadata with children array", async () => {
    const result = await getItem(apiKey, libraryId, testItemKey);
    expect(result.key).toBe(testItemKey);
    expect(result.title).toBe("__mcp_test_read_item");
    expect(result.itemType).toBe("webpage");
    expect(result.children).toBeDefined();
    expect(Array.isArray(result.children)).toBe(true);
  });

  it("getItem returns error for nonexistent key", async () => {
    const result = await getItem(apiKey, libraryId, "ZZZZZZZZ");
    expect(result.error).toBeDefined();
  });

  it("getItemFulltext returns null content for item without fulltext", async () => {
    const result = await getItemFulltext(apiKey, libraryId, testItemKey);
    expect(result.item_key).toBe(testItemKey);
    expect(result.content).toBeNull();
    expect(result.message).toContain("No full-text");
  });
});
