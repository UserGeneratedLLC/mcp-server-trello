import { AxiosInstance } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { TrelloAttachment } from '../types.js';

export const MIME_TYPES: Readonly<{ [key: string]: string }> = Object.freeze({
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Text
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.log': 'text/plain',

  // Code
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',

  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',

  // Media
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
});

const DEFAULT_MIME_TYPE = 'application/octet-stream';

function mimeFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext];
}

function extensionFromMime(mimeType: string): string {
  const match = Object.entries(MIME_TYPES).find(([, mime]) => mime === mimeType);
  return match?.[0] ?? '';
}

// Checked before URL parsing: Windows paths like C:\foo parse as valid URLs with protocol "c:"
export function isLocalSource(source: string): boolean {
  return (
    source.startsWith('file://') ||
    source.startsWith('/') ||
    source.startsWith('~/') ||
    /^[a-zA-Z]:[\\/]/.test(source)
  );
}

export function resolveLocalPath(source: string): string {
  if (source.startsWith('file://')) {
    try {
      return fileURLToPath(source);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Invalid file URL: ${source}`);
    }
  }
  if (source.startsWith('~/')) {
    return path.join(os.homedir(), source.slice(2));
  }
  return source;
}

function isPathToExistingFile(value: string): boolean {
  if (!isLocalSource(value)) return false;
  try {
    return existsSync(resolveLocalPath(value));
  } catch {
    return false;
  }
}

export interface AttachDataParams {
  cardId: string;
  data: string;
  name?: string;
  mimeType?: string;
}

// Allows whitespace since agents often split base64 payloads across lines
const BASE64_RE = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

function decodeBase64Strict(data: string, context: string): Buffer {
  if (!BASE64_RE.test(data)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid base64 in ${context}. If this content is a file on disk, use attach_file_to_card with its path instead — no base64 needed.`
    );
  }
  return Buffer.from(data, 'base64');
}

export async function attachData(
  axiosInstance: AxiosInstance,
  { cardId, data, name, mimeType }: AttachDataParams
): Promise<TrelloAttachment> {
  let buffer: Buffer;
  let effectiveMimeType = mimeType;

  // Path redirect: existence check avoids false positives (JPEG base64 starts with "/9j/")
  if (isPathToExistingFile(data)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `"${data}" is a file path, not base64 data. Use attach_file_to_card with the path directly — no base64 conversion needed.`
    );
  }

  if (data.startsWith('data:')) {
    const matches = data.match(/^data:([^;]+);base64,(.+)$/s);
    if (!matches) {
      throw new McpError(ErrorCode.InvalidRequest, 'Invalid data URL format');
    }
    effectiveMimeType = effectiveMimeType || matches[1];
    buffer = decodeBase64Strict(matches[2], 'data URL');
  } else {
    buffer = decodeBase64Strict(data, 'data parameter');
  }

  effectiveMimeType = effectiveMimeType || mimeFromFilename(name) || DEFAULT_MIME_TYPE;

  const extension = extensionFromMime(effectiveMimeType);
  const fileName = name || `attachment-${Date.now()}${extension}`;
  const form = new FormData();
  form.append('file', buffer, { filename: fileName, contentType: effectiveMimeType });
  form.append('name', fileName);
  form.append('mimeType', effectiveMimeType);

  const response = await axiosInstance.post(`/cards/${cardId}/attachments`, form, {
    headers: { ...form.getHeaders() },
  });
  return response.data;
}

export interface AttachImageDataParams {
  cardId: string;
  imageData: string;
  name?: string;
  mimeType?: string;
}

export async function attachImageData(
  axiosInstance: AxiosInstance,
  { cardId, imageData, name, mimeType }: AttachImageDataParams
): Promise<TrelloAttachment> {
  return attachData(axiosInstance, {
    cardId,
    data: imageData,
    name: name || `screenshot-${Date.now()}.png`,
    mimeType: mimeType || 'image/png',
  });
}

export interface AttachFileParams {
  cardId: string;
  fileUrl: string;
  name?: string;
  mimeType?: string;
}

