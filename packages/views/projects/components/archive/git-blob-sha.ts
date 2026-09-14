/**
 * git blob SHA-1（"blob <len>\\0<content>"）。与 CLI gitBlobSHA / git hash-object 一致。
 * 只做内容寻址，不承担安全签名。
 */

export function gitBlobSha1(data: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${data.length}\0`);
  const buf = new Uint8Array(header.length + data.length);
  buf.set(header);
  buf.set(data, header.length);
  return sha1Hex(buf);
}

export function gitBlobSha1FromText(text: string): string {
  return gitBlobSha1(new TextEncoder().encode(text));
}

function sha1Hex(message: Uint8Array): string {
  const words = bytesToWords(message);
  const bitLen = message.length * 8;
  words[bitLen >> 5] |= 0x80 << (24 - (bitLen % 32));
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);

  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[i + t] | 0;
    for (let t = 16; t < 80; t++) {
      const n = (w[t - 3] ?? 0) ^ (w[t - 8] ?? 0) ^ (w[t - 14] ?? 0) ^ (w[t - 16] ?? 0);
      w[t] = rotl(n, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      const temp = (rotl(a, 5) + f(t, b, c, d) + e + (w[t] ?? 0) + k(t)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(wordToHex).join("");
}

function f(t: number, b: number, c: number, d: number): number {
  if (t < 20) return (b & c) | (~b & d);
  if (t < 40) return b ^ c ^ d;
  if (t < 60) return (b & c) | (b & d) | (c & d);
  return b ^ c ^ d;
}

function k(t: number): number {
  if (t < 20) return 0x5a827999;
  if (t < 40) return 0x6ed9eba1;
  if (t < 60) return 0x8f1bbcdc;
  return 0xca62c1d6;
}

function rotl(n: number, bits: number): number {
  return (n << bits) | (n >>> (32 - bits));
}

function bytesToWords(bytes: Uint8Array): number[] {
  const words = new Array<number>((((bytes.length + 8) >> 6) + 1) * 16).fill(0);
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] |= bytes[i]! << (24 - (i % 4) * 8);
  }
  return words;
}

function wordToHex(n: number): string {
  return [24, 16, 8, 0]
    .map((shift) => ((n >>> shift) & 0xff).toString(16).padStart(2, "0"))
    .join("");
}
