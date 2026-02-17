# zotero-assistant-mcp

Zotero library management MCP server for Cloudflare Workers, designed for deployment via [mcp-deploy](https://github.com/upascal/mcp-deploy).

Tools for searching, reading, writing, and managing your Zotero library:
- **Search & Browse** — search items, list collections, browse tags, get recent items
- **Read** — get item metadata, full-text content, attachment content
- **Write** — save items with metadata + attachments, create notes, update items

## How it works

This repo contains only MCP logic. Auth, deployment, and UI are handled by mcp-deploy. The repo ships:

- `src/` — MCP server code (Cloudflare Workers + Durable Objects)
- `mcp-deploy.json` — deployment contract (secrets, config, worker settings)

## Local development

```bash
npm install

# Create .dev.vars with your Zotero credentials:
# ZOTERO_API_KEY=your-api-key
# ZOTERO_LIBRARY_ID=your-library-id

npx wrangler dev
# Health check: http://localhost:8787/
```

Get your credentials at https://www.zotero.org/settings/keys

## Release

Tag a version to trigger the GitHub Actions release workflow:

```bash
git tag v0.3.0
git push --tags
```

This builds `worker.mjs` and publishes it alongside `mcp-deploy.json` as release assets. mcp-deploy fetches these assets to deploy the worker.

## Testing

```bash
npm test
```

Integration tests require a live Zotero library. Set `.dev.vars` with your credentials:

```
ZOTERO_API_KEY=your-api-key
ZOTERO_LIBRARY_ID=your-library-id
```

Tests create temporary items/collections and clean up after themselves.
