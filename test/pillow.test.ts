// Pillow integration tests — verifies PIL works end-to-end in workerd.
//
// Uses python-pillow.wasm (CPython 3.13 + Pillow 11.1.0 _imaging statically linked)
// and extension-site-packages.zip (PIL Python layer loaded via zipimport).

import { describe, it, expect } from "vitest";
import pythonPillowWasm from "../worker/src/python-pillow.wasm";
import { stdlibFS } from "../worker/src/stdlib-fs";
import { ProcExit, createWasi } from "../worker/src/wasi";
// @ts-ignore
import pillowPackagesData from "../worker/src/extension-site-packages.zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runPillow(code: string): Promise<{ text: string; stderr: string; status: number }> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(stdlibFS)) {
    files[path] = encoder.encode(content);
  }

  let pythonPath = "/stdlib";
  if (pillowPackagesData) {
    files["extension-site-packages.zip"] = new Uint8Array(pillowPackagesData);
    pythonPath += ":/stdlib/extension-site-packages.zip";
  }

  let memory: WebAssembly.Memory | undefined;
  const wasi = createWasi(
    ["python", "-S", "-c", code],
    { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
    files,
    () => memory!
  );

  const pymode: Record<string, Function> = {
    tcp_connect: () => -1,
    tcp_send: () => -1,
    tcp_recv: () => -1,
    tcp_close: () => {},
    http_fetch: () => -1,
    http_response_status: () => 0,
    http_response_read: () => 0,
    http_response_header: () => -1,
    kv_get: () => -1,
    kv_put: () => {},
    kv_delete: () => {},
    r2_get: () => -1,
    r2_put: () => {},
    d1_exec: () => -1,
    env_get: () => -1,
    thread_spawn: () => -1,
    thread_join: () => -1,
    dl_open: () => -1,
    dl_sym: () => 0,
    dl_close: () => {},
    dl_error: () => 0,
    console_log: () => {},
  };

  const asyncify: Record<string, Function> = {
    start_unwind: () => {},
    stop_unwind: () => {},
    start_rewind: () => {},
    stop_rewind: () => {},
  };

  try {
    const result = await WebAssembly.instantiate(pythonPillowWasm, {
      wasi_snapshot_preview1: wasi.imports,
      pymode,
      asyncify,
    });
    const instance = (result as any).exports
      ? (result as WebAssembly.Instance)
      : (result as any).instance;
    memory = instance.exports.memory as WebAssembly.Memory;
    const start = instance.exports._start as () => void;
    start();
    return {
      text: decoder.decode(wasi.getStdout()).trim(),
      stderr: decoder.decode(wasi.getStderr()).trim(),
      status: 0,
    };
  } catch (e: unknown) {
    if (e instanceof ProcExit) {
      return {
        text: decoder.decode(wasi.getStdout()).trim(),
        stderr: decoder.decode(wasi.getStderr()).trim(),
        status: e.code,
      };
    }
    throw e;
  }
}

describe("pillow", () => {
  it("should verify _imaging is a builtin module", async () => {
    const { text } = await runPillow(`
import sys
builtins = [m for m in sys.builtin_module_names if 'imaging' in m]
print(builtins)
`);
    expect(text).toContain("PIL._imaging");
  });

  it("should import PIL successfully", async () => {
    const { text, stderr, status } = await runPillow(`
import PIL
print(f"PIL {PIL.__version__}")
`);
    expect(status).toBe(0);
    expect(text).toContain("PIL");
  });

  it("should import PIL.Image", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image
print(f"Image module loaded")
print(f"formats={len(Image.EXTENSION)}")
`);
    if (status !== 0) {
      console.error("PIL.Image import stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("Image module loaded");
  });

  it("should create an image in memory", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image
img = Image.new('RGB', (100, 50), color=(255, 0, 0))
print(f"size={img.size}")
print(f"mode={img.mode}")
pixel = img.getpixel((0, 0))
print(f"pixel={pixel}")
`);
    if (status !== 0) {
      console.error("create image stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("size=(100, 50)");
    expect(text).toContain("mode=RGB");
    expect(text).toContain("pixel=(255, 0, 0)");
  });

  it("should resize an image", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image
img = Image.new('RGB', (200, 100), color=(0, 128, 255))
resized = img.resize((50, 25))
print(f"original={img.size}")
print(f"resized={resized.size}")
`);
    if (status !== 0) {
      console.error("resize stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("original=(200, 100)");
    expect(text).toContain("resized=(50, 25)");
  });

  it("should save and load BMP in memory", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image
import io
img = Image.new('RGB', (10, 10), color=(255, 0, 0))
buf = io.BytesIO()
img.save(buf, format='BMP')
bmp_bytes = buf.getvalue()
print(f"bmp_size={len(bmp_bytes)}")
print(f"bmp_header={bmp_bytes[:2]}")

buf.seek(0)
loaded = Image.open(buf)
print(f"loaded_size={loaded.size}")
print(f"loaded_mode={loaded.mode}")
`);
    if (status !== 0) {
      console.error("bmp save/load stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("bmp_size=");
    expect(text).toContain("loaded_size=(10, 10)");
    expect(text).toContain("loaded_mode=RGB");
  });

  it("should save and load PNG in memory", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image, _imaging
import io

# Check zlib availability in _imaging
zlib_ver = getattr(_imaging, 'zlib_version', 'not available')
print(f"zlib={zlib_ver}")

img = Image.new('RGBA', (10, 10), color=(255, 0, 0, 128))
buf = io.BytesIO()
img.save(buf, format='PNG')
png_bytes = buf.getvalue()
print(f"png_size={len(png_bytes)}")

buf.seek(0)
loaded = Image.open(buf)
print(f"loaded_size={loaded.size}")
print(f"loaded_mode={loaded.mode}")
`);
    if (status !== 0) {
      console.error("png save/load stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("png_size=");
    expect(text).toContain("loaded_size=(10, 10)");
    expect(text).toContain("loaded_mode=RGBA");
  });

  it("should convert between color modes", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image
rgb = Image.new('RGB', (10, 10), color=(255, 128, 0))
gray = rgb.convert('L')
print(f"rgb_mode={rgb.mode}")
print(f"gray_mode={gray.mode}")
print(f"gray_size={gray.size}")
`);
    if (status !== 0) {
      console.error("convert stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("rgb_mode=RGB");
    expect(text).toContain("gray_mode=L");
    expect(text).toContain("gray_size=(10, 10)");
  });

  it("should crop an image", { timeout: 15000 }, async () => {
    const { text, status, stderr } = await runPillow(`
from PIL import Image
img = Image.new('RGB', (100, 100), color=(0, 255, 0))
cropped = img.crop((10, 20, 60, 80))
print(f"cropped_size={cropped.size}")
`);
    if (status !== 0) {
      console.error("crop stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("cropped_size=(50, 60)");
  });
});
