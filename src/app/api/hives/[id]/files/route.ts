import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { canAccessHive } from "@/auth/users";
import { hiveRootPath } from "@/hives/workspace-root";

const FILE_BROWSER_CATEGORIES = [
  "projects",
  "work-products",
  "attachments",
  "generated-docs",
  "ea-files",
] as const;

type FileCategory = (typeof FILE_BROWSER_CATEGORIES)[number];
type FileAction = "list" | "preview" | "download";

const CATEGORY_LABELS: Record<FileCategory, string> = {
  "projects": "Projects",
  "work-products": "Work Products",
  "attachments": "Attachments",
  "generated-docs": "Generated Docs",
  "ea-files": "EA Files",
};

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".log",
  ".yaml",
  ".yml",
]);
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set(["application/json", "application/x-ndjson"]);
const INLINE_PREVIEW_BYTES = 256 * 1024;
const MAX_FS_ITEMS = 200;
const FS_CATEGORIES = new Set<FileCategory>(["projects", "ea-files"]);
const IGNORED_FS_NAMES = new Set([
  ".git",
  ".next",
  ".playwright-mcp",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

type HiveRow = {
  id: string;
  slug: string;
  workspace_path: string | null;
};

type FileItem = {
  id: string;
  name: string;
  category: FileCategory;
  categoryLabel: string;
  source: "filesystem" | "database";
  relativePath: string;
  location: string;
  sizeBytes: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
  type: string;
  extension: string;
  mimeType: string | null;
  previewable: boolean;
  downloadable: boolean;
  previewUrl: string | null;
  downloadUrl: string | null;
};

type FsRoot = {
  root: string;
  locationPrefix: string;
};

function normalizeCategory(raw: string | null): FileCategory | null {
  if (!raw) return "projects";
  return (FILE_BROWSER_CATEGORIES as readonly string[]).includes(raw)
    ? raw as FileCategory
    : null;
}

function normalizeAction(raw: string | null): FileAction | null {
  if (!raw) return "list";
  return raw === "list" || raw === "preview" || raw === "download" ? raw : null;
}

function extensionFor(name: string): string {
  return path.extname(name).toLowerCase();
}

function inferType(name: string, mimeType: string | null): string {
  if (mimeType) return mimeType;
  const ext = extensionFor(name);
  return ext ? ext.slice(1).toUpperCase() : "File";
}

function isTextLike(name: string, mimeType: string | null): boolean {
  const ext = extensionFor(name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (!mimeType) return false;
  return TEXT_MIME_TYPES.has(mimeType) || TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function safeHeaderFilename(filename: string): string {
  return filename.replace(/[\r\n]/g, "_").replace(/"/g, '\\"');
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeRelativePath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid relative path");
  }
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid relative path");
  }
  return normalized;
}

async function resolveContainedPath(root: string, relativePath: string): Promise<string> {
  const normalized = assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (!isPathInside(resolved, resolvedRoot)) {
    throw new Error("Path escaped root");
  }
  const realRoot = await fs.realpath(resolvedRoot);
  const realPath = await fs.realpath(resolved);
  if (!isPathInside(realPath, realRoot)) {
    throw new Error("Path escaped root");
  }
  return realPath;
}

function filesystemRoots(category: FileCategory, hive: HiveRow): FsRoot[] {
  const hiveRoot = hiveRootPath(hive.slug);
  if (category === "projects") {
    return [{ root: path.join(hiveRoot, "projects"), locationPrefix: "projects" }];
  }
  if (category === "ea-files") {
    return [{ root: path.join(hiveRoot, "ea"), locationPrefix: "ea" }];
  }
  return [];
}

function buildFsUrl(hiveId: string, category: FileCategory, action: FileAction, relativePath: string) {
  const params = new URLSearchParams({ category, action, path: relativePath });
  return `/api/hives/${hiveId}/files?${params.toString()}`;
}

function buildDbUrl(hiveId: string, category: FileCategory, action: FileAction, id: string) {
  const params = new URLSearchParams({ category, action, id });
  return `/api/hives/${hiveId}/files?${params.toString()}`;
}

async function listFilesystemCategory(hiveId: string, category: FileCategory, roots: FsRoot[]): Promise<FileItem[]> {
  const items: FileItem[] = [];
  for (const root of roots) {
    if (!existsSync(root.root)) continue;
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root.root);
    } catch {
      continue;
    }
    const pending = [""];
    while (pending.length > 0 && items.length < MAX_FS_ITEMS) {
      const currentRelative = pending.shift() ?? "";
      const currentPath = path.join(root.root, currentRelative);
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (items.length >= MAX_FS_ITEMS) break;
        if (entry.name.startsWith(".") || IGNORED_FS_NAMES.has(entry.name)) continue;
        const relativePath = path.join(currentRelative, entry.name);
        const absolutePath = path.join(root.root, relativePath);
        let stat;
        let realPath: string;
        try {
          stat = await fs.stat(absolutePath);
          realPath = await fs.realpath(absolutePath);
        } catch {
          continue;
        }
        if (!isPathInside(realPath, realRoot)) continue;
        if (stat.isDirectory()) {
          pending.push(relativePath);
          continue;
        }
        if (!stat.isFile()) continue;
        const normalizedRelative = relativePath.split(path.sep).join("/");
        const ext = extensionFor(entry.name);
        const previewable = isTextLike(entry.name, null) && stat.size <= INLINE_PREVIEW_BYTES;
        items.push({
          id: `${category}:${normalizedRelative}`,
          name: entry.name,
          category,
          categoryLabel: CATEGORY_LABELS[category],
          source: "filesystem",
          relativePath: normalizedRelative,
          location: `${root.locationPrefix}/${normalizedRelative}`,
          sizeBytes: stat.size,
          createdAt: toIso(stat.birthtime),
          modifiedAt: toIso(stat.mtime),
          type: inferType(entry.name, null),
          extension: ext,
          mimeType: null,
          previewable,
          downloadable: true,
          previewUrl: previewable ? buildFsUrl(hiveId, category, "preview", normalizedRelative) : null,
          downloadUrl: buildFsUrl(hiveId, category, "download", normalizedRelative),
        });
      }
    }
  }
  return items.sort((a, b) => a.location.localeCompare(b.location));
}

