/** Find an insertion point after the leading APP0 and Exif segments, preserving every input JPEG byte. */
function insertionPoint(jpeg: Uint8Array): number {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
      jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
    throw new Error('MPO export requires complete JPEG images.');
  }
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  let insert = 2;
  for (let offset = 2; offset < jpeg.length - 2;) {
    if (jpeg[offset] !== 0xff) throw new Error('The JPEG header is invalid.');
    while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > jpeg.length - 2) throw new Error('The JPEG header is truncated.');
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > jpeg.length - 2) throw new Error('The JPEG segment length is invalid.');
    if (marker === 0xe2 && length >= 6 && jpeg[offset + 2] === 0x4d &&
        jpeg[offset + 3] === 0x50 && jpeg[offset + 4] === 0x46 && jpeg[offset + 5] === 0) {
      throw new Error('MPO export requires JPEG images without an existing MP index.');
    }
    // JFIF wants APP0 first and DC-007 wants the MP index after Exif, so insert after the last of the two.
    if (marker === 0xe0 || marker === 0xe1) insert = offset + length;
    if (marker === 0xda) break; // Entropy-coded scan bytes are opaque.
    offset += length;
  }
  return insert;
}

/** CIPA DC-007 MP Index, big endian. Inputs are baseline JPEGs, left first. */
export function encodeMpo(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const insert = insertionPoint(left);
  insertionPoint(right);
  // APP2 marker + length + MPF identifier + TIFF header + three IFD tags + two entries.
  const segment = new Uint8Array(90);
  const view = new DataView(segment.buffer);
  segment.set([0xff, 0xe2, 0, 88, 0x4d, 0x50, 0x46, 0, 0x4d, 0x4d, 0, 42]);
  const header = 8; // All offsets are relative to the MP endian field, after MPF\0.
  view.setUint32(header + 4, 8);
  view.setUint16(header + 8, 3);
  const tag = (offset: number, id: number, type: number, count: number, value: number): void => {
    view.setUint16(offset, id); view.setUint16(offset + 2, type);
    view.setUint32(offset + 4, count); view.setUint32(offset + 8, value);
  };
  tag(header + 10, 0xb000, 7, 4, 0x30313030); // UNDEFINED, ASCII 0100.
  tag(header + 22, 0xb001, 4, 1, 2); // LONG, image count.
  tag(header + 34, 0xb002, 7, 32, 50); // UNDEFINED, two 16-byte entries.
  // The next IFD and dependency fields remain zero; no MP Attribute IFD.
  const firstSize = left.length + segment.length;
  if (firstSize + right.length > 0xffffffff) throw new Error('The stereo pair is too large for MPO.');
  view.setUint32(header + 50, 0x20020002); // Representative, Multi-Frame Disparity, JPEG.
  view.setUint32(header + 54, firstSize);
  view.setUint32(header + 66, 0x00020002);
  view.setUint32(header + 70, right.length);
  view.setUint32(header + 74, firstSize - (insert + header));
  const result = new Uint8Array(firstSize + right.length);
  result.set(left.subarray(0, insert));
  result.set(segment, insert);
  result.set(left.subarray(insert), insert + segment.length);
  result.set(right, firstSize);
  return result;
}
