/**
 * @pymode/pillow — Image processing on Cloudflare Workers.
 *
 * Wraps Python's Pillow (PIL) library with a TypeScript-native API.
 * Runs entirely at the edge via pymode's Python WASM runtime.
 *
 * Usage:
 *   import { Image } from '@pymode/pillow';
 *
 *   export default {
 *     async fetch(request, env) {
 *       const pythonDO = env.PYTHON_DO.get(env.PYTHON_DO.idFromName('img'));
 *       const img = await Image.open(await request.arrayBuffer(), pythonDO);
 *       const thumb = await img.resize(200, 200);
 *       return new Response(await thumb.toBuffer('webp'), {
 *         headers: { 'Content-Type': 'image/webp' },
 *       });
 *     },
 *   };
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff';
export type ResampleFilter = 'nearest' | 'bilinear' | 'bicubic' | 'lanczos';

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  mode: string; // 'RGB', 'RGBA', 'L', 'CMYK', etc.
}

export interface CropBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SaveOptions {
  quality?: number;        // JPEG/WebP quality 1-100
  optimize?: boolean;      // PNG/JPEG optimization
  lossless?: boolean;      // WebP lossless mode
}

/** Interface for the PythonDO Durable Object instance. */
export interface PythonDOHandle {
  callFunction(
    modulePath: string,
    functionName: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{
    returnValue: unknown;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

// Python backend source — injected into WASM VFS via userFiles on each call.
// This is the only way to make the module importable without modifying the stdlib build.
// @ts-ignore — loaded as raw text by bundler (vite ?raw / wrangler text module)
import PILLOW_PY_SOURCE from './_pymode_pillow.py?raw';

const BACKEND_FILES = { '_pymode_pillow.py': PILLOW_PY_SOURCE };

async function runPillow(
  pythonDO: PythonDOHandle,
  operation: string,
  imageData: ArrayBuffer,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const base64Input = bufferToBase64(imageData);

  const response = await pythonDO.callFunction(
    '_pymode_pillow',
    operation,
    { image_b64: base64Input, ...params },
    { userFiles: BACKEND_FILES },
  );

  if (response.exitCode !== 0) {
    throw new Error(`Pillow error: ${response.stderr || 'unknown error'}`);
  }

  return response.returnValue as Record<string, unknown>;
}

export class Image {
  private _data: ArrayBuffer;
  private _info: ImageInfo;
  private _pythonDO: PythonDOHandle;

  private constructor(
    data: ArrayBuffer,
    info: ImageInfo,
    pythonDO: PythonDOHandle
  ) {
    this._data = data;
    this._info = info;
    this._pythonDO = pythonDO;
  }

  /** Open an image from binary data (ArrayBuffer, Uint8Array, or Response). */
  static async open(
    input: ArrayBuffer | Uint8Array | Response,
    pythonDO: PythonDOHandle
  ): Promise<Image> {
    let data: ArrayBuffer;
    if (input instanceof Response) {
      data = await input.arrayBuffer();
    } else if (input instanceof Uint8Array) {
      data = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    } else {
      data = input;
    }

    const result = await runPillow(pythonDO, 'open', data);
    return new Image(data, result as ImageInfo, pythonDO);
  }

  /** Image width in pixels. */
  get width(): number { return this._info.width; }

  /** Image height in pixels. */
  get height(): number { return this._info.height; }

  /** Image format (png, jpeg, etc.). */
  get format(): string { return this._info.format; }

  /** Image color mode (RGB, RGBA, L, etc.). */
  get mode(): string { return this._info.mode; }

  /** Full image metadata. */
  get info(): ImageInfo { return { ...this._info }; }

  /** Resize the image. Returns a new Image. */
  async resize(
    width: number,
    height: number,
    filter: ResampleFilter = 'lanczos'
  ): Promise<Image> {
    const result = await runPillow(this._pythonDO, 'resize', this._data, {
      width, height, filter,
    });
    const newData = base64ToBuffer(result.image_b64);
    return new Image(newData, result.info, this._pythonDO);
  }

  /** Crop the image. Returns a new Image. */
  async crop(box: CropBox): Promise<Image> {
    const result = await runPillow(this._pythonDO, 'crop', this._data, {
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
    });
    const newData = base64ToBuffer(result.image_b64);
    return new Image(newData, result.info, this._pythonDO);
  }

  /** Rotate the image by degrees. Returns a new Image. */
  async rotate(degrees: number, expand: boolean = false): Promise<Image> {
    const result = await runPillow(this._pythonDO, 'rotate', this._data, {
      degrees, expand,
    });
    const newData = base64ToBuffer(result.image_b64);
    return new Image(newData, result.info, this._pythonDO);
  }

  /** Flip the image horizontally or vertically. Returns a new Image. */
  async flip(direction: 'horizontal' | 'vertical'): Promise<Image> {
    const result = await runPillow(this._pythonDO, 'flip', this._data, {
      direction,
    });
    const newData = base64ToBuffer(result.image_b64);
    return new Image(newData, result.info, this._pythonDO);
  }

  /** Convert to a different color mode (RGB, RGBA, L, etc.). Returns a new Image. */
  async convert(mode: string): Promise<Image> {
    const result = await runPillow(this._pythonDO, 'convert', this._data, { mode });
    const newData = base64ToBuffer(result.image_b64);
    return new Image(newData, result.info, this._pythonDO);
  }

  /** Create a thumbnail that fits within the given dimensions, preserving aspect ratio. Returns a new Image. */
  async thumbnail(maxWidth: number, maxHeight: number): Promise<Image> {
    const result = await runPillow(this._pythonDO, 'thumbnail', this._data, {
      max_width: maxWidth, max_height: maxHeight,
    });
    const newData = base64ToBuffer(result.image_b64);
    return new Image(newData, result.info, this._pythonDO);
  }

  /** Export the image as a buffer in the specified format. */
  async toBuffer(format: ImageFormat = 'png', options: SaveOptions = {}): Promise<ArrayBuffer> {
    const result = await runPillow(this._pythonDO, 'export', this._data, {
      format, ...options,
    });
    return base64ToBuffer(result.image_b64);
  }
}

// ── Base64 helpers ───────────────────────────────────────────────

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Build in 8KB chunks to avoid O(n²) string concatenation
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const slice = bytes.subarray(i, Math.min(i + 8192, bytes.length));
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
