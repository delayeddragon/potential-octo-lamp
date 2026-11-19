/**
 * RuneDeck — geometry helpers shared by the battlefield, its scenery and the unit layer.
 *
 * Static props are built from primitives and merged into a handful of meshes;
 * `Batch` does the merging and `pen` is the drawing API on top of it.
 */

import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const LIGHT_DIR = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();

export function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const EDGE = new THREE.Vector3();
const NORMAL = new THREE.Vector3();
const LOW = new THREE.Color();
const HIGH = new THREE.Color();
const TINT = new THREE.Color();

/**
 * Collects flat-shaded triangles from many primitives into one geometry.
 * Each piece gets a bottom-to-top colour gradient; `facet` bakes simple
 * directional shading into the colours for unlit, glowing pieces.
 */
export class Batch {
  positions = [];
  normals = [];
  colors = [];
  sways = [];
  /**
   * While set, every vertex added records how far it stands above this height,
   * which the foliage material turns into sway: treetops move, trunks do not.
   */
  swayBase = null;

  add(geometry, matrix, bottom, top = bottom, facet = 0) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const source = flat.getAttribute('position');
    flat.computeBoundingBox();
    const minY = flat.boundingBox.min.y;
    const spanY = Math.max(flat.boundingBox.max.y - minY, 1e-6);
    LOW.set(bottom);
    HIGH.set(top);

    for (let i = 0; i < source.count; i += 3) {
      A.fromBufferAttribute(source, i);
      B.fromBufferAttribute(source, i + 1);
      C.fromBufferAttribute(source, i + 2);
      const heights = [(A.y - minY) / spanY, (B.y - minY) / spanY, (C.y - minY) / spanY];
      A.applyMatrix4(matrix);
      B.applyMatrix4(matrix);
      C.applyMatrix4(matrix);
      NORMAL.subVectors(B, A).cross(EDGE.subVectors(C, A)).normalize();

      let shade = 1;
      let shine = 0;
      if (facet) {
        const lit = Math.max(NORMAL.dot(LIGHT_DIR), 0);
        shade = 1 - facet + facet * lit;
        shine = lit ** 6 * facet * 0.6;
      }
      [A, B, C].forEach((vertex, n) => {
        this.positions.push(vertex.x, vertex.y, vertex.z);
        this.normals.push(NORMAL.x, NORMAL.y, NORMAL.z);
        TINT.lerpColors(LOW, HIGH, heights[n]);
        this.colors.push(TINT.r * shade + shine, TINT.g * shade + shine, TINT.b * shade + shine);
        if (this.swayBase !== null) this.sways.push(Math.max(0, vertex.y - this.swayBase));
      });
    }
    if (flat !== geometry) flat.dispose();
  }

  geometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    if (this.sways.length) geometry.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sways, 1));
    return geometry;
  }

  build(material) {
    return new THREE.Mesh(this.geometry(), material);
  }
}

/** A hexagonal prism with a pointed tip. */
function crystalGeometry(radius, height) {
  const body = new THREE.CylinderGeometry(radius * 0.8, radius, height * 0.7, 6).translate(0, height * 0.35, 0).toNonIndexed();
  const tip = new THREE.ConeGeometry(radius * 0.8, height * 0.3, 6).translate(0, height * 0.85, 0).toNonIndexed();
  const merged = new Float32Array(body.attributes.position.count * 3 + tip.attributes.position.count * 3);
  merged.set(body.attributes.position.array, 0);
  merged.set(tip.attributes.position.array, body.attributes.position.count * 3);
  body.dispose();
  tip.dispose();
  return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(merged, 3));
}

const EULER = new THREE.Euler();
const QUAT = new THREE.Quaternion();
const MATRIX = new THREE.Matrix4();
const POSITION = new THREE.Vector3();
const SCALE = new THREE.Vector3();

/**
 * Drawing helpers that add primitives to a lit and a glowing batch. Every shape
 * sits with its base at (x, y, z), so `rx`/`rz` lean it about its foot.
 * Options: top (gradient colour), glow, rx, ry, rz, sx, sy, sz.
 */
export function pen(solid, glow, ox = 0, oz = 0) {
  const put = (geometry, color, x, y, z, o = {}) => {
    EULER.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    MATRIX.compose(POSITION.set(ox + x, y, oz + z), QUAT.setFromEuler(EULER), SCALE.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    (o.glow ? glow : solid).add(geometry, MATRIX, color, o.top ?? color, o.glow ? 0.42 : 0);
    geometry.dispose();
  };
  return {
    box: (color, x, y, z, w, h, d, o) => put(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), color, x, y, z, o),
    cyl: (color, x, y, z, top, bottom, h, sides = 8, o) =>
      put(new THREE.CylinderGeometry(top, bottom, h, sides).translate(0, h / 2, 0), color, x, y, z, o),
    cone: (color, x, y, z, r, h, sides = 6, o) => put(new THREE.ConeGeometry(r, h, sides).translate(0, h / 2, 0), color, x, y, z, o),
    gem: (color, x, y, z, r, h, o) =>
      put(new THREE.OctahedronGeometry(1).scale(r, h / 2, r).translate(0, h / 2, 0), color, x, y, z, o),
    crystal: (color, x, y, z, r, h, o) => put(crystalGeometry(r, h), color, x, y, z, o),
    /** Centred on (x, y, z) rather than resting on it. */
    rock: (color, x, y, z, r, o) => put(new THREE.IcosahedronGeometry(r, 0), color, x, y, z, o),
  };
}

/** Lean a shape away from (or, with a negative angle, towards) its structure's axis. */
export const lean = (angle, amount) => ({ rz: -Math.cos(angle) * amount, rx: Math.sin(angle) * amount });

export function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