export async function attachFile(
  axiosInstance: AxiosInstance,
  { cardId, fileUrl, name, mimeType }: AttachFileParams
): Promise<TrelloAttachment> {
  if (isLocalSource(fileUrl)) {
    return uploadLocalFile(axiosInstance, { cardId, fileUrl, name, mimeType });
  }
  if (fileUrl.startsWith('https://') || fileUrl.startsWith('http://')) {
    return attachRemoteUrl(axiosInstance, { cardId, fileUrl, name, mimeType });
  }
  throw new McpError(
    ErrorCode.InvalidRequest,
    `Unsupported file source: ${fileUrl}. Use an absolute path (/path/to/file), ~/path, file:// URL, or https:// URL. Relative paths are not supported.`
  );
}

async function uploadLocalFile(
  axiosInstance: AxiosInstance,
  { cardId, fileUrl, name, mimeType }: AttachFileParams
): Promise<TrelloAttachment> {
  const localPath = resolveLocalPath(fileUrl);
  const effectiveMimeType =
    mimeType || mimeFromFilename(localPath) || DEFAULT_MIME_TYPE;

  try {
    await fs.access(localPath);
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, `File not found: ${localPath}`);
  }

  const fileName = name || path.basename(localPath);
  const form = new FormData();
  form.append('file', createReadStream(localPath), {
    filename: fileName,
    contentType: effectiveMimeType,
  });
  form.append('name', fileName);
  form.append('mimeType', effectiveMimeType);

  const response = await axiosInstance.post(`/cards/${cardId}/attachments`, form, {
    headers: { ...form.getHeaders() },
  });
  return response.data;
}

async function attachRemoteUrl(
  axiosInstance: AxiosInstance,
  { cardId, fileUrl, name, mimeType }: AttachFileParams
): Promise<TrelloAttachment> {
  let remoteUrlPath: string;
  try {
    remoteUrlPath = new URL(fileUrl).pathname;
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, `Invalid URL: ${fileUrl}`);
  }
  const effectiveMimeType =
    mimeType || mimeFromFilename(remoteUrlPath) || DEFAULT_MIME_TYPE;

  const urlBasename = path.posix.basename(remoteUrlPath);
  const response = await axiosInstance.post(`/cards/${cardId}/attachments`, {
    url: fileUrl,
    name: name || urlBasename || 'File Attachment',
    mimeType: effectiveMimeType,
  });
  return response.data;
}

export interface AttachImageParams {
  cardId: string;
  imageUrl: string;
  name?: string;
}

export async function attachImage(
  axiosInstance: AxiosInstance,
  { cardId, imageUrl, name }: AttachImageParams
): Promise<TrelloAttachment> {
  // attachFile auto-detects MIME type via the path/URL extension; name defaults
  // downstream to the file basename (local) or URL basename (remote)
  return attachFile(axiosInstance, {
    cardId,
    fileUrl: imageUrl,
    name,
  });
}

/**
 * Get all attachments from a card
 * 
 * @param axiosInstance - Trello API client
 * @param cardId - ID of the card
 * @returns Array of attachments with full metadata
 */
export async function getCardAttachments(
  axiosInstance: AxiosInstance,
  cardId: string
): Promise<TrelloAttachment[]> {
  const response = await axiosInstance.get(`/cards/${cardId}/attachments`);
  return response.data;
}

/**
 * Resolve a download destination: a directory gets the attachment's own
 * filename joined; otherwise the path is used as the target file verbatim.
 */
export async function resolveSaveTarget(savePath: string, fileName: string): Promise<string> {
  if (!isLocalSource(savePath)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `savePath must be an absolute path, ~/path, or file:// URL, got: ${savePath}`
    );
  }
  const resolved = resolveLocalPath(savePath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (stat?.isDirectory()) {
    return path.join(resolved, fileName);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

export async function streamToFile(
  stream: NodeJS.ReadableStream,
  targetPath: string
): Promise<number> {
  await pipeline(stream, createWriteStream(targetPath));
  const stat = await fs.stat(targetPath);
  return stat.size;
}
