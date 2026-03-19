# Zotero MCP: Agentic Experience Review

An analysis of the Zotero Assistant MCP through the lens of agent-friendly design principles — minimizing context pollution, maximizing tool clarity, and ensuring token-efficient responses.

---

## Current State

- **22 tools** registered
- **2 tools** with 17-20 parameters each (`save_item`, `update_item`)
- **3 tools** for reading attachments (`read_attachment`, `get_attachment_content`, `get_item_fulltext`)
- **1 tool** (`get_help`) with ~4KB of embedded workflow guidance
- Estimated schema injection: **~15-20KB** per agent session

---

## Issue 1: Tool Count — Consolidation Opportunities

**Problem:** 22 tools is moderate but several are redundant or rarely useful standalone. Every tool definition consumes context window tokens regardless of whether the agent uses it.

**Redundant tools:**

| Keep | Merge/Remove | Rationale |
|------|-------------|-----------|
| `read_attachment` | `get_attachment_content`, `get_item_fulltext` | `read_attachment` already auto-detects type and routes correctly. The other two are now low-level fallbacks that create decision paralysis. |
| `search_items` | `get_recent_items` | `search_items` with `sort=dateAdded&direction=desc` does the same thing. `get_recent_items` is a convenience wrapper that costs a tool slot. |
| `save_item` | `attach_pdf`, `attach_snapshot`, `attach_file` (partially) | `save_item` already accepts `pdf_url`, `snapshot_url`, `file_base64`. The standalone attach tools are only needed for adding to *existing* items. Consider merging into one `attach` tool with a `type` param. |
| — | `prepare_url` | This tool returns instructions, not data. It's a meta-tool that coaches the agent on what to do next. This guidance belongs in `server_instructions` or `get_help`, not as a tool call that costs a round-trip. |
| — | `get_item_types` | Returns a static list. This should be in `server_instructions` or help text, not a tool. |

**Recommendation:** Consolidate to **14-16 tools**:
1. Remove `prepare_url` and `get_item_types` (move content to server instructions)
2. Remove `get_recent_items` (redundant with `search_items`)
3. Remove `get_attachment_content` and `get_item_fulltext` (superseded by `read_attachment`)
4. Merge `attach_pdf` + `attach_snapshot` + `attach_file` into one `attach` tool with `source_type` enum (url_pdf, url_snapshot, base64)

---

## Issue 2: Schema Weight — Verbose Descriptions

**Problem:** Tool descriptions contain embedded workflow instructions that should live elsewhere.

**Worst offender — `save_item` (293 chars):**
```
"Create a new item in your Zotero library. WORKFLOW: 1) Fetch and read source
content thoroughly. 2) Extract ALL metadata: title, authors, date, abstract,
publisher. 3) Generate 2-5 descriptive tags. 4) Call list_collections for the
right folder. 5) If confident -> proceed. If uncertain -> ask user first.
ATTACHMENTS: Include pdf_url for PDFs, snapshot_url for webpages."
```

This 5-step workflow is injected into the context window for *every conversation*, whether or not the agent saves anything. It should be in `server_instructions` or `get_help`.

**Recommended description style — terse, action-oriented:**
```
"Create a new item in the Zotero library with metadata and optional attachments."
```

**Other verbose descriptions to trim:**
- `read_attachment`: 257 chars with "PREFERRED" and behavioral explanation
- `get_attachment_content`: 200 chars with cross-references to other tools
- `attach_file`: 170 chars with use-case guidance
- `update_item`: 156 chars

**Principle:** Descriptions should say *what* a tool does in one sentence. *How* and *when* to use it belongs in `server_instructions`.

---

## Issue 3: Parameter Explosion

**Problem:** `update_item` has 20 parameters. `save_item` has 17. Large parameter schemas increase context window cost and make it harder for the model to select the right parameters.

**`update_item` parameters (20):**
```
item_key, title, url, doi, publication, volume, issue, pages,
creators (complex nested), tags, add_tags, remove_tags,
collections, add_collections, remove_collections,
abstract, date, extra
```

**Options to reduce:**
1. **Group related params into objects:** Instead of 6 separate tag/collection params, accept one `tags` object: `{ set?: string[], add?: string[], remove?: string[] }`. Same for collections. Cuts 6 params to 2.
2. **Accept a flat patch object:** One `changes` param that's a JSON object with any fields to update. The agent writes `{ "title": "New Title", "doi": "10.1234/..." }`. This mirrors the Zotero PATCH API directly and reduces the schema to 2 params (`item_key`, `changes`).

**`save_item` similarly:** `pdf_url`, `snapshot_url`, `file_base64`, `file_name` could be one `attachment` object: `{ type: "pdf_url"|"snapshot_url"|"file", value: "...", filename?: "..." }`.

---

## Issue 4: Response Token Efficiency

**`getItem` is the main offender.** It uses `...data` (spread) to dump the entire Zotero API item object into the response. A typical journal article returns 30+ fields including empty ones (`archiveLocation: ""`, `libraryCatalog: ""`, `rights: ""`, etc.). This can be 500-1000 tokens per item.

**Recommendation:** Curate the response to agent-relevant fields only:
```
key, version, title, itemType, creators, date, url, doi,
abstractNote, publicationTitle, volume, issue, pages,
tags, collections, extra, children
```

