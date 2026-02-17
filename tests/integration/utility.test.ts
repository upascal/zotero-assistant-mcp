import { describe, it, expect } from "vitest";
import { getItemTypes, resolveItemType } from "../../src/zotero";

describe("utility functions", () => {
  it("getItemTypes returns known friendly type names", () => {
    const types = getItemTypes();
    expect(types).toContain("article");
    expect(types).toContain("book");
    expect(types).toContain("webpage");
    expect(types).toContain("thesis");
    expect(types.length).toBeGreaterThan(10);
  });

  it("resolveItemType maps friendly names to Zotero types", () => {
    expect(resolveItemType("article")).toBe("journalArticle");
    expect(resolveItemType("book")).toBe("book");
    expect(resolveItemType("chapter")).toBe("bookSection");
    expect(resolveItemType("conference")).toBe("conferencePaper");
    expect(resolveItemType("blog")).toBe("blogPost");
  });

  it("resolveItemType is case-insensitive", () => {
    expect(resolveItemType("Article")).toBe("journalArticle");
    expect(resolveItemType("BOOK")).toBe("book");
  });

  it("resolveItemType passes through unknown types", () => {
    expect(resolveItemType("journalArticle")).toBe("journalArticle");
    expect(resolveItemType("unknownType")).toBe("unknownType");
  });
});
