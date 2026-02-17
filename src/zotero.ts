/**
 * Zotero API helper — thin wrapper around zotero-api-client.
 *
 * Ported from the local MCP server's zotero.js for Cloudflare Workers.
 * Every public function returns a plain object suitable for MCP tool responses.
 */

// @ts-expect-error — zotero-api-client has no type declarations
import zoteroApiClient from "zotero-api-client";
const api = (zoteroApiClient as any).default || zoteroApiClient;

// -------------------------------------------------------------------------
// Item type mapping
// -------------------------------------------------------------------------

const ITEM_TYPE_MAP: Record<string, string> = {
  article: "journalArticle",
  journal: "journalArticle",
  book: "book",
  chapter: "bookSection",
  conference: "conferencePaper",
  thesis: "thesis",
  report: "report",
  webpage: "webpage",
  blog: "blogPost",
  news: "newspaperArticle",
  magazine: "magazineArticle",
  document: "document",
  legal: "statute",
  case: "case",
  patent: "patent",
  video: "videoRecording",
  podcast: "podcast",
  presentation: "presentation",
};

// -------------------------------------------------------------------------
// URL unwrapping
// -------------------------------------------------------------------------

const WRAPPER_PATTERNS =
  /pdfrenderer|pdf\.svc|htmltopdf|html2pdf|render.*pdf|pdf.*render|webshot|screenshot|snapshot|proxy\.php|fetch\.php/i;

const URL_PARAM_NAMES = ["url", "source", "target", "uri", "link", "src"];

function unwrapUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  const isWrapper = WRAPPER_PATTERNS.test(parsed.pathname);

  for (const param of URL_PARAM_NAMES) {
    const candidate = parsed.searchParams.get(param);
    if (!candidate) continue;
    const decoded = decodeURIComponent(candidate);
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      if (isWrapper) return decoded;
      const segments = parsed.pathname.replace(/^\/|\/$/g, "").split("/");
      if (segments.length >= 2) return decoded;
    }
  }

  return raw;
}

// -------------------------------------------------------------------------
// Zotero client factory
// -------------------------------------------------------------------------

function zotClient(apiKey: string, libraryId: string) {
  return api(apiKey).library("user", libraryId);
}

// -------------------------------------------------------------------------
// Public helpers
// -------------------------------------------------------------------------

export function getItemTypes(): string[] {
  return Object.keys(ITEM_TYPE_MAP);
}

export function resolveItemType(simple: string): string {
  return ITEM_TYPE_MAP[simple.toLowerCase()] || simple;
}

interface ItemSummary {
  key: string;
  title: string;
  itemType: string;
  creators: string | null;
  date: string | null;
  tags: string[];
  url: string | null;
}

function formatItemSummary(raw: any): ItemSummary {
  const d = raw.data || raw;
  const creators = (d.creators || [])
    .map((c: any) =>
      c.name ? c.name : `${c.firstName || ""} ${c.lastName || ""}`.trim()
    )
    .filter(Boolean)
    .join("; ");
  return {
    key: raw.key || d.key,
    title: d.title || "(untitled)",
    itemType: d.itemType,
    creators: creators || null,
    date: d.date || null,
    tags: (d.tags || []).map((t: any) => t.tag || t),
    url: d.url || null,
  };
}

// -------------------------------------------------------------------------
// Collections
// -------------------------------------------------------------------------

export async function listCollections(apiKey: string, libraryId: string) {
  const zot = zotClient(apiKey, libraryId);
  const response = await zot.collections().get();
  const raw = response.raw;
  return raw.map((c: any) => ({
    key: c.key,
    name: c.data.name,
    parent: c.data.parentCollection || null,
  }));
}

