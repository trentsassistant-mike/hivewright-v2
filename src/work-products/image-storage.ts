import fs from "node:fs/promises";
import path from "node:path";

export type ImageMimeType = "image/png" | "image/jpeg";

export interface StoredImage {
  filePath: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  sizeBytes: number;
}

const MIME_EXTENSION: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

export function resolveTaskImageDirectory(input: {
  hiveWorkspacePath: string;
  taskId: string;
}): string {
  const workspace = path.resolve(input.hiveWorkspacePath);
  const imageDir = path.resolve(workspace, input.taskId, "images");

  if (imageDir !== workspace && imageDir.startsWith(workspace + path.sep)) {
    return imageDir;
  }

  throw new Error("Resolved task image directory escaped the hive workspace");
}

export function assertPathInHiveWorkspace(filePath: string, hiveWorkspacePath: string): string {
  const workspace = path.resolve(hiveWorkspacePath);
  const resolved = path.resolve(filePath);
  if (resolved === workspace || resolved.startsWith(workspace + path.sep)) {
    return resolved;
  }
  throw new Error("Image artifact path is outside the hive workspace");
}

export function assertPathInTaskImageDirectory(input: {
  filePath: string;
  hiveWorkspacePath: string;
  taskId: string;
}): string {
  const imageDir = resolveTaskImageDirectory({
    hiveWorkspacePath: input.hiveWorkspacePath,
    taskId: input.taskId,
  });
  const resolved = path.resolve(input.filePath);

  if (resolved !== imageDir && resolved.startsWith(imageDir + path.sep)) {
    return resolved;
  }

  throw new Error("Image artifact path is outside the task images directory");
}

export async function assertRealPathInHiveWorkspace(
  filePath: string,
  hiveWorkspacePath: string,
): Promise<string> {
  const [realWorkspace, realFilePath] = await Promise.all([
    fs.realpath(hiveWorkspacePath),
    fs.realpath(filePath),
  ]);
  return assertPathInHiveWorkspace(realFilePath, realWorkspace);
}

export function detectImageMetadata(bytes: Buffer): {
  mimeType: ImageMimeType;
  width: number;
  height: number;
} {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return {
      mimeType: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          mimeType: "image/jpeg",
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segmentLength;
    }
  }

  throw new Error("Generated image must be a PNG or JPEG with readable dimensions");
}

export async function storeTaskImage(input: {
  hiveWorkspacePath: string;
  taskId: string;
  imageBase64: string;
  fileStem?: string;
}): Promise<StoredImage> {
  const bytes = Buffer.from(input.imageBase64, "base64");
  return storeTaskImageBytes({
    hiveWorkspacePath: input.hiveWorkspacePath,
    taskId: input.taskId,
    bytes,
    fileStem: input.fileStem,
  });
}

export async function storeTaskImageFile(input: {
  hiveWorkspacePath: string;
  taskId: string;
  sourcePath: string;
  fileStem?: string;
}): Promise<StoredImage> {
  const sourcePath = path.resolve(input.sourcePath);
  const bytes = await fs.readFile(sourcePath);
  return storeTaskImageBytes({
    hiveWorkspacePath: input.hiveWorkspacePath,
    taskId: input.taskId,
    bytes,
    fileStem: input.fileStem,
  });
}

export async function storeTaskImageBytes(input: {
  hiveWorkspacePath: string;
  taskId: string;
  bytes: Buffer;
  fileStem?: string;
}): Promise<StoredImage> {
  const bytes = input.bytes;
  const metadata = detectImageMetadata(bytes);
  const imageDir = resolveTaskImageDirectory({
    hiveWorkspacePath: input.hiveWorkspacePath,
    taskId: input.taskId,
  });
  await fs.mkdir(imageDir, { recursive: true });

  const safeStem = (input.fileStem ?? "generated-image").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
  const filePath = assertPathInHiveWorkspace(
    path.join(imageDir, `${safeStem}.${MIME_EXTENSION[metadata.mimeType]}`),
    input.hiveWorkspacePath,
  );
  await fs.writeFile(filePath, bytes, { flag: "wx" });

  return {
    filePath,
    mimeType: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
    sizeBytes: bytes.length,
  };
}