Drop: `dateAdded`, `dateModified`, `accessDate`, `shortTitle`, `language`, `libraryCatalog`, `callNumber`, `archive`, `archiveLocation`, `rights`, `series`, `seriesTitle`, `seriesText`, `journalAbbreviation`, `ISSN`, `PMID`, `PMCID`, and any other empty/rarely-useful fields.

**Other tools are good:** `searchItems` uses `formatItemSummary` (7 lean fields), `getLibraryStats` is compact, `readAttachment` smart-gates binary content.

---

## Issue 5: `nextSteps` Arrays — Guidance vs. Bloat

**6 tools** append `nextSteps` arrays to their responses:
```json
{
  "success": true,
  "item_key": "ABC123",
  "nextSteps": [
    "Use attach_pdf, attach_snapshot, or attach_file to add attachments",
    "Use create_note to add analysis or summary",
    "Use get_item to verify the saved metadata"
  ]
}
```

**Trade-off:** These help agents chain actions correctly, but they add ~50-100 tokens per tool response and are repetitive across calls. An agent that saves 10 items gets the same 3 suggestions 10 times.

**Recommendation:** Move this guidance to `server_instructions`. The agent should learn the workflow once, not be reminded on every response.

---

## Issue 6: Missing `server_instructions`

**Problem:** The MCP spec supports a `server_instructions` field — a one-time "user manual" injected at initialization. This MCP doesn't use it. Instead, guidance is scattered across:
- Tool descriptions (workflow steps in `save_item`)
- `get_help` tool (requires a tool call to access)
- `nextSteps` arrays (repeated on every response)
- `prepare_url` tool (an entire tool that just returns instructions)

**Recommendation:** Add `server_instructions` to the McpServer config:
```typescript
server = new McpServer({
  name: "zotero-assistant",
  version: "0.4.0",
  instructions: `Zotero library management server.

Workflows:
- To save a URL: fetch content, extract metadata, call save_item with tags and collection_id
- To read attachments: use read_attachment (works with parent or attachment key)
- To browse: search_items for queries, list_collections for folders, get_library_stats for overview

Supported item types: article, book, chapter, conference, thesis, report, webpage, blog, news, magazine, document, video, podcast, presentation

Tips:
- Always include 2-5 descriptive tags when saving
- Use read_attachment instead of get_attachment_content or get_item_fulltext
- Authors can be organizations (e.g. "WHO") — they'll be stored as institutional creators
- Tag arrays use AND logic (items matching ALL tags)`
});
```

This replaces: `prepare_url` tool, `get_item_types` tool, the workflow embedded in `save_item`'s description, and the `nextSteps` arrays.

---

## Issue 7: `get_help` — Tool Call Overhead

**Problem:** `get_help` contains ~4KB of structured workflow guidance across 5 topics. But accessing it requires a tool call round-trip. Most agents won't call it proactively — they'll try tools directly and struggle.

**If `server_instructions` is adopted:** `get_help` becomes less critical. The essential guidance is injected once at init. `get_help` could then serve as a deeper reference for edge cases, or be removed entirely.

**If `server_instructions` is not adopted:** `get_help` should be called automatically. Consider whether the MCP framework supports an "auto-call on init" pattern, or document in the server description that agents should call `get_help` first.

---

## Issue 8: Tool Naming Inconsistency

Minor but worth noting:
- `read_attachment` uses `read_` prefix
- `get_attachment_content` uses `get_` prefix
- Both are "read" operations on attachments

If both tools are kept, the naming collision creates ambiguity. If consolidated (recommended), this resolves itself.

---

## Prioritized Recommendations

| Priority | Change | Impact | Effort |
|----------|--------|--------|--------|
| 1 | Add `server_instructions` with workflow guidance | Eliminates need for `prepare_url`, `get_item_types`, embedded workflows, and `nextSteps` | Low |
| 2 | Remove `prepare_url` and `get_item_types` tools | -2 tools from schema | Low |
| 3 | Curate `getItem` response (drop empty/unused fields) | 40-60% smaller responses | Low |
| 4 | Trim tool descriptions to one sentence each | ~50% reduction in schema tokens | Low |
| 5 | Remove `get_attachment_content` and `get_item_fulltext` | -2 tools, eliminates confusion | Low |
| 6 | Remove `get_recent_items` | -1 tool | Low |
| 7 | Merge 3 attach tools into 1 | -2 tools from schema | Medium |
| 8 | Remove `nextSteps` from responses | Cleaner, smaller responses | Low |
| 9 | Simplify `update_item` params (group tags/collections) | Smaller schema, cleaner interface | Medium |
| 10 | Simplify `save_item` attachment params | Smaller schema | Medium |

**Net result:** 22 tools -> ~14 tools, ~40% smaller schema, cleaner responses, guidance loaded once via `server_instructions` instead of repeated across descriptions and responses.

---

## Summary

The MCP is functionally complete and covers the right workflows. The main improvements are structural: reducing context pollution by consolidating redundant tools, moving guidance from scattered locations into `server_instructions`, trimming verbose descriptions, and curating `getItem` responses. These changes don't remove any capability — they make the same capabilities cheaper and clearer for agents to use.