export async function createCollection(
  apiKey: string,
  libraryId: string,
  name: string,
  parentCollectionId?: string
) {
  if (!name || !name.trim()) {
    return { success: false, error: "Collection name is required" };
  }

  const zot = zotClient(apiKey, libraryId);
  const data: any = { name: name.trim() };
  if (parentCollectionId) {
    data.parentCollection = parentCollectionId;
  }

  try {
    console.log(
      `[create_collection] Creating collection: "${data.name}"${parentCollectionId ? ` under parent ${parentCollectionId}` : " (top-level)"}`
    );

    const response = await zot.collections().post([data]);
    const created = response.getEntityByIndex(0);

    if (!created) {
      const rawResp = JSON.stringify(response.raw || response);
      console.log(`[create_collection] Failed. API response: ${rawResp}`);
      return {
        success: false,
        error: `Failed to create collection. API response: ${rawResp}`,
      };
    }

    console.log(`[create_collection] Created collection: ${created.key}`);
    return {
      success: true,
      collection_key: created.key,
      name: data.name,
      parent: parentCollectionId || null,
      message: `Created collection: ${data.name}`,
    };
  } catch (err: any) {
    console.log(`[create_collection] Error: ${err.message}\n${err.stack}`);
    return {
      success: false,
      error: `Failed to create collection: ${err.message}`,
    };
  }
}

// -------------------------------------------------------------------------
// Item templates
// -------------------------------------------------------------------------

async function getItemTemplate(itemType: string) {
  const response = await api().template(itemType).get();
  return response.getData();
}

// -------------------------------------------------------------------------
// Create item
// -------------------------------------------------------------------------

interface CreateItemParams {
  title: string;
  itemType?: string;
  authors?: string[];
  date?: string;
  url?: string;
  abstract?: string;
  publication?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  tags?: string[];
  collectionId?: string;
  pdfUrl?: string;
  snapshotUrl?: string;
  extra?: string;
}

