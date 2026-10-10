// The synth fixtures under node: every output's SHA-256 pinned at every
// fixture size, so regenerating gives the same bytes; even sides; and each
// truth plane checked against the scene's geometry, independently of the
// painter's own classification where the geometry allows.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { depthInputSize } from '../src/analysis/depth-size.ts';
import type { Size } from '../src/core/raster.ts';
import { inShadow, SCENE, surfaceAt, type SceneGeometry } from './fixtures/synth/scene.ts';
import { maskSize, SYNTH_FIXTURES, synthScene, type SynthScene } from './fixtures/synth/synth.ts';

/** The SHA-256 of a view's bytes; a Float32Array's are its little-endian bytes on this little-endian host. */
function sha256(view: ArrayBufferView): string {
  return createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}

type Digests = {
  readonly masterRgba: string;
  readonly master: string;
  readonly plate: string;
  readonly depth: string;
  readonly sphereMask: string;
  readonly boxMask: string;
  readonly sphereMaskAtMaster: string;
  readonly boxMaskAtMaster: string;
  readonly hole: string;
  readonly depthNear: string;
  readonly depthFar: string;
  readonly ring: string;
};

/** Each output's digest, at the default sizes and, for the masks, at the master size too. */
const PINNED: Readonly<Record<string, Digests>> = {
  'synth 2048x1536': {
    masterRgba: '5da94341047ce46637c583ee480520a910dd28cb9391400397c3ce172b31d1bf',
    master: 'b0e1ab8904f998fa6f70d95609238ccff001269320bc8715a50dd9e11a5ef39a',
    plate: 'd3206450095b52b70134d26cb0b211abfb5846ae65ebd809f01b58c84b24f910',
    depth: '16b92f8b5faa41e89a8bd577b613972c42aa7c2c924b33def6d2b905a4a16862',
    sphereMask: '74a63e9ecb94a5a728c20f8d2bffe7dc2f73e7f3350204bff43a1cb35bbf1b11',
    boxMask: 'c6fa054721d445972d98a00f73c7f6063e4aca068aef81a9ea79716eb8bf9033',
    sphereMaskAtMaster: '7badb0579ad019905252a43944ce4457535ab10033297fc3276e7f8c8a691e65',
    boxMaskAtMaster: 'e7ea974c26c69a365e8011f667cf61d773f3a4176926029167c3fb5d5e023b77',
    hole: 'dd34acb292c36e53572751d27f7f759877ecbcafa483dc75079a96f6de3370c9',
    depthNear: '2eab59f00ed72237a22718a55f532bd953f5fe2ff3141e711db5658d2c05411f',
    depthFar: '642d9c7bc1b30b01e3ab786e074b6f6f230eae6204f9816ccb6e1d8f8c0210e7',
    ring: 'c76b022d43216ceebc4233f998326fe0b06be1b05ab43018618b1d38aecc0629',
  },
  'synth 512x384': {
    masterRgba: 'd74c0f9b494402fbb9dc4f4a65af96f80d67d3b9114e0824d856d92e3a9005a0',
    master: 'a02c17b5ec63b7454961c6d79d8775a9a1b474476c3927de4d8e57cdf66a5c48',
    plate: '434810759deb9fefe63e205d32da3713490c5b6d9f3108e61d41369a74951243',
    depth: '16b92f8b5faa41e89a8bd577b613972c42aa7c2c924b33def6d2b905a4a16862',
    sphereMask: '74a63e9ecb94a5a728c20f8d2bffe7dc2f73e7f3350204bff43a1cb35bbf1b11',
    boxMask: 'c6fa054721d445972d98a00f73c7f6063e4aca068aef81a9ea79716eb8bf9033',
    sphereMaskAtMaster: 'e746ce089fa9036931abbbfd2fa237a415b1413a85915dde18ab8ba150aaebc5',
    boxMaskAtMaster: '6f27602566da514dbdc7c539471088f7a242f89eb410bb1c01cf108b08e4b746',
    hole: '2e82e5bb1f136bef99ae2156c0808134cc02a83efff1b7434aa1126a45301e39',
    depthNear: '2eab59f00ed72237a22718a55f532bd953f5fe2ff3141e711db5658d2c05411f',
    depthFar: '642d9c7bc1b30b01e3ab786e074b6f6f230eae6204f9816ccb6e1d8f8c0210e7',
    ring: '743004989969f4f153ebe734176537da0b784c734802270ca8a66df4c2d3a88d',
  },
  'synth-pano 2048x512': {
    masterRgba: '6702c0a0cbbb75815592acaa1e59c319c684b3aff0b8b4ac0ed67212298e66b2',
    master: 'c62219a5773dfacbc40835fda40bd352be375b0e71ccbb0b7c5719767479e947',
    plate: 'e7eb22d405a0dab294cd30b6fd524a20efc28c0da816ed45ce443b5d8a8116ae',
    depth: 'd57e1a7671509eb34ff4fcd71f14d3ebd03172de8851205e8d7e89aa7c402302',
    sphereMask: 'd012cc8d95ff1e98017979f1fec9a6c63eeb75c20f23c480068ab4a9d3b854b7',
    boxMask: '54e914b62edca225c89d91c0456b6694296a377d8f697e4c99d83692b4d69bc6',
    sphereMaskAtMaster: '6a23180a3cc0924343081a3f196df6b5de3ac3f01a6fe06b770b6bb5ad83e503',
    boxMaskAtMaster: '7eb13966dd1041912817b95f111fa1a64143686c0e0daf48523ac4b9c2258021',
    hole: '796ccdcb0f45627e192ecd9ca7322277ce1b1d7071b7436d2ca7dca99f486aaf',
    depthNear: '61f4ed83c5bbe28941d85eebb29217a8103899a517969fcad6f96816418b6712',
    depthFar: '8d15efa1141022dc3dce7316522be18a22b5c30993c63ff739f31acaa08a6389',
    ring: 'd9e867a609f1730e1225f64635b0bef9813b2aee5df5806053661947592bd105',
  },
};

