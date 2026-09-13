import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough PNG to read a terrain tile.
 *
 * Elevation arrives as 256x256 "terrarium" PNGs, which are 8-bit RGB(A) with
 * no interlacing and no palette — one narrow corner of the format. Decoding
 * that corner is sixty lines against `node:zlib`, and the alternative is a
 * dependency in a project that currently has three. If a source ever hands
 * us 16-bit or interlaced tiles this will say so loudly rather than quietly
 * returning nonsense.
 */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. Alpha is 255 for sources without it. */
  pixels: Uint8Array;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const body = offset + 8;

    if (type === 'IHDR') {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const depth = bytes[body + 8];
      const colorType = bytes[body + 9];
      const interlace = bytes[body + 12];
      if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (only 8)`);
      if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`PNG colour type ${colorType} is not supported (only truecolour, with or without alpha)`);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(body, body + length));
    } else if (type === 'IEND') {
      break;
    }

    offset = body + length + 4; // + CRC
  }

  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');

  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  return { width, height, pixels: unfilter(raw, width, height, channels) };
}

/**
 * Undo the per-scanline filters. Each row is prefixed with a filter byte and
 * encoded as a delta against the pixel to its left (`a`), the one above
 * (`b`), and the one above-left (`c`) — so rows have to be walked in order,
 * and each row needs the finished bytes of the one before it.
 */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const current = new Uint8Array(stride);
  const previous = new Uint8Array(stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i];
      const a = i >= channels ? current[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;

      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      current[i] = value & 0xff;
    }
    pos += stride;

    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = current[from];
      out[to + 1] = current[from + 1];
      out[to + 2] = current[from + 2];
      out[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    previous.set(current);
  }

  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Write an RGBA buffer back out as a PNG.
 *
 * The counterpart to `decodePng`, and here for the same reason: the map
 * importer needs to be *looked at* while it is being calibrated. Judging
 * whether a colour rule has correctly found the forests is not something
 * numbers answer — you have to see the classification laid over the map. So
 * the importer can dump what it thinks it is seeing as an image.
 *
 * No filtering (filter type 0 on every row) and one IDAT. Larger than an
 * optimised encoder would produce, and irrelevant for a debug artefact.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
