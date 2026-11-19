/**
 * RuneDeck — sculpting kit for characters, the Guardian and the structures.
 *
 * Where geometry.js collects flat-shaded scenery, this builds smooth,
 * many-part models: capsules, spheres, lathed and extruded shapes and swept
 * tubes, each painted with a colour gradient and a surface finish (how
 * metallic, how rough, how brightly it glows). Every vertex also names the
 * bone that carries it, so one model can be posed three ways:
 *
 *  - `Sculpt#geometry()`  a static mesh;
 *  - `Sculpt#skinned()`   a THREE.SkinnedMesh (the heroes, the dragon);
 *  - `Sculpt#rigid()`     an instanced rig: one draw call for every unit of a
 *                         kind, each instance posed by its own row of a bone
 *                         texture (see `createRig`).
 *
 * All of them share one material: a MeshStandardMaterial that reads the finish
 * from the vertices and adds a rim light, so armour, cloth and glowing runes
 * are a single mesh.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import { LIGHT_DIR, TAU, seededRandom } from './geometry.js';

/** Surface finishes: [metalness, roughness, glow]. Glow above 1 blooms. */
export const FINISH = {
  cloth: [0, 0.92, 0],
  leather: [0, 0.66, 0],
  skin: [0, 0.7, 0],
  stone: [0, 0.9, 0],
  bone: [0, 0.48, 0],
  wood: [0, 0.78, 0],
  steel: [0.88, 0.45, 0],
  chrome: [1, 0.33, 0],
  gold: [1, 0.36, 0],
  iron: [0.72, 0.5, 0],
  obsidian: [0.4, 0.22, 0],
  scale: [0.3, 0.4, 0],
  membrane: [0, 0.6, 0.12],
  crystal: [0.1, 0.12, 0.5],
  glow: [0, 0.5, 1.25],
  ember: [0, 0.6, 1.8],
};

/** A paint: a bottom-to-top colour gradient and a finish. `glow` overrides the finish's own. */
export function paint(low, high = low, finish = FINISH.cloth, glow) {
  return {
    low: new THREE.Color(low),
    high: new THREE.Color(high),
    finish: glow === undefined ? finish : [finish[0], finish[1], glow],
  };
}

const MATRIX = new THREE.Matrix4();
const LOCAL = new THREE.Matrix4();
const NORMAL_MATRIX = new THREE.Matrix3();
const EULER = new THREE.Euler();
const QUAT = new THREE.Quaternion();
const POSITION = new THREE.Vector3();
const SCALE = new THREE.Vector3();
const V = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TINT = new THREE.Color();

/** Placement options shared by every primitive: turn (rx, ry, rz) and stretch (s, sx, sy, sz). */
function place(target, x, y, z, o) {
  EULER.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, o.order ?? 'XYZ');
  const s = o.s ?? 1;
  return target.compose(POSITION.set(x, y, z), QUAT.setFromEuler(EULER), SCALE.set((o.sx ?? 1) * s, (o.sy ?? 1) * s, (o.sz ?? 1) * s));
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Reads `values` (a number, an array spread evenly along 0..1, or a function) at `u`. */
function sample(values, u) {
  if (typeof values === 'function') return values(u);
  if (!Array.isArray(values)) return values;
  const at = Math.min(Math.max(u, 0), 1) * (values.length - 1);
  const i = Math.min(Math.floor(at), values.length - 2);
  return values.length === 1 ? values[0] : lerp(values[i], values[i + 1], at - i);
}

export class Sculpt {
  positions = [];
  normals = [];
  colors = [];
  surfaces = [];
  /** Per vertex: [bone, second bone, weight of the second]. */
  skins = [];
  index = [];
  #stack = [new THREE.Matrix4()];
  #bone = 0;

  get count() {
    return this.positions.length / 3;
  }

  /** Every shape added from now on is carried by this bone. */
  bone(index) {
    this.#bone = index;
    return this;
  }

  /** Runs `draw` inside a moved, turned and scaled frame: a sub-assembly modelled about its own origin. */
  group(x, y, z, o, draw) {
    const top = this.#stack[this.#stack.length - 1];
    this.#stack.push(new THREE.Matrix4().multiplyMatrices(top, place(LOCAL, x, y, z, o ?? {})));
    draw();
    this.#stack.pop();
    return this;
  }