function digests(scene: SynthScene): Digests {
  return {
    masterRgba: sha256(scene.masterRgba()),
    master: sha256(scene.master().data),
    plate: sha256(scene.plate().data),
    depth: sha256(scene.depth().data),
    sphereMask: sha256(scene.sphereMask().data),
    boxMask: sha256(scene.boxMask().data),
    sphereMaskAtMaster: sha256(scene.sphereMask(scene.size).data),
    boxMaskAtMaster: sha256(scene.boxMask(scene.size).data),
    hole: sha256(scene.hole().data),
    depthNear: sha256(scene.depthNear().data),
    depthFar: sha256(scene.depthFar().data),
    ring: sha256(scene.ring().data),
  };
}

const label = (name: string, size: Size): string => `${name} ${size.width}x${size.height}`;

test('every output of every fixture has its pinned digest, and regenerating gives the same bytes', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const key = label(fixture.name, fixture.size);
    const first = digests(synthScene(fixture.size));
    assert.deepEqual(first, PINNED[key], key);
    assert.deepEqual(digests(synthScene(fixture.size)), first, `${key} regenerated`);
  }
});

test('the fixtures have even sides, their outputs the sizes they promise, and an odd master is refused', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const { width, height } = fixture.size;
    assert.ok(width % 2 === 0 && height % 2 === 0, label(fixture.name, fixture.size));
    const scene = synthScene(fixture.size);
    assert.equal(scene.masterRgba().length, width * height * 4);
    assert.deepEqual(scene.master().size, fixture.size);
    assert.equal(scene.master().data.length, width * height * 3);
    assert.deepEqual(scene.plate().size, fixture.size);
    assert.deepEqual(scene.hole().size, fixture.size);
    assert.deepEqual(scene.depth().size, depthInputSize(fixture.size));
    assert.deepEqual(scene.sphereMask().size, maskSize(fixture.size));
    assert.deepEqual(scene.depth({ width: 7, height: 5 }).size, { width: 7, height: 5 });
    assert.deepEqual(scene.depthNear().size, depthInputSize(fixture.size));
    assert.deepEqual(scene.depthFar().size, depthInputSize(fixture.size));
    assert.deepEqual(scene.depthNear({ width: 7, height: 5 }).size, { width: 7, height: 5 });
    assert.deepEqual(scene.ring().size, fixture.size);
  }
  assert.deepEqual(maskSize({ width: 2048, height: 1536 }), { width: 1024, height: 768 });
  assert.deepEqual(maskSize({ width: 512, height: 384 }), { width: 1024, height: 768 });
  assert.deepEqual(maskSize({ width: 2048, height: 512 }), { width: 1024, height: 256 });
  assert.deepEqual(synthScene({ width: 2048, height: 512 }).depth().size, { width: 1190, height: 294 });
  for (const size of [
    { width: 2047, height: 1536 },
    { width: 2048, height: 1535 },
    { width: 1, height: 2 },
  ]) {
    assert.throws(() => synthScene(size), /master: expected even sides, as import makes them/);
  }
  assert.throws(() => synthScene({ width: 0, height: 2 }), /master: expected whole sides of at least 1/);
  assert.throws(() => synthScene({ width: 2.5, height: 2 }), /master: expected whole sides of at least 1/);
});