async function listProjects(hiveId: string, hive: HiveRow): Promise<FileItem[]> {
  const fsItems = await listFilesystemCategory(hiveId, "projects", filesystemRoots("projects", hive));
  const projectRows = await sql`
    SELECT id, slug, name, workspace_path, created_at, updated_at
    FROM projects
    WHERE hive_id = ${hive.id}
    ORDER BY name ASC
  `;
  const projectItems = projectRows.map((row) => {
    const r = row as {
      id: string;
      slug: string;
      name: string;
      workspace_path: string | null;
      created_at: Date | string | null;
      updated_at: Date | string | null;
    };
    const relativePath = r.workspace_path ? path.basename(r.workspace_path) : r.slug;
    return {
      id: `project:${r.id}`,
      name: r.name,
      category: "projects" as const,
      categoryLabel: CATEGORY_LABELS.projects,
      source: "database" as const,
      relativePath,
      location: r.workspace_path ?? `projects/${r.slug}`,
      sizeBytes: null,
      createdAt: toIso(r.created_at),
      modifiedAt: toIso(r.updated_at),
      type: "Project workspace",
      extension: "",
      mimeType: null,
      previewable: false,
      downloadable: false,
      previewUrl: null,
      downloadUrl: null,
    };
  });
  return [...projectItems, ...fsItems];
}

