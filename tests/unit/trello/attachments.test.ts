import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosInstance } from 'axios';
import { Readable } from 'stream';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  attachData,
  attachImage,
  attachImageData,
  attachFile,
  getCardAttachments,
  isLocalSource,
  resolveLocalPath,
  resolveSaveTarget,
  streamToFile,
  MIME_TYPES,
} from '../../../src/trello/attachments.js';

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual };
});

function createAxiosMock(): AxiosInstance {
  const post = vi.fn().mockResolvedValue({ data: { id: 'a1' } });
  const get = vi.fn();
  return { post, get } as unknown as AxiosInstance;
}

describe('attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('MIME_TYPES', () => {
    it('should be frozen', () => {
      expect(Object.isFrozen(MIME_TYPES)).toBe(true);
    });

    it('should map common extensions', () => {
      expect(MIME_TYPES['.md']).toBe('text/markdown');
      expect(MIME_TYPES['.pdf']).toBe('application/pdf');
      expect(MIME_TYPES['.png']).toBe('image/png');
    });
  });

  describe('isLocalSource', () => {
    it('recognizes local path forms', () => {
      expect(isLocalSource('/Users/me/file.png')).toBe(true);
      expect(isLocalSource('~/file.png')).toBe(true);
      expect(isLocalSource('file:///Users/me/file.png')).toBe(true);
      expect(isLocalSource('C:\\Users\\me\\file.png')).toBe(true);
      expect(isLocalSource('D:/data/file.png')).toBe(true);
    });

    it('rejects URLs and relative paths', () => {
      expect(isLocalSource('https://example.com/file.png')).toBe(false);
      expect(isLocalSource('http://example.com/file.png')).toBe(false);
      expect(isLocalSource('relative/file.png')).toBe(false);
      expect(isLocalSource('./file.png')).toBe(false);
    });
  });

  describe('resolveLocalPath', () => {
    it('passes absolute paths through', () => {
      expect(resolveLocalPath('/tmp/x.png')).toBe('/tmp/x.png');
    });

    it('expands ~/ to the home directory', () => {
      expect(resolveLocalPath('~/x.png')).toBe(path.join(os.homedir(), 'x.png'));
    });

    it('converts file:// URLs', () => {
      expect(resolveLocalPath('file:///tmp/x.png')).toBe('/tmp/x.png');
    });

    it('throws on malformed file:// URLs', () => {
      expect(() => resolveLocalPath('file:///a%2Fb.png')).toThrow(/Invalid file URL/);
    });
  });

  describe('attachData', () => {
    it('uploads raw base64 with explicit name and mime type', async () => {
      const axiosInstance = createAxiosMock();

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: Buffer.from('hello').toString('base64'),
        name: 'notes.md',
        mimeType: 'text/markdown',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/cards/c1/attachments',
        expect.anything(),
        expect.objectContaining({ headers: expect.any(Object) })
      );
      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toContain('text/markdown');
      expect(form.getBuffer().toString()).toContain('notes.md');
    });

    it('extracts mime type and bytes from a data URL', async () => {
      const axiosInstance = createAxiosMock();
      const dataUrl = `data:application/pdf;base64,${Buffer.from('pdf').toString('base64')}`;

      await attachData(axiosInstance, { cardId: 'c1', data: dataUrl, name: 'r.pdf' });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toContain('application/pdf');
    });

    it('infers mime type from filename extension when omitted', async () => {
      const axiosInstance = createAxiosMock();

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: Buffer.from('# hi').toString('base64'),
        name: 'notes.md',
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toContain('text/markdown');
    });

    it('falls back to application/octet-stream when no hints exist', async () => {
      const axiosInstance = createAxiosMock();

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: Buffer.from('blob').toString('base64'),
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toContain('application/octet-stream');
    });

    it('lets explicit mimeType override one parsed from a data URL', async () => {
      const axiosInstance = createAxiosMock();
      const dataUrl = `data:application/octet-stream;base64,${Buffer.from('x').toString('base64')}`;

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: dataUrl,
        name: 'a.pdf',
        mimeType: 'application/pdf',
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const body = form.getBuffer().toString();
      expect(body).toContain('application/pdf');
      expect(body).not.toContain('application/octet-stream');
    });

    it('uses a generated filename when name is omitted', async () => {
      const axiosInstance = createAxiosMock();

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: Buffer.from('blob').toString('base64'),
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toMatch(/attachment-\d+/);
    });

    it('appends an inferred extension to the generated filename when mime type is known', async () => {
      const axiosInstance = createAxiosMock();
      const dataUrl = `data:application/pdf;base64,${Buffer.from('pdf').toString('base64')}`;

      await attachData(axiosInstance, { cardId: 'c1', data: dataUrl });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toMatch(/attachment-\d+\.pdf/);
    });

    it('omits the extension when mime type has no entry in MIME_TYPES', async () => {
      const axiosInstance = createAxiosMock();

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: Buffer.from('blob').toString('base64'),
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(form.getBuffer().toString()).toMatch(/attachment-\d+(?!\.)/);
    });

    it('rejects a malformed data URL without uploading', async () => {
      const axiosInstance = createAxiosMock();

      await expect(
        attachData(axiosInstance, { cardId: 'c1', data: 'data:not-valid', name: 'x.bin' })
      ).rejects.toThrow(/Invalid data URL/);
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('redirects to attach_file_to_card when data is a path to an existing file', async () => {
      const tmpFile = path.join(os.tmpdir(), `attach-data-path-${Date.now()}.png`);
      await fs.writeFile(tmpFile, 'png-bytes');
      try {
        const axiosInstance = createAxiosMock();

        await expect(
          attachData(axiosInstance, { cardId: 'c1', data: tmpFile })
        ).rejects.toThrow(/file path.*attach_file_to_card/s);
        expect(axiosInstance.post).not.toHaveBeenCalled();
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('still accepts JPEG-style base64 starting with /9j/ when no such file exists', async () => {
      const axiosInstance = createAxiosMock();

      await attachData(axiosInstance, {
        cardId: 'c1',
        data: '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZg==',
        name: 'photo.jpg',
      });

      expect(axiosInstance.post).toHaveBeenCalled();
    });

    it('rejects invalid base64 instead of silently uploading corrupt bytes', async () => {
      const axiosInstance = createAxiosMock();

      await expect(
        attachData(axiosInstance, { cardId: 'c1', data: 'not-valid-base64!!!', name: 'x.png' })
      ).rejects.toThrow(/Invalid base64/);
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('accepts base64 split across lines with whitespace', async () => {
      const axiosInstance = createAxiosMock();
      const b64 = Buffer.from('hello world hello world').toString('base64');
      const split = `${b64.slice(0, 10)}\n${b64.slice(10)}`;

      await attachData(axiosInstance, { cardId: 'c1', data: split, name: 'x.txt' });

      expect(axiosInstance.post).toHaveBeenCalled();
    });
  });

  describe('attachImageData', () => {
    it('defaults to image/png and a screenshot filename', async () => {
      const axiosInstance = createAxiosMock();

      await attachImageData(axiosInstance, {
        cardId: 'c1',
        imageData: Buffer.from('png').toString('base64'),
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const body = form.getBuffer().toString();
      expect(body).toContain('image/png');
      expect(body).toMatch(/screenshot-\d+\.png/);
    });

    it('respects caller-supplied mime type and name', async () => {
      const axiosInstance = createAxiosMock();

      await attachImageData(axiosInstance, {
        cardId: 'c1',
        imageData: Buffer.from('jpg').toString('base64'),
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
      });

      const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const body = form.getBuffer().toString();
      expect(body).toContain('image/jpeg');
      expect(body).toContain('photo.jpg');
    });
  });

  describe('attachFile', () => {
    it('attaches a remote URL with explicit mime type', async () => {
      const axiosInstance = createAxiosMock();

      await attachFile(axiosInstance, {
        cardId: 'c1',
        fileUrl: 'https://example.com/doc.pdf',
        name: 'doc.pdf',
        mimeType: 'application/pdf',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith('/cards/c1/attachments', {
        url: 'https://example.com/doc.pdf',
        name: 'doc.pdf',
        mimeType: 'application/pdf',
      });
    });

    it('infers mime type from a remote URL extension', async () => {
      const axiosInstance = createAxiosMock();

      await attachFile(axiosInstance, {
        cardId: 'c1',
        fileUrl: 'https://example.com/notes.md',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith('/cards/c1/attachments', {
        url: 'https://example.com/notes.md',
        name: 'notes.md',
        mimeType: 'text/markdown',
      });
    });

    it('uploads a local file:// URL as multipart form data', async () => {
      const tmpFile = path.join(os.tmpdir(), `attachments-test-${Date.now()}.md`);
      await fs.writeFile(tmpFile, '# hello');
      try {
        const axiosInstance = createAxiosMock();

        await attachFile(axiosInstance, {
          cardId: 'c1',
          fileUrl: `file://${tmpFile}`,
        });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/cards/c1/attachments',
          expect.anything(),
          expect.objectContaining({ headers: expect.any(Object) })
        );
        // Form contains a stream so getBuffer() is unavailable; assert on form fields directly.
        const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
        const fields = (form as unknown as { _streams: unknown[] })._streams.join('\n');
        expect(fields).toContain('text/markdown');
        expect(fields).toContain(path.basename(tmpFile));
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('throws on a missing local file', async () => {
      const axiosInstance = createAxiosMock();
      const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.txt`);

      await expect(
        attachFile(axiosInstance, { cardId: 'c1', fileUrl: `file://${missing}` })
      ).rejects.toThrow(/File not found/);
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('uploads a plain absolute path as multipart form data', async () => {
      const tmpFile = path.join(os.tmpdir(), `attachments-plain-${Date.now()}.md`);
      await fs.writeFile(tmpFile, '# plain path');
      try {
        const axiosInstance = createAxiosMock();

        await attachFile(axiosInstance, { cardId: 'c1', fileUrl: tmpFile });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/cards/c1/attachments',
          expect.anything(),
          expect.objectContaining({ headers: expect.any(Object) })
        );
        const form = (axiosInstance.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
        const fields = (form as unknown as { _streams: unknown[] })._streams.join('\n');
        expect(fields).toContain('text/markdown');
        expect(fields).toContain(path.basename(tmpFile));
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('expands ~/ paths against the home directory', async () => {
      const axiosInstance = createAxiosMock();
      const missing = `~/does-not-exist-${Date.now()}.txt`;

      // Routed as a local upload (fails file check with the resolved path, not URL parse)
      await expect(
        attachFile(axiosInstance, { cardId: 'c1', fileUrl: missing })
      ).rejects.toThrow(new RegExp(`File not found: ${os.homedir()}`));
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('routes Windows drive paths to the local upload branch', async () => {
      const axiosInstance = createAxiosMock();

      await expect(
        attachFile(axiosInstance, { cardId: 'c1', fileUrl: 'C:\\missing\\file.txt' })
      ).rejects.toThrow(/File not found/);
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('rejects relative paths with a clear error listing accepted forms', async () => {
      const axiosInstance = createAxiosMock();

      await expect(
        attachFile(axiosInstance, { cardId: 'c1', fileUrl: 'relative/file.txt' })
      ).rejects.toThrow(/Unsupported file source.*absolute path/s);
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('rejects non-http schemes with a clear error', async () => {
      const axiosInstance = createAxiosMock();

      await expect(
        attachFile(axiosInstance, { cardId: 'c1', fileUrl: 'ftp://example.com/file.txt' })
      ).rejects.toThrow(/Unsupported file source/);
      expect(axiosInstance.post).not.toHaveBeenCalled();
    });

    it('defaults the remote attachment name to the URL basename', async () => {
      const axiosInstance = createAxiosMock();

      await attachFile(axiosInstance, {
        cardId: 'c1',
        fileUrl: 'https://example.com/reports/q3-summary.pdf',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith('/cards/c1/attachments', {
        url: 'https://example.com/reports/q3-summary.pdf',
        name: 'q3-summary.pdf',
        mimeType: 'application/pdf',
      });
    });
  });

  describe('attachImage', () => {
    it('delegates to attachFile, defaulting the name to the URL basename', async () => {
      const axiosInstance = createAxiosMock();

      await attachImage(axiosInstance, {
        cardId: 'c1',
        imageUrl: 'https://example.com/cat.png',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith('/cards/c1/attachments', {
        url: 'https://example.com/cat.png',
        name: 'cat.png',
        mimeType: 'image/png',
      });
    });

    it('respects a caller-supplied name', async () => {
      const axiosInstance = createAxiosMock();

      await attachImage(axiosInstance, {
        cardId: 'c1',
        imageUrl: 'https://example.com/cat.png',
        name: 'cat',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/cards/c1/attachments',
        expect.objectContaining({ name: 'cat' })
      );
    });
  });

  describe('getCardAttachments', () => {
    it('calls GET /cards/{cardId}/attachments with the cardId', async () => {
      const axiosInstance = createAxiosMock();
      const attachments = [{ id: 'a1', name: 'file.pdf' }];
      (axiosInstance.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: attachments,
      });

      const result = await getCardAttachments(axiosInstance, 'card-456');

      expect(axiosInstance.get).toHaveBeenCalledWith('/cards/card-456/attachments');
      expect(result).toBe(attachments);
    });

    it('returns response.data unchanged', async () => {
      const axiosInstance = createAxiosMock();
      const attachments = [
        { id: 'a1', name: 'one.png', mimeType: 'image/png' },
        { id: 'a2', name: 'two.pdf', mimeType: 'application/pdf' },
      ];
      (axiosInstance.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: attachments,
      });

      const result = await getCardAttachments(axiosInstance, 'c1');

      expect(result).toEqual(attachments);
      expect(result).toBe(attachments);
    });
  });

  describe('resolveSaveTarget', () => {
    it('joins the attachment filename when savePath is an existing directory', async () => {
      const target = await resolveSaveTarget(os.tmpdir(), 'shot.png');
      expect(target).toBe(path.join(os.tmpdir(), 'shot.png'));
    });

    it('uses a non-directory savePath verbatim and creates parent dirs', async () => {
      const dir = path.join(os.tmpdir(), `save-target-${Date.now()}`, 'nested');
      const file = path.join(dir, 'out.bin');
      try {
        const target = await resolveSaveTarget(file, 'ignored.png');
        expect(target).toBe(file);
        const stat = await fs.stat(dir);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(path.dirname(dir), { recursive: true, force: true });
      }
    });

    it('expands ~/ in savePath', async () => {
      const target = await resolveSaveTarget('~/Downloads', 'x.png');
      expect(target.startsWith(os.homedir())).toBe(true);
    });

    it('rejects relative savePath', async () => {
      await expect(resolveSaveTarget('relative/dir', 'x.png')).rejects.toThrow(
        /savePath must be an absolute path/
      );
    });
  });

  describe('streamToFile', () => {
    it('writes the stream to disk and returns the byte count', async () => {
      const target = path.join(os.tmpdir(), `stream-to-file-${Date.now()}.txt`);
      try {
        const bytes = await streamToFile(Readable.from('stream contents'), target);
        expect(bytes).toBe(Buffer.byteLength('stream contents'));
        expect(await fs.readFile(target, 'utf8')).toBe('stream contents');
      } finally {
        await fs.unlink(target).catch(() => {});
      }
    });
  });
});