/** The sphere's disk and the box's face from the geometry alone, at the center of pixel (x, y). */
function inDisk(g: SceneGeometry, x: number, y: number): boolean {
  const dx = x + 0.5 - g.sphere.cx;
  const dy = y + 0.5 - g.sphere.cy;
  return dx * dx + dy * dy <= g.sphere.r * g.sphere.r;
}
function inFace(g: SceneGeometry, x: number, y: number): boolean {
  return x + 0.5 >= g.box.x0 && x + 0.5 < g.box.x1 && y + 0.5 >= g.box.y0 && y + 0.5 < g.box.y1;
}

test('at the master size the masks cover exactly the pixels painted as sphere and as box, and the hole covers what the plate removes', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const key = label(fixture.name, fixture.size);
    const scene = synthScene(fixture.size);
    const g = scene.geometry;
    const { width, height } = fixture.size;
    const master = scene.master().data;
    const plate = scene.plate().data;
    const sphere = scene.sphereMask(fixture.size).data;
    const box = scene.boxMask(fixture.size).data;
    const hole = scene.hole().data;
    let sphereCount = 0;
    let boxCount = 0;
    let removed = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const disk = inDisk(g, x, y);
        const face = inFace(g, x, y);
        assert.ok(!(disk && face), `${key}: the sphere and the box overlap at ${x}, ${y}`);
        if (sphere[i] !== (disk ? 255 : 0)) assert.fail(`${key}: sphere mask at ${x}, ${y}`);
        if (box[i] !== (face ? 255 : 0)) assert.fail(`${key}: box mask at ${x}, ${y}`);
        const shadow = !disk && !face && y + 0.5 > g.yh && inShadow(g, x + 0.5, y + 0.5);
        const differs = master[3 * i] !== plate[3 * i] || master[3 * i + 1] !== plate[3 * i + 1] || master[3 * i + 2] !== plate[3 * i + 2];
        // the plate is the master outside the sphere and its shadow, and differs at every pixel inside them
        if (differs !== (disk || shadow)) assert.fail(`${key}: the plate ${differs ? 'differs' : 'equals the master'} at ${x}, ${y}`);
        if ((disk || shadow) && hole[i] !== 255) assert.fail(`${key}: the hole misses a removed pixel at ${x}, ${y}`);
        if (hole[i] !== 0 && hole[i] !== 255) assert.fail(`${key}: the hole holds ${hole[i]} at ${x}, ${y}`);
        if (disk) sphereCount += 1;
        if (face) boxCount += 1;
        if (disk || shadow) removed += 1;
      }
    }
    const holeCount = hole.reduce((n, v) => n + (v === 255 ? 1 : 0), 0);
    console.log(`${key}: ${sphereCount} sphere pixels, ${boxCount} box pixels, ${removed} removed by the plate, ${holeCount} in the hole`);
    assert.ok(sphereCount > 0 && boxCount > 0 && holeCount > removed);
  }
});

test('the hole is the sphere and its shadow grown by 0.04 of the radius, at pixel centers, 255 inside', () => {
  const scene = synthScene({ width: 512, height: 384 });
  const g = scene.geometry;
  const hole = scene.hole().data;
  const d = SCENE.holeDilation * g.sphere.r;
  for (let y = 0; y < 384; y += 1) {
    for (let x = 0; x < 512; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const disk = (px - g.sphere.cx) ** 2 + (py - g.sphere.cy) ** 2 <= (g.sphere.r + d) ** 2;
      const ellipse = ((px - g.shadow.cx) / (g.shadow.rx + d)) ** 2 + ((py - g.shadow.cy) / (g.shadow.ry + d)) ** 2 <= 1;
      if ((hole[y * 512 + x] === 255) !== (disk || ellipse)) assert.fail(`the hole at ${x}, ${y}`);
    }
  }
});

