import { describe, it, expect } from "vitest";
import {
  createItem,
  createNote,
  updateItem,
  getItem,
  attachSnapshot,
  attachPdfFromUrl,
} from "../../src/zotero";
import { apiKey, libraryId, testState, trackItem } from "./setup";

describe("createItem", () => {
  it("creates a journal article with full metadata", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_journal_article",
      itemType: "article",
      authors: ["Jane Doe", "John Smith"],
      date: "2025-01-15",
      url: "https://example.com/test-article",
      abstract: "Test abstract for integration test.",
      publication: "Test Journal",
      volume: "42",
      issue: "3",
      pages: "100-110",
      doi: "10.1234/test.2025",
      tags: ["__mcp_test", "integration"],
      collectionId: testState.collectionKey,
    });
    // Log error if it fails so we can debug
    if (!result.success) console.log("createItem error:", result.error);
    expect(result.success).toBe(true);
    expect(result.item_key).toBeTruthy();
    trackItem(result.item_key);

    // Verify via getItem
    const fetched = await getItem(apiKey, libraryId, result.item_key);
    expect(fetched.title).toBe("__mcp_test_journal_article");
    expect(fetched.itemType).toBe("journalArticle");
    expect(fetched.creators.length).toBe(2);
  });

  it("creates a book with minimal metadata", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_book",
      itemType: "book",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test"],
    });
    expect(result.success).toBe(true);
    trackItem(result.item_key);
  });

  it("creates a webpage (default type)", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_webpage",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test"],
    });
    expect(result.success).toBe(true);
    trackItem(result.item_key);

    const fetched = await getItem(apiKey, libraryId, result.item_key);
    expect(fetched.itemType).toBe("webpage");
  });

  it("returns error for invalid item type", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "Should fail",
      itemType: "totallyBogusType",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid item type");
  });
});

describe("createNote", () => {
  let parentKey: string;

  it("creates a parent item for notes", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_note_parent",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test"],
    });
    expect(result.success).toBe(true);
    parentKey = result.item_key;
    trackItem(parentKey);
  });

  it("attaches a note to an existing item", async () => {
    const result = await createNote(
      apiKey,
      libraryId,
      parentKey,
      "<p>Test note from integration suite</p>",
      ["__mcp_test"]
    );
    expect(result.success).toBe(true);
    expect(result.item_key).toBeTruthy();
    trackItem(result.item_key!);

    // Verify note appears as child
    const parent = await getItem(apiKey, libraryId, parentKey);
    const noteChild = parent.children.find(
      (c: any) => c.key === result.item_key
    );
    expect(noteChild).toBeDefined();
    expect(noteChild.itemType).toBe("note");
  });
});

describe("updateItem", () => {
  let itemKey: string;

  it("creates an item to update", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_update_target",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test", "original_tag"],
    });
    expect(result.success).toBe(true);
    itemKey = result.item_key;
    trackItem(itemKey);
  });

  it("updates title", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      title: "__mcp_test_updated_title",
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    expect(fetched.title).toBe("__mcp_test_updated_title");
  });

  it("updates abstract and date", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      abstract: "Updated abstract",
      date: "2025-06-01",
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    expect(fetched.abstractNote).toBe("Updated abstract");
    expect(fetched.date).toBe("2025-06-01");
  });

  it("adds tags without removing existing ones", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      add_tags: ["new_tag_1", "new_tag_2"],
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    const tags = fetched.tags.map((t: any) => t.tag || t);
    expect(tags).toContain("__mcp_test");
    expect(tags).toContain("original_tag");
    expect(tags).toContain("new_tag_1");
    expect(tags).toContain("new_tag_2");
  });

  it("removes specific tags", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      remove_tags: ["new_tag_2"],
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    const tags = fetched.tags.map((t: any) => t.tag || t);
    expect(tags).toContain("new_tag_1");
    expect(tags).not.toContain("new_tag_2");
  });

  it("replaces all tags", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      tags: ["replaced_tag"],
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    const tags = fetched.tags.map((t: any) => t.tag || t);
    expect(tags).toEqual(["replaced_tag"]);
  });

  it("updates extra field", async () => {
    const result = await updateItem(apiKey, libraryId, itemKey, {
      extra: "Custom extra field content",
    });
    expect(result.success).toBe(true);

    const fetched = await getItem(apiKey, libraryId, itemKey);
    expect(fetched.extra).toBe("Custom extra field content");
  });
});

describe("attachments", () => {
  let parentKey: string;

  it("creates a parent item for attachments", async () => {
    const result = await createItem(apiKey, libraryId, {
      title: "__mcp_test_attachment_parent",
      collectionId: testState.collectionKey,
      tags: ["__mcp_test"],
    });
    expect(result.success).toBe(true);
    parentKey = result.item_key;
    trackItem(parentKey);
  });

  it("attaches an HTML snapshot", async () => {
    const result = await attachSnapshot(
      apiKey,
      libraryId,
      parentKey,
      "https://httpbin.org/html",
      "HTTPBin HTML Test"
    );
    // Log error for debugging if it fails
    if (!result.success) console.log("attachSnapshot error:", result.error);
    expect(result.success).toBe(true);
    expect(result.attachment_key).toBeTruthy();
    expect(result.filename).toContain(".html");
    trackItem(result.attachment_key!);
  });

  it("attaches a PDF from URL", async () => {
    const result = await attachPdfFromUrl(
      apiKey,
      libraryId,
      parentKey,
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      "test-dummy.pdf"
    );
    expect(result.success).toBe(true);
    expect(result.attachment_key).toBeTruthy();
    expect(result.size_bytes).toBeGreaterThan(0);
    trackItem(result.attachment_key!);
  });

  it("verifies attachments appear as children", async () => {
    const parent = await getItem(apiKey, libraryId, parentKey);
    expect(parent.children.length).toBeGreaterThanOrEqual(1);
    const types = parent.children.map((c: any) => c.itemType);
    expect(types).toContain("attachment");
  });
});