  /**
   * Adds a geometry, which is then disposed of.
   * @param o.matrix  a ready local matrix, instead of the placement options
   * @param o.facet   flat-shade it
   * @param o.along   axis of the colour gradient: 'y' (default), 'x' or 'z'
   * @param o.tint    (x, y, z) => 0..1 gradient position, from the shape's own coordinates
   * @param o.skin    (x, y, z) => [bone, second, weight], from the model's coordinates
   * @param o.bone    bone for this shape alone
   */
  add(geometry, ink, x = 0, y = 0, z = 0, o = {}) {
    let source = geometry;
    if (o.facet) {
      source = geometry.index ? geometry.toNonIndexed() : geometry;
      source.computeVertexNormals();
    }
    const top = this.#stack[this.#stack.length - 1];
    MATRIX.multiplyMatrices(top, o.matrix ?? place(LOCAL, x, y, z, o));
    const mirrored = MATRIX.determinant() < 0;
    NORMAL_MATRIX.getNormalMatrix(MATRIX);

    const position = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    const tints = source.getAttribute('tint');
    const skins = source.userData.skins;
    const axis = o.along ?? 'y';
    source.computeBoundingBox();
    const min = source.boundingBox.min[axis];
    const span = Math.max(source.boundingBox.max[axis] - min, 1e-6);
    const bone = o.bone ?? this.#bone;
    const base = this.count;
    const [metal, rough, glow] = ink.finish;

    for (let i = 0; i < position.count; i++) {
      V.fromBufferAttribute(position, i);
      const t = tints ? tints.getX(i) : o.tint ? o.tint(V.x, V.y, V.z) : (V[axis] - min) / span;
      V.applyMatrix4(MATRIX);
      this.positions.push(V.x, V.y, V.z);
      const skin = o.skin ? o.skin(V.x, V.y, V.z) : skins ? skins[i] : null;
      if (skin) this.skins.push(skin[0], skin[1], skin[2]);
      else this.skins.push(bone, bone, 0);
      V.fromBufferAttribute(normal, i).applyMatrix3(NORMAL_MATRIX).normalize();
      this.normals.push(V.x, V.y, V.z);
      TINT.lerpColors(ink.low, ink.high, Math.min(Math.max(t, 0), 1));
      this.colors.push(TINT.r, TINT.g, TINT.b);
      this.surfaces.push(metal, rough, glow);
    }

    const order = source.index;
    const corners = order ? order.count : position.count;
    for (let i = 0; i < corners; i += 3) {
      const a = base + (order ? order.getX(i) : i);
      const b = base + (order ? order.getX(i + 1) : i + 1);
      const c = base + (order ? order.getX(i + 2) : i + 2);
      // A mirrored shape is wound the other way round.
      if (mirrored) this.index.push(a, c, b);
      else this.index.push(a, b, c);
    }
    if (source !== geometry) source.dispose();
    geometry.dispose();
    return this;
  }

  /* ------------------------------------------------------------ Primitives */

  ball(ink, x, y, z, radius, o = {}) {
    return this.add(new THREE.SphereGeometry(radius, o.seg ?? 14, o.rings ?? 10), ink, x, y, z, o);
  }

  /** An upright capsule centred on (x, y, z); `length` is that of its straight middle. */
  capsule(ink, x, y, z, radius, length, o = {}) {
    return this.add(new THREE.CapsuleGeometry(radius, length, o.cap ?? 4, o.seg ?? 10), ink, x, y, z, o);
  }

  /** A round-ended limb from point `a` to point `b`, `ra` thick at the first and `rb` at the second. */
  limb(ink, a, b, ra, rb = ra, o = {}) {
    V.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const length = V.length();
    const profile = [];
    const cap = o.cap ?? 4;
    for (let i = 0; i <= cap; i++) {
      const angle = (i / cap) * Math.PI * 0.5;
      profile.push(new THREE.Vector2(Math.sin(angle) * ra, -Math.cos(angle) * ra));
    }
    for (let i = 0; i <= cap; i++) {
      const angle = (i / cap) * Math.PI * 0.5;
      profile.push(new THREE.Vector2(Math.cos(angle) * rb, length + Math.sin(angle) * rb));
    }
    QUAT.setFromUnitVectors(UP, V.normalize());
    const matrix = new THREE.Matrix4().compose(POSITION.set(a[0], a[1], a[2]), QUAT, SCALE.set(o.sx ?? 1, 1, o.sz ?? 1));
    return this.add(new THREE.LatheGeometry(profile, o.seg ?? 10), ink, 0, 0, 0, { ...o, matrix });
  }