test('the truth depth: the sphere nearer than the box, both nearer than the sky at 0, the nearest texel 1, and each texel the inverse distance painted there', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const key = label(fixture.name, fixture.size);
    const scene = synthScene(fixture.size);
    const g = scene.geometry;
    const depth = scene.depth();
    const { width: w, height: h } = depth.size;
    const sphere = scene.sphereMask(depth.size).data;
    const box = scene.boxMask(depth.size).data;
    // the nearest texel is the ground at the bottom row's center, (h - 0.5) / h of the master's height
    const bottom = ((h - 0.5) * g.height) / h;
    const nearest = 1 / (g.f / (bottom - g.yh));
    let sphereMin = Infinity;
    let boxMax = -Infinity;
    let max = -Infinity;
    for (let v = 0; v < h; v += 1) {
      const y = ((v + 0.5) * g.height) / h;
      for (let u = 0; u < w; u += 1) {
        const x = ((u + 0.5) * g.width) / w;
        const i = v * w + u;
        const value = depth.data[i] ?? NaN;
        max = Math.max(max, value);
        const surface = surfaceAt(g, x, y, 'master');
        let expected: number;
        if (surface === 'sphere') {
          const nx = (x - g.sphere.cx) / g.sphere.r;
          const ny = (y - g.sphere.cy) / g.sphere.r;
          expected = 1 / (2.2 - 0.55 * Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)));
          sphereMin = Math.min(sphereMin, value);
          assert.equal(sphere[i], 255);
        } else if (surface === 'box') {
          expected = 1 / 10;
          boxMax = Math.max(boxMax, value);
          assert.equal(box[i], 255);
        } else if (surface === 'ground') {
          expected = 1 / (g.f / (y - g.yh));
        } else {
          expected = 0;
        }
        if (value !== Math.fround(expected / nearest)) assert.fail(`${key}: depth at ${u}, ${v} is ${value}, expected ${Math.fround(expected / nearest)}`);
      }
    }
    console.log(`${key}: depth ${w} x ${h}, sphere at least ${sphereMin}, box ${boxMax}`);
    assert.equal(max, 1);
    assert.ok(sphereMin > boxMax, `${key}: the sphere is nearer than the box`);
    assert.ok(boxMax > 0, `${key}: the box is nearer than the sky`);
  }
});

test('the depth check\'s regions: near strictly inside 0.8 of the sphere\'s radius, far strictly inside the box\'s face inset by 0.1 a side, at texel centers, apart', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const key = label(fixture.name, fixture.size);
    const scene = synthScene(fixture.size);
    const g = scene.geometry;
    const size = depthInputSize(fixture.size);
    const near = scene.depthNear().data;
    const far = scene.depthFar().data;
    const bw = g.box.x1 - g.box.x0;
    const bh = g.box.y1 - g.box.y0;
    let nearCount = 0;
    let farCount = 0;
    for (let v = 0; v < size.height; v += 1) {
      const y = ((v + 0.5) * g.height) / size.height;
      for (let u = 0; u < size.width; u += 1) {
        const x = ((u + 0.5) * g.width) / size.width;
        const i = v * size.width + u;
        const inNear = (x - g.sphere.cx) ** 2 + (y - g.sphere.cy) ** 2 < (0.8 * g.sphere.r) ** 2;
        const inFar = x > g.box.x0 + 0.1 * bw && x < g.box.x1 - 0.1 * bw && y > g.box.y0 + 0.1 * bh && y < g.box.y1 - 0.1 * bh;
        if (near[i] !== (inNear ? 255 : 0)) assert.fail(`${key}: near at ${u}, ${v}`);
        if (far[i] !== (inFar ? 255 : 0)) assert.fail(`${key}: far at ${u}, ${v}`);
        if (inNear && inFar) assert.fail(`${key}: the regions overlap at ${u}, ${v}`);
        if (inNear) nearCount += 1;
        if (inFar) farCount += 1;
      }
    }
    console.log(`${key}: depth ${size.width} x ${size.height}, ${nearCount} near texels, ${farCount} far texels`);
    assert.ok(nearCount > 0 && farCount > 0, key);
  }
});

test('the ring: every second pixel each way from the corner of the sphere and shadow\'s bounds grown by 0.3 of the radius, inside that growth and outside the hole', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const key = label(fixture.name, fixture.size);
    const scene = synthScene(fixture.size);
    const g = scene.geometry;
    const { width, height } = fixture.size;
    const ring = scene.ring().data;
    const hole = scene.hole().data;
    const d = 0.3 * g.sphere.r;
    const x0 = Math.max(0, Math.floor(Math.min(g.sphere.cx - g.sphere.r - d, g.shadow.cx - g.shadow.rx - d)));
    const y0 = Math.max(0, Math.floor(g.sphere.cy - g.sphere.r - d));
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const px = x + 0.5;
        const py = y + 0.5;
        const grown = (px - g.sphere.cx) ** 2 + (py - g.sphere.cy) ** 2 <= (g.sphere.r + d) ** 2 || ((px - g.shadow.cx) / (g.shadow.rx + d)) ** 2 + ((py - g.shadow.cy) / (g.shadow.ry + d)) ** 2 <= 1;
        const sampled = x >= x0 && y >= y0 && (x - x0) % 2 === 0 && (y - y0) % 2 === 0;
        const expected = sampled && grown && hole[i] === 0;
        if (ring[i] !== (expected ? 255 : 0)) assert.fail(`${key}: ring at ${x}, ${y}`);
        if (expected) count += 1;
      }
    }
    console.log(`${key}: ${count} ring pixels`);
    assert.ok(count > 0, key);
  }
});