export async function createItem(
  apiKey: string,
  libraryId: string,
  params: CreateItemParams
) {
  const {
    title,
    itemType = "webpage",
    authors = [],
    date,
    url,
    abstract,
    publication,
    volume,
    issue,
    pages,
    doi,
    tags = [],
    collectionId,
    pdfUrl,
    snapshotUrl,
    extra,
  } = params;

  const zoteroType = resolveItemType(itemType);

  let template: any;
  try {
    template = await getItemTemplate(zoteroType);
  } catch (err: any) {
    return {
      success: false,
      error: `Invalid item type '${zoteroType}': ${err.message}`,
    };
  }

  // Fill template
  template.title = title;
  if (date) template.date = date;
  if (url && "url" in template) template.url = url;
  if (abstract && "abstractNote" in template) template.abstractNote = abstract;
  if (extra && "extra" in template) template.extra = extra;

  if (publication) {
    if ("publicationTitle" in template) template.publicationTitle = publication;
    else if ("blogTitle" in template) template.blogTitle = publication;
    else if ("websiteTitle" in template) template.websiteTitle = publication;
  }

  if (volume && "volume" in template) template.volume = volume;
  if (issue && "issue" in template) template.issue = issue;
  if (pages && "pages" in template) template.pages = pages;
  if (doi && "DOI" in template) template.DOI = doi;

  // Authors
  if (authors.length > 0 && "creators" in template) {
    template.creators = authors.map((name: string) => {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return {
          creatorType: "author",
          firstName: parts.slice(0, -1).join(" "),
          lastName: parts[parts.length - 1],
        };
      }
      return { creatorType: "author", name };
    });
  }

  // Tags
  if (tags.length > 0) {
    template.tags = tags.map((t: string) => ({ tag: t }));
  }

  // Collection
  if (collectionId) {
    template.collections = [collectionId];
  }

  // Create
  const zot = zotClient(apiKey, libraryId);
  try {
    const response = await zot.items().post([template]);

    const successful = response.getEntityByIndex(0);
    if (!successful) {
      return {
        success: false,
        error: `Failed to create item: ${JSON.stringify(response.raw)}`,
      };
    }

    const itemKey = successful.key;
    const result: any = {
      success: true,
      item_key: itemKey,
      message: `Created ${zoteroType}: ${title}`,
    };

    // Attach PDF (takes priority)
    if (pdfUrl) {
      result.pdf_attachment = await attachPdfFromUrl(
        apiKey,
        libraryId,
        itemKey,
        pdfUrl
      );
    } else if (snapshotUrl) {
      result.snapshot_attachment = await attachSnapshot(
        apiKey,
        libraryId,
        itemKey,
        snapshotUrl
      );
    }

    return result;
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------------------
// Attach PDF
// -------------------------------------------------------------------------

export async function attachPdfFromUrl(
  apiKey: string,
  libraryId: string,
  parentItemKey: string,
  pdfUrl: string,
  filename?: string
) {
  pdfUrl = unwrapUrl(pdfUrl);

  try {
    console.log(`[attach_pdf] Fetching PDF from: ${pdfUrl}`);
    const response = await fetch(pdfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AddToZoteroMCP/1.0)",
      },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to download PDF: HTTP ${response.status} ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    console.log(
      `[attach_pdf] Response content-type: ${contentType}, status: ${response.status}`
    );

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0) {
      return { success: false, error: "Downloaded PDF is empty (0 bytes)" };
    }

    const isPdfContent =
      contentType.includes("pdf") || contentType.includes("octet-stream");
    if (!isPdfContent) {
      console.log(
        `[attach_pdf] Warning: content-type "${contentType}" may not be a PDF. Buffer size: ${buffer.length}`
      );
    }

    // Determine filename
    if (!filename) {
      const cd = response.headers.get("content-disposition") || "";
      if (cd.includes("filename=")) {
        filename = cd.split("filename=").pop()!.replace(/['"]/g, "").trim();
      } else {
        filename = pdfUrl.split("/").pop()!.split("?")[0];
        if (!filename.endsWith(".pdf")) filename = "attachment.pdf";
      }
    }

    console.log(
      `[attach_pdf] Creating attachment item: ${filename} (${buffer.length} bytes)`
    );

    // Upload via Zotero API
    const zot = zotClient(apiKey, libraryId);
    const attachmentTemplate = {
      itemType: "attachment",
      parentItem: parentItemKey,
      linkMode: "imported_file",
      title: filename,
      contentType: "application/pdf",
      filename,
    };

    const createResp = await zot.items().post([attachmentTemplate]);
    const attachmentItem = createResp.getEntityByIndex(0);

    if (!attachmentItem) {
      const rawResp = JSON.stringify(createResp.raw || createResp);
      return {
        success: false,
        error: `Failed to create attachment item. API response: ${rawResp}`,
      };
    }

    console.log(
      `[attach_pdf] Attachment item created: ${attachmentItem.key}. Uploading file content...`
    );

    const uploadResp = await zot
      .items(attachmentItem.key)
      .attachment(filename, buffer, "application/pdf")
      .post();

    const uploadStatus = uploadResp?.response?.status || uploadResp?.status;
    const uploadOk = uploadResp?.response?.ok ?? uploadResp?.ok;
    console.log(
      `[attach_pdf] Upload response status: ${uploadStatus}, ok: ${uploadOk}`
    );

    if (uploadOk === false) {
      const uploadBody = JSON.stringify(
        uploadResp?.raw || uploadResp?.getData?.() || "unknown"
      );
      return {
        success: false,
        error: `Attachment item created (${attachmentItem.key}) but file upload failed. Status: ${uploadStatus}. Response: ${uploadBody}`,
        attachment_key: attachmentItem.key,
      };
    }

    console.log(
      `[attach_pdf] Successfully attached ${filename} to ${parentItemKey}`
    );
    return {
      success: true,
      filename,
      size_bytes: buffer.length,
      attachment_key: attachmentItem.key,
    };
  } catch (err: any) {
    console.log(`[attach_pdf] Error: ${err.message}\n${err.stack}`);
    return { success: false, error: `Failed to attach PDF: ${err.message}` };
  }
}

// -------------------------------------------------------------------------
// Attach snapshot
// -------------------------------------------------------------------------

export async function attachSnapshot(
  apiKey: string,
  libraryId: string,
  parentItemKey: string,
  url: string,
  title?: string
) {
  url = unwrapUrl(url);

  try {
    console.log(`[attach_snapshot] Fetching page: ${url}`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AddToZoteroMCP/1.0)",
      },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to fetch page: HTTP ${response.status} ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url;
    console.log(
      `[attach_snapshot] Response status: ${response.status}, content-type: ${contentType}, final URL: ${finalUrl}`
    );

    if (response.redirected) {
      console.log(
        `[attach_snapshot] Redirected from ${url} to ${finalUrl}`
      );
    }

    const html = await response.text();

    if (!html || html.length === 0) {
      return { success: false, error: "Fetched page is empty (0 bytes)" };
    }

    const isHtml =
      contentType.includes("html") ||
      html.trim().startsWith("<") ||
      html.trim().startsWith("<!DOCTYPE");
    if (!isHtml) {
      console.log(
        `[attach_snapshot] Warning: response may not be HTML. Content-type: "${contentType}", first 200 chars: ${html.slice(0, 200)}`
      );
    }

    // Determine title
    if (!title) {
      const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = match ? match[1].trim() : url;
    }

    console.log(
      `[attach_snapshot] Page title: "${title}", HTML size: ${html.length} bytes`
    );

    const safeName =
      title.replace(/[^\w\s\-.]/g, "").slice(0, 80).trim() || "snapshot";
    const filename = `${safeName}.html`;
    const buffer = Buffer.from(html, "utf-8");

    // Upload via Zotero API
    const zot = zotClient(apiKey, libraryId);
    const attachmentTemplate = {
      itemType: "attachment",
      parentItem: parentItemKey,
      linkMode: "imported_file",
      title: title,
      contentType: "text/html",
      filename,
    };

    console.log(
      `[attach_snapshot] Creating attachment item: ${filename}`
    );
    const createResp = await zot.items().post([attachmentTemplate]);
    const attachmentItem = createResp.getEntityByIndex(0);

    if (!attachmentItem) {
      const rawResp = JSON.stringify(createResp.raw || createResp);
      return {
        success: false,
        error: `Failed to create attachment item. API response: ${rawResp}`,
      };
    }

    console.log(
      `[attach_snapshot] Attachment item created: ${attachmentItem.key}. Uploading HTML content (${buffer.length} bytes)...`
    );

    const uploadResp = await zot
      .items(attachmentItem.key)
      .attachment(filename, buffer, "text/html")
      .post();

    const uploadStatus = uploadResp?.response?.status || uploadResp?.status;
    const uploadOk = uploadResp?.response?.ok ?? uploadResp?.ok;
    console.log(
      `[attach_snapshot] Upload response status: ${uploadStatus}, ok: ${uploadOk}`
    );

    if (uploadOk === false) {
      const uploadBody = JSON.stringify(
        uploadResp?.raw || uploadResp?.getData?.() || "unknown"
      );
      return {
        success: false,
        error: `Attachment item created (${attachmentItem.key}) but file upload failed. Status: ${uploadStatus}. Response: ${uploadBody}`,
        attachment_key: attachmentItem.key,
      };
    }

    console.log(
      `[attach_snapshot] Successfully attached snapshot to ${parentItemKey}`
    );
    return {
      success: true,
      filename,
      title,
      size_bytes: buffer.length,
      attachment_key: attachmentItem.key,
    };
  } catch (err: any) {
    console.log(`[attach_snapshot] Error: ${err.message}\n${err.stack}`);
    return {
      success: false,
      error: `Failed to attach snapshot: ${err.message}`,
    };
  }
}

