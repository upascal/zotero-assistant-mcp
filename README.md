# zotero-assistant-mcp

Zotero library management MCP server for Cloudflare Workers, designed for deployment via [mcp-deploy](https://github.com/upascal/mcp-deploy).

## Tools (16)

**Groups**
- `list_groups` — list Zotero groups the user belongs to (returns group IDs for use with `group_id` params)

**Search & Browse**
- `search_items` — search by text, tags, type, collection, or date range
- `get_collection_items` — list items in a specific collection
- `list_collections` — list all collections (folders)
- `create_collection` — create a new collection
- `list_tags` — list tags with item counts
- `get_library_stats` — library overview with totals and top tags

**Read**
- `get_item` — full metadata and children for a single item
- `read_attachment` — read attachment content (auto-detects type, accepts parent or attachment key)
- `get_note` — read note content

**Write**
- `save_item` — create an item with metadata and optional attachment (PDF URL, snapshot, or base64 file)
- `attach` — attach a file to an existing item (supports `pdf_url`, `snapshot_url`, or `file` via base64)
- `create_note` — create a note on an existing item
- `update_item` — update metadata, tags, or collections
- `trash_item` — move a note or attachment to trash

All tools that operate on library data accept an optional `group_id` parameter. Omit it for the personal library; pass a group ID (from `list_groups`) to operate on a group library.

## Features

- **Server instructions** — workflow guidance injected once at init, not per-tool
- **Progress notifications** — multi-step operations (attach, save with attachment, read) emit MCP progress events
- **Group library support** — call `list_groups` to discover groups, pass `group_id` to any tool
- **Smart author parsing** — handles "Last, First", suffixes (Jr., III), and institutional authors
- **Curated responses** — `get_item` returns only non-empty, agent-relevant fields; search results are compact summaries

## Deploy

Install [mcp-deploy](https://github.com/upascal/mcp-deploy) and deploy to Cloudflare Workers:

```bash
npm install -g mcp-deploy
mcp-deploy login
mcp-deploy add upascal/zotero-assistant-mcp
mcp-deploy deploy zotero-assistant-mcp
```

Or use the web UI: `mcp-deploy gui`

## How it works

This repo contains only MCP logic. Auth, deployment, and UI are handled by [mcp-deploy](https://github.com/upascal/mcp-deploy) (`npm install -g mcp-deploy`). The repo ships:

- `src/` — MCP server code (Cloudflare Workers + Durable Objects)
- `mcp-deploy.json` — deployment contract (secrets, config, worker settings)

## Configuration

| Secret | Required | Description |
|---|---|---|
| `ZOTERO_API_KEY` | Yes | [Zotero API key](https://www.zotero.org/settings/keys) |
| `ZOTERO_LIBRARY_ID` | Yes | Your numeric user library ID |

## Local development

```bash
npm install

# Create .dev.vars with your Zotero credentials:
# ZOTERO_API_KEY=your-api-key
# ZOTERO_LIBRARY_ID=your-library-id

npx wrangler dev
```

## Testing

```bash
npm test
```

Integration tests run against a live Zotero library. Set `.dev.vars` with your credentials. Tests create temporary items/collections and clean up after themselves.

## Release

Tag a version to trigger the GitHub Actions release workflow:

```bash
git tag v0.5.0
git push --tags
```

This builds `worker.mjs` and publishes it alongside `mcp-deploy.json` as release assets. mcp-deploy fetches these assets to deploy the worker.
