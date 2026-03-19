/**
 * Zotero MCP Server (mcp-deploy compatible)
 *
 * A remote Zotero management tool using the Cloudflare Agents SDK
 * and zotero-api-client. Supports search, read, write, and manage operations.
 *
 * Credentials are stored as Wrangler secrets:
 *   ZOTERO_API_KEY    — Zotero API key
 *   ZOTERO_LIBRARY_ID — Zotero user library ID
 *
 * Auth is handled by mcp-deploy's wrapper — this worker contains NO auth logic.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Patch global fetch for Cloudflare Workers compatibility.
// The zotero-api-client library passes `cache: 'default'` to every fetch()
// call, but Cloudflare Workers does not support browser cache modes and will
// throw "Unsupported cache mode: default". We intercept and strip it.
// ---------------------------------------------------------------------------
const _origFetch = globalThis.fetch;
globalThis.fetch = function patchedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (init) {
    // Remove the unsupported cache property
    const { cache: _, ...rest } = init as RequestInit & { cache?: string };
    return _origFetch(input, rest);
  }
  return _origFetch(input);
};

import {
  listCollections,
  listGroups,
  createItem,
  attachPdfFromUrl,
  attachFile,
  attachSnapshot,
  searchItems,
  getItem,
  getCollectionItems,
  listTags,
  createNote,
  updateItem,
  createCollection,
  getLibraryStats,
  getNoteContent,
  readAttachment,
  trashItem,
  type ProgressCallback,
} from "./zotero.js";

// -------------------------------------------------------------------------
// Progress notification helper — bridges ProgressCallback to MCP protocol
// -------------------------------------------------------------------------

function makeProgressReporter(extra: any): ProgressCallback {
  const progressToken = extra?._meta?.progressToken;
  return (step: number, total: number, message: string) => {
    extra.sendNotification?.({
      method: "notifications/progress" as const,
      params: {
        progressToken: progressToken ?? "progress",
        progress: step,
        total,
        message,
      },
    });
  };
}

// -------------------------------------------------------------------------
// Server instructions — injected once at init, not per-tool
// -------------------------------------------------------------------------

const SERVER_INSTRUCTIONS = `Zotero library management server. Manages items, attachments, notes, tags, and collections.

SAVING WORKFLOW:
1. Fetch the URL content using your built-in tools
2. Extract metadata: title, authors, date, abstract, DOI, publication
3. Generate 2-5 descriptive tags
4. Call list_collections to find the right collection
5. Call save_item with metadata + attachment (pdf_url, snapshot_url, or file_base64/file_name)

READING ATTACHMENTS:
- Use read_attachment with any item key (parent or attachment) — it auto-detects type and extracts content
- For notes, use get_note

ITEM TYPES: article, book, chapter, conference, thesis, report, webpage, blog, news, magazine, document, legal, case, patent, video, podcast, presentation

SEARCH TIPS:
- Tag arrays use AND logic: tag: ['AI', 'ethics'] matches items with ALL tags
- Prefix with - to exclude: tag: '-reviewed'
- date_from/date_to filter by dateAdded (YYYY-MM-DD)
- sort=dateAdded&direction=desc for recent items

AUTHORS: Can be personal names ("Jane Smith") or organizations ("WHO", "World Health Organization"). Suffixes like "Jr." and "III" are handled automatically.

UPDATING: update_item accepts any combination of: title, url, doi, publication, volume, issue, pages, creators, abstract, date, extra, and tag/collection operations (add_tags, remove_tags, tags, add_collections, remove_collections, collections).

CREATORS FORMAT: Use firstName/lastName for people, name for institutions. creatorType defaults to "author" (also: editor, translator, contributor).

GROUPS:
- Call list_groups to discover available groups and their IDs
- Pass group_id to any tool to operate on a group library instead of the personal library
- Omit group_id to use the personal library (default)`;

// -------------------------------------------------------------------------
// McpAgent — Durable Object that serves the MCP protocol
// -------------------------------------------------------------------------

export class ZoteroMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "zotero-assistant",
    version: "0.5.0",
    instructions: SERVER_INSTRUCTIONS,
  });

  async init() {
    const getCredentials = () => {
      const apiKey = this.env.ZOTERO_API_KEY;
      const libraryId = this.env.ZOTERO_LIBRARY_ID;
      if (!apiKey || !libraryId) {
        throw new Error(
          "Zotero not configured. Set ZOTERO_API_KEY and ZOTERO_LIBRARY_ID as Wrangler secrets. " +
            "Get credentials from: https://www.zotero.org/settings/keys"
        );
      }
      return { apiKey, libraryId };
    };

    // =====================================================================
    // Groups
    // =====================================================================

    this.server.tool(
      "list_groups",
      "List Zotero groups the user belongs to. Returns group IDs for use with group_id params.",
      async () => {
        const { apiKey, libraryId } = getCredentials();
        try {
          const groups = await listGroups(apiKey, libraryId);
          return {
            content: [{ type: "text", text: JSON.stringify(groups, null, 2) }],
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ success: false, error: err.message }) },
            ],
          };
        }
      }
    );

    // =====================================================================
    // Search & Browse
    // =====================================================================

    this.server.tool(
      "search_items",
      "Search the Zotero library by text, tags, type, collection, or date range.",
      {
        query: z.string().optional().describe("Free text search"),
        qmode: z
          .enum(["titleCreatorYear", "everything"])
          .default("titleCreatorYear")
          .describe("Search scope"),
        tag: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Tag filter (array = AND, prefix - to exclude)"),
        item_type: z.string().optional().describe("Item type filter"),
        collection_id: z.string().optional().describe("Collection filter"),
        sort: z.string().default("dateModified").describe("Sort field"),
        direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
        limit: z.number().min(1).max(100).default(25).describe("Max results"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
        date_from: z.string().optional().describe("Items added on/after (YYYY-MM-DD)"),
        date_to: z.string().optional().describe("Items added on/before (YYYY-MM-DD)"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await searchItems(apiKey, libraryId, {
          query: params.query,
          qmode: params.qmode,
          tag: params.tag,
          itemType: params.item_type,
          collectionId: params.collection_id,
          sort: params.sort,
          direction: params.direction,
          limit: params.limit,
          offset: params.offset,
          dateFrom: params.date_from,
          dateTo: params.date_to,
          groupId: params.group_id,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_collection_items",
      "List items in a specific collection.",
      {
        collection_id: z.string().describe("Collection key"),
        sort: z.string().default("dateModified").describe("Sort field"),
        direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
        limit: z.number().min(1).max(100).default(25).describe("Max results"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getCollectionItems(
          apiKey,
          libraryId,
          params.collection_id,
          {
            sort: params.sort,
            direction: params.direction,
            limit: params.limit,
            offset: params.offset,
          },
          params.group_id
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "list_collections",
      "List all collections (folders) in the library.",
      {
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        try {
          const collections = await listCollections(apiKey, libraryId, params.group_id);
          return {
            content: [
              { type: "text", text: JSON.stringify(collections, null, 2) },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ success: false, error: err.message }) },
            ],
          };
        }
      }
    );

    this.server.tool(
      "create_collection",
      "Create a new collection, optionally nested under a parent.",
      {
        name: z.string().describe("Collection name"),
        parent_collection_id: z.string().optional().describe("Parent collection key for nesting"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async ({ name, parent_collection_id, group_id }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await createCollection(apiKey, libraryId, name, parent_collection_id, group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "list_tags",
      "List tags in the library with item counts.",
      {
        limit: z.number().min(1).max(500).default(100).describe("Max tags"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await listTags(apiKey, libraryId, {
          limit: params.limit,
          offset: params.offset,
        }, params.group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_library_stats",
      "Library overview: total items, collections, top tags, and last modified item.",
      {
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getLibraryStats(apiKey, libraryId, params.group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // =====================================================================
    // Read
    // =====================================================================

    this.server.tool(
      "get_item",
      "Get full metadata and children for a single item.",
      {
        item_key: z.string().describe("Zotero item key"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async ({ item_key, group_id }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getItem(apiKey, libraryId, item_key, group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "read_attachment",
      "Read attachment content. Accepts parent item key or attachment key — auto-detects type and extracts content.",
      {
        item_key: z.string().describe("Parent item key or attachment key"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async ({ item_key, group_id }, extra) => {
        const { apiKey, libraryId } = getCredentials();
        const onProgress = makeProgressReporter(extra);
        const result = await readAttachment(apiKey, libraryId, item_key, onProgress, group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_note",
      "Read note content. Pass a note key for one note, or a parent item key for all child notes.",
      {
        item_key: z.string().describe("Note or parent item key"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async ({ item_key, group_id }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getNoteContent(apiKey, libraryId, item_key, group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // =====================================================================
    // Write
    // =====================================================================

    this.server.tool(
      "save_item",
      "Create a new item in the Zotero library with metadata and optional attachment.",
      {
        title: z.string().describe("Item title"),
        item_type: z.string().default("webpage").describe("Item type"),
        authors: z.array(z.string()).optional().describe("Author names"),
        date: z.string().optional().describe("Publication date"),
        url: z.string().optional().describe("URL"),
        abstract: z.string().optional().describe("Abstract or summary"),
        publication: z.string().optional().describe("Journal/publication name"),
        volume: z.string().optional().describe("Volume"),
        issue: z.string().optional().describe("Issue"),
        pages: z.string().optional().describe("Pages"),
        doi: z.string().optional().describe("DOI"),
        tags: z.array(z.string()).optional().describe("Tags"),
        collection_id: z.string().optional().describe("Collection ID"),
        pdf_url: z.string().optional().describe("PDF URL to attach"),
        snapshot_url: z.string().optional().describe("Webpage URL to snapshot"),
        file_base64: z.string().optional().describe("Base64 file content to attach"),
        file_name: z.string().optional().describe("Filename for base64 attachment"),
        extra: z.string().optional().describe("Extra field content"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params, extra) => {
        const { apiKey, libraryId } = getCredentials();
        const onProgress = makeProgressReporter(extra);
        const result = await createItem(apiKey, libraryId, {
          title: params.title,
          itemType: params.item_type,
          authors: params.authors || [],
          date: params.date,
          url: params.url,
          abstract: params.abstract,
          publication: params.publication,
          volume: params.volume,
          issue: params.issue,
          pages: params.pages,
          doi: params.doi,
          tags: params.tags || [],
          collectionId: params.collection_id,
          pdfUrl: params.pdf_url,
          snapshotUrl: params.snapshot_url,
          fileBase64: params.file_base64,
          fileName: params.file_name,
          extra: params.extra,
          groupId: params.group_id,
        }, onProgress);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "attach",
      "Attach a file to an existing Zotero item. Supports PDF URLs, webpage snapshots, and base64 file content.",
      {
        parent_item_key: z.string().describe("Item key to attach to"),
        source_type: z
          .enum(["pdf_url", "snapshot_url", "file"])
          .describe("Attachment type"),
        url: z.string().optional().describe("URL (for pdf_url or snapshot_url types)"),
        content_base64: z.string().optional().describe("Base64 content (for file type)"),
        filename: z.string().optional().describe("Filename"),
        title: z.string().optional().describe("Display title"),
        content_type: z.string().optional().describe("MIME type (auto-detected if omitted)"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params, extra) => {
        const { apiKey, libraryId } = getCredentials();
        const onProgress = makeProgressReporter(extra);
        let result: any;

        switch (params.source_type) {
          case "pdf_url":
            if (!params.url) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "url is required for pdf_url type" }) }] };
            result = await attachPdfFromUrl(apiKey, libraryId, params.parent_item_key, params.url, params.filename, onProgress, params.group_id);
            break;
          case "snapshot_url":
            if (!params.url) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "url is required for snapshot_url type" }) }] };
            result = await attachSnapshot(apiKey, libraryId, params.parent_item_key, params.url, params.title, onProgress, params.group_id);
            break;
          case "file":
            if (!params.content_base64 || !params.filename) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "content_base64 and filename are required for file type" }) }] };
            result = await attachFile(apiKey, libraryId, params.parent_item_key, params.filename, params.content_base64, params.content_type, params.title, onProgress, params.group_id);
            break;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "create_note",
      "Create a note attached to an existing item. Supports HTML content.",
      {
        item_key: z.string().describe("Parent item key"),
        content: z.string().describe("Note text (HTML supported)"),
        tags: z.array(z.string()).optional().describe("Tags"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await createNote(
          apiKey,
          libraryId,
          params.item_key,
          params.content,
          params.tags || [],
          params.group_id
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "update_item",
      "Update metadata on an existing item. Pass only fields to change.",
      {
        item_key: z.string().describe("Item key to update"),
        title: z.string().optional().describe("Title"),
        url: z.string().optional().describe("URL"),
        doi: z.string().optional().describe("DOI"),
        publication: z.string().optional().describe("Publication name"),
        volume: z.string().optional().describe("Volume"),
        issue: z.string().optional().describe("Issue"),
        pages: z.string().optional().describe("Pages"),
        creators: z
          .array(
            z.object({
              firstName: z.string().optional(),
              lastName: z.string().optional(),
              name: z.string().optional(),
              creatorType: z.string().optional(),
            })
          )
          .optional()
          .describe("Replace all creators"),
        tags: z.array(z.string()).optional().describe("Replace all tags"),
        add_tags: z.array(z.string()).optional().describe("Add tags"),
        remove_tags: z.array(z.string()).optional().describe("Remove tags"),
        collections: z.array(z.string()).optional().describe("Replace all collections"),
        add_collections: z.array(z.string()).optional().describe("Add to collections"),
        remove_collections: z.array(z.string()).optional().describe("Remove from collections"),
        abstract: z.string().optional().describe("Abstract"),
        date: z.string().optional().describe("Date"),
        extra: z.string().optional().describe("Extra field"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await updateItem(apiKey, libraryId, params.item_key, {
          title: params.title,
          url: params.url,
          doi: params.doi,
          publication: params.publication,
          volume: params.volume,
          issue: params.issue,
          pages: params.pages,
          creators: params.creators,
          tags: params.tags,
          add_tags: params.add_tags,
          remove_tags: params.remove_tags,
          collections: params.collections,
          add_collections: params.add_collections,
          remove_collections: params.remove_collections,
          abstract: params.abstract,
          date: params.date,
          extra: params.extra,
        }, params.group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "trash_item",
      "Move a note or attachment to trash. Only works on notes/attachments for safety.",
      {
        item_key: z.string().describe("Note or attachment key to trash"),
        group_id: z.string().optional().describe("Group ID (from list_groups). Omit for personal library."),
      },
      async ({ item_key, group_id }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await trashItem(apiKey, libraryId, item_key, group_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );
  }
}

// -------------------------------------------------------------------------
// Worker fetch handler — clean, no auth (mcp-deploy handles auth)
// -------------------------------------------------------------------------

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({ name: "zotero-assistant", version: "0.5.0", status: "ok" }),
        { headers: { "content-type": "application/json" } }
      );
    }

    return (
      ZoteroMCP.serve("/mcp") as {
        fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
      }
    ).fetch(request, env, ctx);
  },
};