  /** A cylinder standing on (x, y, z). */
  cyl(ink, x, y, z, top, bottom, height, o = {}) {
    return this.add(new THREE.CylinderGeometry(top, bottom, height, o.seg ?? 14, 1, o.open ?? false).translate(0, height / 2, 0), ink, x, y, z, o);
  }

  cone(ink, x, y, z, radius, height, o = {}) {
    return this.add(new THREE.ConeGeometry(radius, height, o.seg ?? 10).translate(0, height / 2, 0), ink, x, y, z, o);
  }

  /** A ring lying flat about (x, y, z); `arc` leaves it open. */
  torus(ink, x, y, z, radius, tube, o = {}) {
    return this.add(new THREE.TorusGeometry(radius, tube, o.sides ?? 8, o.seg ?? 24, o.arc ?? TAU).rotateX(Math.PI / 2), ink, x, y, z, o);
  }

  /** A profile of [radius, height] pairs spun about the vertical through (x, y, z). */
  lathe(ink, x, y, z, profile, o = {}) {
    const points = profile.map(([r, h]) => new THREE.Vector2(r, h));
    return this.add(new THREE.LatheGeometry(points, o.seg ?? 16, o.start ?? 0, o.arc ?? TAU), ink, x, y, z, o);
  }

  /**
   * An outline of [x, y] points given thickness along z, centred on its own depth.
   * `bevel` chamfers the rim (a blade's edge); `smooth` runs a curve through the points.
   */
  extrude(ink, x, y, z, outline, depth, o = {}) {
    const shape = new THREE.Shape();
    const points = outline.map(([px, py]) => new THREE.Vector2(px, py));
    if (o.smooth) {
      shape.moveTo(points[0].x, points[0].y);
      shape.splineThru([...points.slice(1), points[0]]);
    } else {
      shape.setFromPoints(points);
    }
    const bevel = o.bevel ?? 0;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      steps: 1,
      curveSegments: o.curve ?? 8,
      bevelEnabled: bevel > 0,
      bevelThickness: o.bevelDepth ?? bevel,
      bevelSize: bevel,
      bevelSegments: o.bevelSeg ?? 1,
    }).translate(0, 0, -depth / 2);
    return this.add(geometry, ink, x, y, z, o);
  }

  /** A box standing on (x, y, z); `round` softens its edges. */
  box(ink, x, y, z, width, height, depth, o = {}) {
    const geometry = o.round ? new RoundedBoxGeometry(width, height, depth, 2, o.round) : new THREE.BoxGeometry(width, height, depth);
    return this.add(geometry.translate(0, height / 2, 0), ink, x, y, z, o);
  }

  /**
   * A curved plate standing on (x, y, z) and facing +Z: shields, armour plates, cloaks.
   * `half(v)` is its half-width at height v (0 at the foot, 1 at the top). `bend` bows
   * the sides back, `dome` swells the face, `thick` is its thickness.
   */
  plate(ink, x, y, z, height, half, o = {}) {
    const nu = o.nu ?? 8;
    const nv = o.nv ?? 10;
    const thick = o.thick ?? 0.02;
    const bend = o.bend ?? 0;
    const dome = o.dome ?? 0;
    const positions = [];
    const index = [];
    const at = (i, j, face) => {
      const u = (i / nu) * 2 - 1;
      const v = j / nv;
      const px = u * Math.max(half(v), 1e-4);
      positions.push(px, v * height, -bend * px * px + (face * thick) / 2 + (face > 0 ? dome * (1 - u * u) * 4 * v * (1 - v) : 0));
      return positions.length / 3 - 1;
    };
    for (const face of [1, -1]) {
      const base = positions.length / 3;
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) at(i, j, face);
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const a = base + j * (nu + 1) + i;
          const c = a + nu + 1;
          if (face > 0) index.push(a, a + 1, c, a + 1, c + 1, c);
          else index.push(a, c, a + 1, a + 1, c, c + 1);
        }
      }
    }
    // The rim, walked anticlockwise as seen from the front.
    const loop = [];
    for (let i = 0; i < nu; i++) loop.push([i, 0]);
    for (let j = 0; j < nv; j++) loop.push([nu, j]);
    for (let i = nu; i > 0; i--) loop.push([i, nv]);
    for (let j = nv; j > 0; j--) loop.push([0, j]);
    loop.forEach(([i, j], k) => {
      const [ni, nj] = loop[(k + 1) % loop.length];
      const pf = at(i, j, 1);
      const pb = at(i, j, -1);
      const qb = at(ni, nj, -1);
      const qf = at(ni, nj, 1);
      index.push(pf, pb, qb, pf, qb, qf);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return this.add(geometry, ink, x, y, z, o);
  }

  /** A chain: `links` small rings threaded round a circle of `radius` lying flat about (x, y, z). */
  chain(ink, x, y, z, radius, o = {}) {
    const links = o.links ?? 18;
    const size = o.link ?? (radius * Math.PI) / links;
    return this.group(x, y, z, o, () => {
      for (let i = 0; i < links; i++) {
        const angle = (i / links) * TAU;
        const geometry = new THREE.TorusGeometry(size * 0.9, size * 0.3, 5, 8).scale(1.35, 1, 1).rotateX(i % 2 ? Math.PI / 2 : 0).rotateY(-angle + Math.PI / 2);
        this.add(geometry, ink, Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      }
    });
  }

  /** A faceted double pyramid centred on (x, y, z). */
  gem(ink, x, y, z, radius, height, o = {}) {
    return this.add(new THREE.OctahedronGeometry(1).scale(radius, height / 2, radius), ink, x, y, z, { facet: true, ...o });
  }

  /** A six-sided crystal with a pointed tip, standing on (x, y, z). */
  crystal(ink, x, y, z, radius, height, o = {}) {
    const profile = [new THREE.Vector2(radius * 0.72, 0), new THREE.Vector2(radius, height * 0.18), new THREE.Vector2(radius * 0.8, height * 0.72), new THREE.Vector2(0, height)];
    return this.add(new THREE.LatheGeometry(profile, 6), ink, x, y, z, { facet: true, ...o });
  }

  /** A boulder: a sphere knocked out of true. `facet` (default) leaves it chiselled, otherwise it is worn smooth. */
  rock(ink, x, y, z, radius, o = {}) {
    const random = seededRandom(Math.round((o.seed ?? x * 37.1 + y * 17.3 + z * 91.7 + radius * 53) * 1000));
    const lumps = Array.from({ length: 6 }, () => [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, 0.5 + random()]);
    let geometry = new THREE.IcosahedronGeometry(1, o.detail ?? 1);
    geometry.deleteAttribute('uv');
    geometry.deleteAttribute('normal');
    geometry = mergeVertices(geometry, 1e-4);
    const position = geometry.getAttribute('position');
    const rough = o.rough ?? 0.16;
    for (let i = 0; i < position.count; i++) {
      V.fromBufferAttribute(position, i);
      let push = 0;
      for (const [lx, ly, lz, w] of lumps) push += Math.sin((V.x * lx + V.y * ly + V.z * lz) * 3.1 * w + w * 5);
      V.multiplyScalar(radius * (1 + (push / lumps.length) * rough * 2));
      position.setXYZ(i, V.x, V.y, V.z);
    }
    geometry.computeVertexNormals();
    return this.add(geometry, ink, x, y, z, { facet: true, ...o });
  }

  /**
   * A tube swept along a curve through `points`: necks, tails, horns, plumes, bows.
   * @param radius   thickness along the way: a number, an array spread evenly, or u => radius
   * @param o.flat   [across, upright] stretch of the cross-section (each a number, array or function of u)
   * @param o.up     the direction the cross-section's "top" keeps to
   * @param o.tint   (u, v) => 0..1 gradient position; v runs round the section, 0.25 on top and 0.75 underneath
   * @param o.bump   (u, v) => multiplier of the radius: scales, ridges
   * @param o.skin   u => [bone, second, weight]
   */
  tube(ink, points, radius, o = {}) {
    const curve = new THREE.CatmullRomCurve3(points.map(([px, py, pz]) => new THREE.Vector3(px, py, pz)), false, 'centripetal');
    const steps = o.steps ?? Math.max(6, (points.length - 1) * 5);
    const sides = o.sides ?? 8;
    const [across, upright] = o.flat ?? [1, 1];
    const up = new THREE.Vector3(...(o.up ?? [0, 1, 0]));
    const side = new THREE.Vector3();
    const before = new THREE.Vector3();
    const rise = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const at = new THREE.Vector3();
    const positions = [];
    const normals = [];
    const tints = [];
    const skins = [];
    const index = [];
    // A cap puts its centre between two rings, so each ring remembers where it starts.
    let last = 0;

    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      curve.getPoint(u, at);
      curve.getTangent(u, tangent);
      side.crossVectors(up, tangent);
      if (side.lengthSq() < 1e-4) side.copy(i ? before : V.set(1, 0, 0));
      side.normalize();
      // Where the curve doubles back over itself the cross product flips; keep the section from twisting.
      if (i && side.dot(before) < 0) side.negate();
      before.copy(side);
      rise.crossVectors(tangent, side).normalize();
      const fx = sample(across, u);
      const fy = sample(upright, u);
      const r = sample(radius, u);
      const skin = o.skin ? o.skin(u) : null;
      const row = positions.length / 3;
      for (let j = 0; j <= sides; j++) {
        const v = j / sides;
        const cos = Math.cos(v * TAU);
        const sin = Math.sin(v * TAU);
        const reach = r * (o.bump ? o.bump(u, v) : 1);
        positions.push(at.x + (side.x * cos * fx + rise.x * sin * fy) * reach, at.y + (side.y * cos * fx + rise.y * sin * fy) * reach, at.z + (side.z * cos * fx + rise.z * sin * fy) * reach);
        V.set(side.x * cos * fy + rise.x * sin * fx, side.y * cos * fy + rise.y * sin * fx, side.z * cos * fy + rise.z * sin * fx).normalize();
        normals.push(V.x, V.y, V.z);
        tints.push(o.tint ? o.tint(u, v) : u);
        if (skin) skins.push(skin);
      }
      if (i) {
        for (let j = 0; j < sides; j++) {
          const a = last + j;
          const b = row + j;
          index.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
      last = row;
      // Blunt ends are closed with a fan.
      if ((i === 0 || i === steps) && o.caps !== false && r > 1e-3) {
        const centre = positions.length / 3;
        const sign = i === 0 ? -1 : 1;
        positions.push(at.x, at.y, at.z);
        normals.push(tangent.x * sign, tangent.y * sign, tangent.z * sign);
        tints.push(o.tint ? o.tint(u, 0.5) : u);
        if (skin) skins.push(skin);
        for (let j = 0; j < sides; j++) {
          if (i === 0) index.push(centre, row + j + 1, row + j);
          else index.push(centre, row + j, row + j + 1);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('tint', new THREE.Float32BufferAttribute(tints, 1));
    geometry.setIndex(index);
    if (skins.length) geometry.userData.skins = skins;
    return this.add(geometry, ink, 0, 0, 0, { ...o, skin: undefined, tint: undefined });
  }

  /* ------------------------------------------------------------ Results */

  #base(positions = this.positions) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('aSurface', new THREE.Float32BufferAttribute(this.surfaces, 3));
    geometry.setIndex(this.index);
    return geometry;
  }

  /** A static mesh's geometry. */
  geometry() {
    return this.#base();
  }

  /** Geometry for a THREE.SkinnedMesh: each vertex follows its bone, or blends two. */
  skinned() {
    const geometry = this.#base();
    const indices = [];
    const weights = [];
    for (let i = 0; i < this.skins.length; i += 3) {
      indices.push(this.skins[i], this.skins[i + 1], 0, 0);
      weights.push(1 - this.skins[i + 2], this.skins[i + 2], 0, 0);
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    return geometry;
  }

  /**
   * Geometry for an instanced rig: every vertex is stored relative to the pivot
   * of the one bone that carries it, and names that bone in `aBone`.
   */
  rigid(bones) {
    const positions = new Float32Array(this.positions);
    const carriers = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const bone = this.skins[i * 3];
      const [px, py, pz] = bones[bone].at;
      positions[i * 3] -= px;
      positions[i * 3 + 1] -= py;
      positions[i * 3 + 2] -= pz;
      carriers[i] = bone;
    }
    const geometry = this.#base(positions);
    geometry.setAttribute('aBone', new THREE.BufferAttribute(carriers, 1));
    return geometry;
  }
}

/* -------------------------------------------------------------------------- */
/* Skeletons                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Names a list of bones. Each is [name, parent name or null, x, y, z]: the
 * pivot it turns about, in the model's own rest pose. Parents come first.
 * Returns the bones as { name, parent (index, -1 for a root), at } with an
 * index by name on the array itself (`bones.id.head`).
 */
export function defineBones(list) {
  const id = {};
  const bones = list.map(([name, parent, x, y, z], index) => {
    id[name] = index;
    return { name, parent: parent === null ? -1 : id[parent], at: [x, y, z] };
  });
  bones.id = id;
  return bones;
}

/** THREE.Bone objects for a bone list, ready to bind: { bones, skeleton, root, [name]: bone }. */
export function buildSkeleton(list) {
  const bones = list.map(({ name, parent, at }) => {
    const bone = new THREE.Bone();
    bone.name = name;
    const from = parent < 0 ? [0, 0, 0] : list[parent].at;
    bone.position.set(at[0] - from[0], at[1] - from[1], at[2] - from[2]);
    return bone;
  });
  const roots = [];
  list.forEach(({ parent }, index) => (parent < 0 ? roots.push(bones[index]) : bones[parent].add(bones[index])));
  for (const root of roots) root.updateMatrixWorld(true);
  const named = Object.fromEntries(bones.map((bone) => [bone.name, bone]));
  return { ...named, bones, roots, skeleton: new THREE.Skeleton(bones) };
}

/* -------------------------------------------------------------------------- */
/* Material                                                                   */
/* -------------------------------------------------------------------------- */

const RIG_PARS = /* glsl */ `
attribute float aBone;
uniform highp sampler2D uBones;
// One row of the texture per instance, four texels (a matrix's columns) per bone.
mat4 rigBone() {
  int x = int(aBone + 0.5) * 4;
  return mat4(
    texelFetch(uBones, ivec2(x, gl_InstanceID), 0),
    texelFetch(uBones, ivec2(x + 1, gl_InstanceID), 0),
    texelFetch(uBones, ivec2(x + 2, gl_InstanceID), 0),
    texelFetch(uBones, ivec2(x + 3, gl_InstanceID), 0));
}
`;

/**
 * The lit material every sculpted model wears. Metalness, roughness and glow
 * come from the vertices; a rim light picks the silhouette out of the ground.
 *
 * @param o.envMap    a prefiltered environment for the metal to reflect
 * @param o.rim       colour of the rim light (a team colour), and `o.rimStrength`
 * @param o.bones     { value: bone texture } for an instanced rig
 * @param o.physical  MeshPhysicalMaterial parameters (clearcoat, sheen...), instead of a standard material
 * The material's `userData.uniforms` holds `uRim` and `uPulse` (extra glow, 0 at rest).
 */
export function surfaceMaterial({ envMap = null, envIntensity = 1, rim = 0x000000, rimStrength = 0.45, bones = null, physical = null, side = THREE.FrontSide } = {}) {
  const base = { vertexColors: true, envMap, envMapIntensity: envIntensity, side };
  const material = physical ? new THREE.MeshPhysicalMaterial({ ...base, ...physical }) : new THREE.MeshStandardMaterial(base);
  const uniforms = { uRim: { value: new THREE.Color(rim).multiplyScalar(rimStrength) }, uPulse: { value: 0 } };
  if (bones) uniforms.uBones = bones;
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 aSurface;\nvarying vec3 vSurface;\n${bones ? RIG_PARS : ''}`)
      .replace('#include <beginnormal_vertex>', bones ? 'mat4 rigMatrix = rigBone();\nvec3 objectNormal = mat3(rigMatrix) * normal;' : '#include <beginnormal_vertex>')
      .replace('#include <begin_vertex>', `${bones ? 'vec3 transformed = (rigMatrix * vec4(position, 1.0)).xyz;' : '#include <begin_vertex>'}\nvSurface = aSurface;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurface;\nuniform vec3 uRim;\nuniform float uPulse;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vSurface.y;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vSurface.x;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rimLight = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += diffuseColor.rgb * vSurface.z * (1.0 + uPulse) + uRim * rimLight * (1.0 - min(vSurface.z, 1.0));`,
      );
  };
  material.customProgramCacheKey = () => `sculpt:${bones ? 'rig' : 'plain'}`;
  return material;
}

/** The shadow pass of an instanced rig: the same bones, depth only. */
function rigDepthMaterial(bones) {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = bones;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_PARS}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = (rigBone() * vec4(position, 1.0)).xyz;');
  };
  material.customProgramCacheKey = () => 'sculpt:rig-depth';
  return material;
}

/**
 * A flat, additive copy of an instanced rig's look, reading its own frozen
 * bone texture: the afterimage a hero leaves behind.
 */
export function ghostMaterial(bones, color) {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = bones;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_PARS}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = (rigBone() * vec4(position, 1.0)).xyz;');
  };
  material.customProgramCacheKey = () => 'sculpt:rig-ghost';
  return material;
}

/**
 * A small sky for armour to reflect: a dusk gradient with a warm key light where
 * the sun stands and a cool one behind. Only sculpted models use it, so the
 * terrain and scenery are lit exactly as before. Returns null where the GPU
 * cannot prefilter one; the models are then lit by the scene lights alone.
 */
export function studioEnvironment(renderer) {
  // Prefiltering draws into half-float targets. A GPU without them gets no reflections rather than a broken map.
  if (!renderer.extensions.has('EXT_color_buffer_float') && !renderer.extensions.has('EXT_color_buffer_half_float')) return null;
  const scene = new THREE.Scene();
  const dome = new THREE.SphereGeometry(40, 24, 16);
  const colors = [];
  const position = dome.getAttribute('position');
  const zenith = new THREE.Color(0x9fc2ff);
  const horizon = new THREE.Color(0x6a7fb0);
  const ground = new THREE.Color(0x1c2030);
  for (let i = 0; i < position.count; i++) {
    const h = position.getY(i) / 40;
    if (h >= 0) TINT.lerpColors(horizon, zenith, h ** 0.6);
    else TINT.lerpColors(horizon, ground, Math.min(1, -h * 3));
    colors.push(TINT.r, TINT.g, TINT.b);
  }
  dome.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const card = (direction, size, color, strength) => {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(size, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(strength), side: THREE.DoubleSide }));
    mesh.position.copy(direction).multiplyScalar(30);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  card(LIGHT_DIR, 7, 0xfff0d8, 2.2);
  card(new THREE.Vector3(0.7, 0.35, -0.6).normalize(), 9, 0x9ad0ff, 1.6);
  card(new THREE.Vector3(-0.2, 0.3, -0.95).normalize(), 6, 0xffffff, 1.1);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const { texture } = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  dome.dispose();
  return texture;
}

/* -------------------------------------------------------------------------- */
/* Instanced rigs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One draw call of posed, instanced models. Set a pose in `rot` (three Euler
 * angles per bone), `shift` (an offset per bone) and `size` (a scale per bone),
 * then `write(instance)` bakes it into that instance's row of the bone texture.
 * The instance matrix still places the whole model in the world.
 */
export function createRig(sculpt, bones, capacity, materialOptions) {
  const count = bones.length;
  const width = count * 4;
  const data = new Float32Array(width * capacity * 4);
  const texture = new THREE.DataTexture(data, width, capacity, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  const uniform = { value: texture };

  const mesh = new THREE.InstancedMesh(sculpt.rigid(bones), surfaceMaterial({ ...materialOptions, bones: uniform }), capacity);
  mesh.customDepthMaterial = rigDepthMaterial(uniform);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;

  const offsets = bones.map(({ parent, at }) => {
    const from = parent < 0 ? [0, 0, 0] : bones[parent].at;
    return [at[0] - from[0], at[1] - from[1], at[2] - from[2]];
  });
  const world = bones.map(() => new THREE.Matrix4());
  const local = new THREE.Matrix4();
  const rot = new Float32Array(count * 3);
  const shift = new Float32Array(count * 3);
  const size = new Float32Array(count).fill(1);

  return {
    mesh,
    texture,
    bones,
    id: bones.id,
    rot,
    shift,
    size,
    /** Back to the rest pose. */
    rest() {
      rot.fill(0);
      shift.fill(0);
      size.fill(1);
    },
    /** Bakes the current pose into the bone texture row of `instance`. Returns the bones' model-space matrices. */
    write(instance) {
      for (let b = 0; b < count; b++) {
        const offset = offsets[b];
        EULER.set(rot[b * 3], rot[b * 3 + 1], rot[b * 3 + 2], 'XYZ');
        local.compose(POSITION.set(offset[0] + shift[b * 3], offset[1] + shift[b * 3 + 1], offset[2] + shift[b * 3 + 2]), QUAT.setFromEuler(EULER), SCALE.setScalar(size[b]));
        const { parent } = bones[b];
        if (parent < 0) world[b].copy(local);
        else world[b].multiplyMatrices(world[parent], local);
        world[b].toArray(data, (instance * width + b * 4) * 4);
      }
      return world;
    },
  };
}