async function listWorkProducts(hiveId: string): Promise<FileItem[]> {
  const rows = await sql`
    SELECT id, content, summary, artifact_kind, file_path, mime_type, created_at
    FROM work_products
    WHERE hive_id = ${hiveId}
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return rows.map((row) => {
    const r = row as {
      id: string;
      content: string;
      summary: string | null;
      artifact_kind: string | null;
      file_path: string | null;
      mime_type: string | null;
      created_at: Date | string | null;
    };
    const name = r.file_path ? path.basename(r.file_path) : `${r.artifact_kind ?? "work-product"}-${r.id.slice(0, 8)}.md`;
    const previewable = !r.file_path || isTextLike(name, r.mime_type);
    const downloadable = Boolean(r.file_path);
    return {
      id: r.id,
      name,
      category: "work-products" as const,
      categoryLabel: CATEGORY_LABELS["work-products"],
      source: "database" as const,
      relativePath: r.file_path ?? `work-products/${r.id}`,
      location: r.file_path ?? `work_products.content/${r.id}`,
      sizeBytes: r.file_path ? null : Buffer.byteLength(r.content, "utf8"),
      createdAt: toIso(r.created_at),
      modifiedAt: toIso(r.created_at),
      type: r.artifact_kind ?? inferType(name, r.mime_type),
      extension: extensionFor(name),
      mimeType: r.mime_type,
      previewable,
      downloadable,
      previewUrl: previewable ? buildDbUrl(hiveId, "work-products", "preview", r.id) : null,
      downloadUrl: downloadable ? buildDbUrl(hiveId, "work-products", "download", r.id) : null,
    };
  });
}

async function listAttachments(hiveId: string): Promise<FileItem[]> {
  const rows = await sql`
    SELECT DISTINCT a.id, a.filename, a.storage_path, a.mime_type, a.size_bytes, a.uploaded_at
    FROM task_attachments a
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN goals g ON g.id = a.goal_id
    LEFT JOIN hive_ideas i ON i.id = a.idea_id
    WHERE t.hive_id = ${hiveId} OR g.hive_id = ${hiveId} OR i.hive_id = ${hiveId}
    ORDER BY a.uploaded_at DESC
    LIMIT 200
  `;
  return rows.map((row) => {
    const r = row as {
      id: string;
      filename: string;
      storage_path: string;
      mime_type: string | null;
      size_bytes: number | string | null;
      uploaded_at: Date | string | null;
    };
    const previewable = isTextLike(r.filename, r.mime_type) && Number(r.size_bytes ?? 0) <= INLINE_PREVIEW_BYTES;
    return {
      id: r.id,
      name: r.filename,
      category: "attachments" as const,
      categoryLabel: CATEGORY_LABELS.attachments,
      source: "database" as const,
      relativePath: path.basename(r.storage_path),
      location: r.storage_path,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      createdAt: toIso(r.uploaded_at),
      modifiedAt: toIso(r.uploaded_at),
      type: inferType(r.filename, r.mime_type),
      extension: extensionFor(r.filename),
      mimeType: r.mime_type,
      previewable,
      downloadable: true,
      previewUrl: previewable ? buildDbUrl(hiveId, "attachments", "preview", r.id) : null,
      downloadUrl: buildDbUrl(hiveId, "attachments", "download", r.id),
    };
  });
}

async function listGeneratedDocs(hiveId: string): Promise<FileItem[]> {
  const rows = await sql`
    SELECT d.id, d.document_type, d.title, d.format, d.body, d.created_at, d.updated_at, g.id AS goal_id
    FROM goal_documents d
    JOIN goals g ON g.id = d.goal_id
    WHERE g.hive_id = ${hiveId}
    ORDER BY d.updated_at DESC
    LIMIT 200
  `;
  return rows.map((row) => {
    const r = row as {
      id: string;
      document_type: string;
      title: string;
      format: string;
      body: string;
      created_at: Date | string | null;
      updated_at: Date | string | null;
      goal_id: string;
    };
    const extension = r.format === "json" ? ".json" : ".md";
    const name = `${r.title}${extension}`;
    return {
      id: r.id,
      name,
      category: "generated-docs" as const,
      categoryLabel: CATEGORY_LABELS["generated-docs"],
      source: "database" as const,
      relativePath: `goals/${r.goal_id}/${r.document_type}${extension}`,
      location: `goal_documents.body/${r.id}`,
      sizeBytes: Buffer.byteLength(r.body, "utf8"),
      createdAt: toIso(r.created_at),
      modifiedAt: toIso(r.updated_at),
      type: r.format,
      extension,
      mimeType: r.format === "json" ? "application/json" : "text/markdown",
      previewable: true,
      downloadable: false,
      previewUrl: buildDbUrl(hiveId, "generated-docs", "preview", r.id),
      downloadUrl: null,
    };
  });
}

async function listCategory(hiveId: string, hive: HiveRow, category: FileCategory): Promise<FileItem[]> {
  if (category === "projects") return listProjects(hiveId, hive);
  if (category === "work-products") return listWorkProducts(hiveId);
  if (category === "attachments") return listAttachments(hiveId);
  if (category === "generated-docs") return listGeneratedDocs(hiveId);
  return listFilesystemCategory(hiveId, "ea-files", filesystemRoots("ea-files", hive));
}

async function loadPreviewText(filePath: string, sizeBytes: number): Promise<{ content: string; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(sizeBytes, INLINE_PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return {
      content: buffer.toString("utf8"),
      truncated: sizeBytes > INLINE_PREVIEW_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function previewFilesystem(hive: HiveRow, category: FileCategory, relativePath: string) {
  const root = filesystemRoots(category, hive)[0];
  if (!root) return jsonError("Preview is not supported for this category", 400);
  let filePath: string;
  try {
    filePath = await resolveContainedPath(root.root, relativePath);
  } catch {
    return jsonError("File not found", 404);
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return jsonError("File not found", 404);
  if (!isTextLike(filePath, null)) return jsonError("Preview is not supported for this file type", 415);
  const preview = await loadPreviewText(filePath, stat.size);
  return jsonOk({
    name: path.basename(filePath),
    content: preview.content,
    contentType: extensionFor(filePath) === ".json" ? "application/json" : "text/plain",
    truncated: preview.truncated,
  });
}

async function downloadFilesystem(hive: HiveRow, category: FileCategory, relativePath: string) {
  const root = filesystemRoots(category, hive)[0];
  if (!root) return jsonError("Download is not supported for this category", 400);
  let filePath: string;
  try {
    filePath = await resolveContainedPath(root.root, relativePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return new Response("Not found", { status: 404 });
  const bytes = await fs.readFile(filePath);
  const filename = safeHeaderFilename(path.basename(filePath));
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": isTextLike(filePath, null) ? "text/plain; charset=utf-8" : "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.length),
    },
  });
}

async function previewDatabase(hiveId: string, category: FileCategory, id: string, hive: HiveRow) {
  if (category === "work-products") {
    const [row] = await sql`
      SELECT id, content, file_path, mime_type
      FROM work_products
      WHERE id = ${id} AND hive_id = ${hiveId}
      LIMIT 1
    `;
    if (!row) return jsonError("File not found", 404);
    const r = row as { content: string; file_path: string | null; mime_type: string | null };
    if (r.file_path && !isTextLike(r.file_path, r.mime_type)) {
      return jsonError("Preview is not supported for this file type", 415);
    }
    return jsonOk({
      name: r.file_path ? path.basename(r.file_path) : `work-product-${id}.md`,
      content: r.content,
      contentType: r.mime_type ?? "text/markdown",
      truncated: false,
    });
  }
  if (category === "generated-docs") {
    const [row] = await sql`
      SELECT d.id, d.title, d.format, d.body
      FROM goal_documents d
      JOIN goals g ON g.id = d.goal_id
      WHERE d.id = ${id} AND g.hive_id = ${hiveId}
      LIMIT 1
    `;
    if (!row) return jsonError("File not found", 404);
    const r = row as { title: string; format: string; body: string };
    return jsonOk({
      name: `${r.title}.${r.format === "json" ? "json" : "md"}`,
      content: r.body,
      contentType: r.format === "json" ? "application/json" : "text/markdown",
      truncated: false,
    });
  }
  if (category === "attachments") {
    const [row] = await sql`
      SELECT DISTINCT a.id, a.filename, a.storage_path, a.mime_type, a.size_bytes
      FROM task_attachments a
      LEFT JOIN tasks t ON t.id = a.task_id
      LEFT JOIN goals g ON g.id = a.goal_id
      LEFT JOIN hive_ideas i ON i.id = a.idea_id
      WHERE a.id = ${id} AND (t.hive_id = ${hiveId} OR g.hive_id = ${hiveId} OR i.hive_id = ${hiveId})
      LIMIT 1
    `;
    if (!row) return jsonError("File not found", 404);
    const r = row as { filename: string; storage_path: string; mime_type: string | null; size_bytes: number | string };
    if (!isTextLike(r.filename, r.mime_type) || Number(r.size_bytes) > INLINE_PREVIEW_BYTES) {
      return jsonError("Preview is not supported for this file type", 415);
    }
    let realPath: string;
    try {
      const realRoot = await fs.realpath(hiveRootPath(hive.slug));
      realPath = await fs.realpath(path.resolve(r.storage_path));
      if (!isPathInside(realPath, realRoot)) throw new Error("escape");
    } catch {
      return jsonError("File not found", 404);
    }
    const preview = await loadPreviewText(realPath, Number(r.size_bytes));
    return jsonOk({
      name: r.filename,
      content: preview.content,
      contentType: r.mime_type ?? "text/plain",
      truncated: preview.truncated,
    });
  }
  return jsonError("Preview is not supported for this category", 400);
}

async function downloadDatabase(hiveId: string, category: FileCategory, id: string, hive: HiveRow) {
  if (category === "work-products") {
    const [row] = await sql`
      SELECT id, file_path, mime_type
      FROM work_products
      WHERE id = ${id} AND hive_id = ${hiveId}
      LIMIT 1
    `;
    if (!row) return new Response("Not found", { status: 404 });
    const r = row as { file_path: string | null; mime_type: string | null };
    if (!r.file_path) return new Response("Not found", { status: 404 });
    const hiveRoot = hiveRootPath(hive.slug);
    const absolutePath = path.isAbsolute(r.file_path)
      ? r.file_path
      : path.join(hiveRoot, r.file_path);
    let realPath: string;
    try {
      const realRoot = await fs.realpath(hiveRoot);
      realPath = await fs.realpath(absolutePath);
      if (!isPathInside(realPath, realRoot)) throw new Error("escape");
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const bytes = await fs.readFile(realPath);
    const filename = safeHeaderFilename(path.basename(realPath));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": r.mime_type ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.length),
      },
    });
  }
  if (category === "attachments") {
    const [row] = await sql`
      SELECT DISTINCT a.id, a.filename, a.storage_path, a.mime_type
      FROM task_attachments a
      LEFT JOIN tasks t ON t.id = a.task_id
      LEFT JOIN goals g ON g.id = a.goal_id
      LEFT JOIN hive_ideas i ON i.id = a.idea_id
      WHERE a.id = ${id} AND (t.hive_id = ${hiveId} OR g.hive_id = ${hiveId} OR i.hive_id = ${hiveId})
      LIMIT 1
    `;
    if (!row) return new Response("Not found", { status: 404 });
    const r = row as { filename: string; storage_path: string; mime_type: string | null };
    let realPath: string;
    try {
      const realRoot = await fs.realpath(hiveRootPath(hive.slug));
      realPath = await fs.realpath(path.resolve(r.storage_path));
      if (!isPathInside(realPath, realRoot)) throw new Error("escape");
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const bytes = await fs.readFile(realPath);
    const filename = safeHeaderFilename(r.filename);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": r.mime_type ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.length),
      },
    });
  }
  return jsonError("Download is not supported for this category", 400);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { id } = await params;
    if (!id) return jsonError("id is required", 400);

    const url = new URL(request.url);
    const category = normalizeCategory(url.searchParams.get("category"));
    const action = normalizeAction(url.searchParams.get("action"));
    if (!category) return jsonError("Unsupported file category", 400);
    if (!action) return jsonError("Unsupported file action", 400);

    const [hive] = await sql`
      SELECT id, slug, workspace_path
      FROM hives
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!hive) return jsonError("hive not found", 404);
    const hiveRow = hive as HiveRow;

    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, id);
      if (!hasAccess) return jsonError("Forbidden: hive access required", 403);
    }

    if (action === "list") {
      const items = await listCategory(id, hiveRow, category);
      return jsonOk({
        category,
        categoryLabel: CATEGORY_LABELS[category],
        items,
        responseShape: "hive-file-browser-v1",
      });
    }

    if (FS_CATEGORIES.has(category)) {
      const relativePath = url.searchParams.get("path");
      if (!relativePath) return jsonError("path is required", 400);
      if (action === "preview") return previewFilesystem(hiveRow, category, relativePath);
      return downloadFilesystem(hiveRow, category, relativePath);
    }

    const fileId = url.searchParams.get("id");
    if (!fileId) return jsonError("id is required", 400);
    if (action === "preview") return previewDatabase(id, category, fileId, hiveRow);
    return downloadDatabase(id, category, fileId, hiveRow);
  } catch {
    return jsonError("Failed to read hive files", 500);
  }
}