// -------------------------------------------------------------------------
// Search & Browse
// -------------------------------------------------------------------------

interface SearchParams {
  query?: string;
  qmode?: string;
  tag?: string | string[];
  itemType?: string;
  collectionId?: string;
  sort?: string;
  direction?: string;
  limit?: number;
  offset?: number;
}

export async function searchItems(
  apiKey: string,
  libraryId: string,
  params: SearchParams
) {
  const {
    query,
    qmode = "titleCreatorYear",
    tag,
    itemType,
    collectionId,
    sort = "dateModified",
    direction = "desc",
    limit = 25,
    offset = 0,
  } = params;

  const zot = zotClient(apiKey, libraryId);
  const reqParams: any = { sort, direction, limit, start: offset };

  if (query) {
    reqParams.q = query;
    reqParams.qmode = qmode;
  }
  if (tag)
    reqParams.tag = Array.isArray(tag) ? tag.join(" || ") : tag;
  if (itemType) reqParams.itemType = resolveItemType(itemType);

  try {
    let response: any;
    if (collectionId) {
      response = await zot
        .collections(collectionId)
        .items()
        .top()
        .get(reqParams);
    } else {
      response = await zot.items().top().get(reqParams);
    }

    const totalResults =
      response.response?.headers?.get("Total-Results") || null;
    const items = (response.raw || [])
      .filter(
        (r: any) =>
          r.data?.itemType !== "attachment" && r.data?.itemType !== "note"
      )
      .map(formatItemSummary);

    return {
      items,
      totalResults: totalResults
        ? parseInt(totalResults, 10)
        : items.length,
      offset,
      limit,
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

export async function getItem(
  apiKey: string,
  libraryId: string,
  itemKey: string
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    const [itemResp, childrenResp] = await Promise.all([
      zot.items(itemKey).get(),
      zot.items(itemKey).children().get(),
    ]);

    const raw = itemResp.raw;
    const data = raw.data || raw;

    const children = (childrenResp.raw || []).map((c: any) => ({
      key: c.key,
      itemType: c.data?.itemType,
      title: c.data?.title || c.data?.note?.slice(0, 100) || null,
      contentType: c.data?.contentType || null,
    }));

    return {
      key: raw.key,
      version: raw.version,
      ...data,
      children,
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

export async function getItemFulltext(
  apiKey: string,
  libraryId: string,
  itemKey: string
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    // First check if this item has fulltext directly
    try {
      const ftResp = await zot.items(itemKey).fulltext().get();
      const ftData = ftResp.getData?.() || ftResp.raw;
      if (ftData?.content) {
        return {
          item_key: itemKey,
          content: ftData.content,
          source: "fulltext_api",
        };
      }
    } catch {
      // No direct fulltext — try children
    }

    // Look for child attachments with fulltext
    const childrenResp = await zot.items(itemKey).children().get();
    const attachments = (childrenResp.raw || []).filter(
      (c: any) => c.data?.itemType === "attachment" && c.data?.contentType
    );

    for (const att of attachments) {
      try {
        const ftResp = await zot.items(att.key).fulltext().get();
        const ftData = ftResp.getData?.() || ftResp.raw;
        if (ftData?.content) {
          return {
            item_key: itemKey,
            attachment_key: att.key,
            content: ftData.content,
            source: "child_attachment_fulltext",
          };
        }
      } catch {
        continue;
      }
    }

    return {
      item_key: itemKey,
      content: null,
      message: "No full-text content available for this item.",
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

export async function getCollectionItems(
  apiKey: string,
  libraryId: string,
  collectionId: string,
  {
    sort = "dateModified",
    direction = "desc",
    limit = 25,
    offset = 0,
  }: { sort?: string; direction?: string; limit?: number; offset?: number }
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    const response = await zot
      .collections(collectionId)
      .items()
      .top()
      .get({ sort, direction, limit, start: offset });

    const totalResults =
      response.response?.headers?.get("Total-Results") || null;
    const items = (response.raw || [])
      .filter(
        (r: any) =>
          r.data?.itemType !== "attachment" && r.data?.itemType !== "note"
      )
      .map(formatItemSummary);

    return {
      items,
      totalResults: totalResults
        ? parseInt(totalResults, 10)
        : items.length,
      offset,
      limit,
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

export async function listTags(
  apiKey: string,
  libraryId: string,
  { limit = 100, offset = 0 }: { limit?: number; offset?: number }
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    const response = await zot.tags().get({ limit, start: offset });
    const tags = (response.raw || []).map((t: any) => ({
      tag: t.tag,
      numItems: t.meta?.numItems || 0,
    }));
    return { tags, offset, limit };
  } catch (err: any) {
    return { error: err.message };
  }
}

export async function getRecentItems(
  apiKey: string,
  libraryId: string,
  { limit = 10, sort = "dateAdded" }: { limit?: number; sort?: string }
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    const response = await zot
      .items()
      .top()
      .get({ sort, direction: "desc", limit });
    const items = (response.raw || [])
      .filter(
        (r: any) =>
          r.data?.itemType !== "attachment" && r.data?.itemType !== "note"
      )
      .map(formatItemSummary);
    return { items };
  } catch (err: any) {
    return { error: err.message };
  }
}

// -------------------------------------------------------------------------
// Notes
// -------------------------------------------------------------------------

export async function createNote(
  apiKey: string,
  libraryId: string,
  parentItemKey: string,
  content: string,
  tags: string[] = []
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    const template = await getItemTemplate("note");
    template.parentItem = parentItemKey;
    template.note = content;
    if (tags.length > 0) {
      template.tags = tags.map((t: string) => ({ tag: t }));
    }

    const response = await zot.items().post([template]);
    const created = response.getEntityByIndex(0);
    if (!created) {
      return { success: false, error: "Failed to create note" };
    }
    return {
      success: true,
      item_key: created.key,
      message: `Note created on item ${parentItemKey}`,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------------------
// Get attachment content
// -------------------------------------------------------------------------

export async function getAttachmentContent(
  apiKey: string,
  libraryId: string,
  itemKey: string
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    // First get the attachment metadata to know what we're dealing with
    const itemResp = await zot.items(itemKey).get();
    const data = itemResp.raw?.data || itemResp.raw;

    if (data.itemType !== "attachment") {
      return {
        error: `Item ${itemKey} is not an attachment (type: ${data.itemType}). Use get_item to find child attachment keys.`,
      };
    }

    const contentType = data.contentType || "";
    const filename = data.filename || data.title || "unknown";

    // Download the file content
    const fileResp = await fetch(
      `https://api.zotero.org/users/${libraryId}/items/${itemKey}/file`,
      {
        headers: { "Zotero-API-Key": apiKey },
        signal: AbortSignal.timeout(60000),
      }
    );

    if (!fileResp.ok) {
      return {
        error: `Failed to download attachment: HTTP ${fileResp.status} ${fileResp.statusText}`,
        item_key: itemKey,
        filename,
        contentType,
      };
    }

    // For text-based content (HTML, plain text, etc.), return as string
    if (
      contentType.includes("html") ||
      contentType.includes("text") ||
      contentType.includes("xml") ||
      contentType.includes("json")
    ) {
      const text = await fileResp.text();
      return {
        item_key: itemKey,
        filename,
        contentType,
        size_bytes: text.length,
        content: text,
      };
    }

    // For binary content (PDFs, images), return metadata only + note about fulltext
    const buffer = await fileResp.arrayBuffer();
    return {
      item_key: itemKey,
      filename,
      contentType,
      size_bytes: buffer.byteLength,
      content: null,
      message: `Binary file (${contentType}). Use get_item_fulltext to retrieve extracted text content if available.`,
    };
  } catch (err: any) {
    return { error: `Failed to get attachment content: ${err.message}` };
  }
}

// -------------------------------------------------------------------------
// Get library stats
// -------------------------------------------------------------------------

export async function getLibraryStats(
  apiKey: string,
  libraryId: string
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    // Run three queries in parallel for efficiency
    const [itemsResp, collectionsResult, tagsResult] = await Promise.all([
      // Get total item count with limit=0 (just headers)
      zot.items().top().get({ limit: 1, sort: "dateModified", direction: "desc" }),
      listCollections(apiKey, libraryId),
      listTags(apiKey, libraryId, { limit: 25, offset: 0 }),
    ]);

    const totalItems = parseInt(
      itemsResp.response?.headers?.get("Total-Results") || "0",
      10
    );

    // Most recent item
    const recentItem = (itemsResp.raw || [])[0];
    const lastModified = recentItem
      ? {
          title: recentItem.data?.title || "(untitled)",
          date: recentItem.data?.dateModified || null,
        }
      : null;

    // Sort tags by count
    const topTags = (tagsResult.tags || [])
      .sort((a: any, b: any) => b.numItems - a.numItems)
      .slice(0, 15);

    return {
      total_items: totalItems,
      total_collections: collectionsResult.length,
      total_tags: topTags.length,
      collections: collectionsResult.map((c: any) => ({
        key: c.key,
        name: c.name,
      })),
      top_tags: topTags,
      last_modified_item: lastModified,
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

// -------------------------------------------------------------------------
// Update item
// -------------------------------------------------------------------------

interface UpdateChanges {
  title?: string;
  abstract?: string;
  date?: string;
  extra?: string;
  tags?: string[];
  add_tags?: string[];
  remove_tags?: string[];
  collections?: string[];
  add_collections?: string[];
  remove_collections?: string[];
}

export async function updateItem(
  apiKey: string,
  libraryId: string,
  itemKey: string,
  changes: UpdateChanges
) {
  const zot = zotClient(apiKey, libraryId);
  try {
    const itemResp = await zot.items(itemKey).get();
    const raw = itemResp.raw;
    const version = raw.version;
    const currentData = raw.data;

    // Build a partial object with only the changed fields
    const patch: Record<string, any> = {};

    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.abstract !== undefined) patch.abstractNote = changes.abstract;
    if (changes.date !== undefined) patch.date = changes.date;
    if (changes.extra !== undefined) patch.extra = changes.extra;

    // Tag handling: replace, add, or remove
    if (changes.tags !== undefined) {
      patch.tags = changes.tags.map((t: string) => ({ tag: t }));
    } else if (changes.add_tags || changes.remove_tags) {
      const existingTags = (currentData.tags || []).map((t: any) => t.tag || t);
      let updated = [...existingTags];
      if (changes.add_tags) {
        for (const t of changes.add_tags) {
          if (!updated.includes(t)) updated.push(t);
        }
      }
      if (changes.remove_tags) {
        updated = updated.filter((t: string) => !changes.remove_tags!.includes(t));
      }
      patch.tags = updated.map((t: string) => ({ tag: t }));
    }

    // Collection handling: replace, add, or remove
    if (changes.collections !== undefined) {
      patch.collections = changes.collections;
    } else if (changes.add_collections || changes.remove_collections) {
      let updated = [...(currentData.collections || [])];
      if (changes.add_collections) {
        for (const c of changes.add_collections) {
          if (!updated.includes(c)) updated.push(c);
        }
      }
      if (changes.remove_collections) {
        updated = updated.filter((c: string) => !changes.remove_collections!.includes(c));
      }
      patch.collections = updated;
    }

    await zot.items(itemKey).version(version).patch(patch);

    return {
      success: true,
      item_key: itemKey,
      message: `Item ${itemKey} updated`,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
