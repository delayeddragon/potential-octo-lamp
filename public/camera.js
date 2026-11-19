/**
 * RuneDeck — camera rig.
 *
 * A MOBA camera: pitched 42 degrees and turned a few degrees off the lanes,
 * close enough that the screen holds a little under half the arena. It glides
 * over the field towards wherever it is sent, can lock onto a hero, moves a
 * little closer or farther on the mouse wheel, and flies the cinematic pass
 * that opens every match. At the end of a match it can be taken out of the
 * player's hands and sent to look at whatever has fallen (`cinema`).
 */

import * as THREE from 'three';

import { MAP } from './shared.js';

export const PITCH = THREE.MathUtils.degToRad(42);
export const YAW = THREE.MathUtils.degToRad(8);
/** Vertical field of view. Narrow enough that the far bank stays readable, wide enough to give the arena depth. */
export const FOV = 30;
/** Share of the arena's width that fills the screen. */
const VIEW_SHARE = 0.45;
/** How far the focus may travel: the whole field can be centred, and no further. */
const LIMIT = { x: MAP.halfWidth - 6, near: MAP.halfDepth - 4, far: MAP.halfDepth - 5 };
/**
 * How far the mouse wheel may move the camera, as a share of its normal distance:
 * a little closer, a little farther, and how much one notch of the wheel changes it.
 */
const ZOOM = { min: 0.8, max: 1.25, notch: 0.06 };
/** How quickly the camera closes on its goal, per second: gentler while it trails a hero. */
const GLIDE = { free: 14, follow: 6 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Progress of the opening flight, 0..1 for time 0..1. It gathers speed as the
 * cube of time for most of the way, then brakes smoothly into its landing; the
 * two pieces meet with the same speed, so the hand-over cannot be seen.
 */
function flightCurve(u) {
  const turn = 0.7;
  const gain = 1 / (turn * turn * (1.5 - 0.5 * turn));
  if (u < turn) return gain * u ** 3;
  const brake = (3 * gain * turn * turn) / (2 * (1 - turn));
  return 1 - brake * (1 - u) ** 2;
}

export function createCameraRig(camera) {
  const cosPitch = Math.cos(PITCH);
  const sinPitch = Math.sin(PITCH);
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  /** Unit vector from the focus towards the camera. */
  const back = new THREE.Vector3(Math.sin(YAW) * cosPitch, sinPitch, Math.cos(YAW) * cosPitch);
  /** Screen-right and up-screen, as directions along the ground. */
  const right = { x: Math.cos(YAW), z: -Math.sin(YAW) };
  const ahead = { x: -Math.sin(YAW), z: -Math.cos(YAW) };

  const focus = { x: 0, z: 0 };
  const goal = { x: 0, z: 0 };
  let distance = 42;
  /** The opening flight's own pull-back. */
  let zoom = 1;
  /** The player's wheel zoom, eased towards its goal. Both scale the distance. */
  let wheel = 1;
  let wheelGoal = 1;
  /** Pixels that one world unit covers at the focus, at the normal distance. */
  let basePixels = 30;
  /** () => { x, z } | null: what the camera is locked onto. */
  let follow = null;
  let flight = null;
  /** The camera held on a sight at the end of a match: { from, to, seconds, age }. While set it takes no orders. */
  let film = null;
  /** The closer view that a film's `zoom` brings the camera to, as a share of normal distance. */
  let filmZoom = 1;
  /** A tremor running through the camera: how far it sways now, in world units, and the clock the sway runs on. */
  let quake = 0;
  let quakeClock = 0;
  /** Players who ask their system for less motion get the blast without the shaking. */
  const steady = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  function place() {
    const reach = distance * zoom * wheel * filmZoom;
    camera.position.set(focus.x + back.x * reach, back.y * reach, focus.z + back.z * reach);
    camera.lookAt(focus.x, 0, focus.z);
    if (quake > 0) {
      // Shifted after it is aimed: the whole picture jolts sideways and up, and the horizon stays level.
      const sway = Math.sin(quakeClock * 61) * quake;
      camera.position.x += right.x * sway;
      camera.position.z += right.z * sway;
      camera.position.y += Math.cos(quakeClock * 47) * quake * 0.6;
    }
    camera.updateMatrixWorld();
  }

  function confine(point) {
    point.x = clamp(point.x, -LIMIT.x, LIMIT.x);
    point.z = clamp(point.z, -LIMIT.far, LIMIT.near);
  }

  const corner = new THREE.Vector3();

  const rig = {
    right,
    ahead,
    back,
    sinPitch,
    cosPitch,
    tanPitch: Math.tan(PITCH),
    /** The point on the ground at the centre of the view. */
    focus,

    /** Pixels that one world unit covers at the focus, as zoomed now. */
    get pixelsPerUnit() {
      return basePixels / (wheel * filmZoom);
    },
    /** The camera's distance as a share of normal: under 1 is closer, over 1 farther. */
    get zoom() {
      return zoom * wheel * filmZoom;
    },
    get following() {
      return Boolean(follow);
    },
    get flying() {
      return Boolean(flight);
    },
    /** Whether the camera is held on a sight and ignores the player. */
    get filming() {
      return Boolean(film);
    },

    /** Sizes the view for a canvas, keeping the focus in the middle of what the HUD leaves free (`insets` in CSS pixels). */
    resize(width, height, insets) {
      camera.aspect = width / height;
      const span = MAP.halfWidth * 2 * VIEW_SHARE;
      distance = clamp(span / (2 * tanHalfFov * camera.aspect), 30, 52);
      // Slide the picture, as a shift lens would, rather than tilt the camera.
      camera.setViewOffset(width, height, 0, (insets.bottom - insets.top) * 0.3, width, height);
      camera.updateProjectionMatrix();
      basePixels = height / (2 * distance * tanHalfFov);
      place();
    },

    /** Sends the camera to a point; `snap` cuts there instead of gliding. */
    lookAt(x, z, snap = false) {
      if (film) return;
      goal.x = x;
      goal.z = z;
      confine(goal);
      if (snap) Object.assign(focus, goal);
    },

    /** Moves the goal by world units along the screen's own axes. */
    pan(rightward, upward) {
      if (film) return;
      goal.x += right.x * rightward + ahead.x * upward;
      goal.z += right.z * rightward + ahead.z * upward;
      confine(goal);
    },

    /** Drags the ground under the cursor by a distance in CSS pixels. */
    drag(dx, dy) {
      if (film) return;
      const scale = rig.pixelsPerUnit;
      rig.pan(-dx / scale, dy / (scale * sinPitch));
      // The ground should stay under the cursor, not trail behind it.
      Object.assign(focus, goal);
    },

    /** Moves the camera closer (negative) or farther (positive) by notches of the mouse wheel, within a narrow range. */
    zoomBy(notches) {
      if (film) return;
      wheelGoal = clamp(wheelGoal * Math.exp(notches * ZOOM.notch), ZOOM.min, ZOOM.max);
    },

    /** Locks the camera onto whatever `target()` returns ({ x, z } or null), or frees it with null. */
    setFollow(target) {
      if (film) return;
      follow = target;
    },

    /**
     * Takes the camera out of the player's hands and sends it over `seconds` to
     * (x, z), drawn in to `zoom` (a share of the normal distance) and past the
     * edge of the field if need be. It stays there until `release`.
     */
    cinema({ x, z, zoom: closer, seconds }) {
      flight = null;
      follow = null;
      film = { from: { x: focus.x, z: focus.z, zoom: filmZoom }, to: { x, z, zoom: closer }, seconds, age: 0 };
    },

    /** Hands the camera back where it stands, at its normal distance. */
    release() {
      film = null;
      filmZoom = 1;
      quake = 0;
      Object.assign(goal, focus);
      confine(goal);
    },

    /** Shakes the camera as a blast goes off: it sways up to `strength` world units and settles within a second. */
    jolt(strength) {
      if (!steady) quake = Math.max(quake, strength);
    },

    /**
     * The opening flight: holds over `from` for `hold` seconds, then sweeps to
     * `to`, arriving `seconds` after it began. The path bows `arc` units
     * towards the camera on the way, and the view pulls back in mid-flight to
     * take in the field. `onArrive` runs as it lands.
     */
    fly({ from, to, seconds, hold, arc = 0, onArrive }) {
      if (film) return;
      // Timed by the clock, not by frames, so a slow renderer still lands when the battle starts.
      flight = { from, to, seconds, hold, arc, onArrive, began: performance.now() };
      Object.assign(focus, from);
      Object.assign(goal, from);
      zoom = 0.8;
      place();
    },

    /**
     * Re-times a flight in progress to land `secondsLeft` from now, as the server's clock says it should.
     * It only ever skips ahead: a client that hitched catches up, and one that is on time is left alone.
     */
    retime(secondsLeft) {
      if (!flight) return;
      const began = performance.now() - (flight.seconds - secondsLeft) * 1000;
      if (began < flight.began - 250) flight.began = began;
    },

    /** Ends a flight where it stands, without calling `onArrive`. */
    land() {
      flight = null;
      zoom = 1;
    },

    update(dt) {
      // The wheel zoom eases in and then settles exactly, so whatever is sized from it comes to rest.
      wheel += (wheelGoal - wheel) * (1 - Math.exp(-dt * 12));
      if (Math.abs(wheelGoal - wheel) < 0.001) wheel = wheelGoal;
      if (quake > 0) {
        quakeClock += dt;
        quake *= Math.exp(-dt * 3.4);
        if (quake < 0.01) quake = 0;
      }
      if (film) {
        film.age = Math.min(film.seconds, film.age + dt);
        const u = film.age / film.seconds;
        const s = u * u * (3 - 2 * u);
        focus.x = film.from.x + (film.to.x - film.from.x) * s;
        focus.z = film.from.z + (film.to.z - film.from.z) * s;
        filmZoom = film.from.zoom + (film.to.zoom - film.from.zoom) * s;
        Object.assign(goal, focus);
      } else if (flight) {
        const elapsed = (performance.now() - flight.began) / 1000;
        const u = clamp((elapsed - flight.hold) / (flight.seconds - flight.hold), 0, 1);
        const s = flightCurve(u);
        // `to` may be a moving target, such as a hero.
        const to = typeof flight.to === 'function' ? flight.to() : flight.to;
        focus.x = flight.from.x + (to.x - flight.from.x) * s;
        focus.z = flight.from.z + (to.z - flight.from.z) * s + flight.arc * Math.sin(Math.PI * s);
        zoom = 0.8 + 0.2 * s + 0.2 * Math.sin(Math.PI * s);
        Object.assign(goal, focus);
        if (u >= 1) {
          const { onArrive } = flight;
          flight = null;
          zoom = 1;
          onArrive?.();
        }
      } else {
        const target = follow?.();
        if (target) {
          goal.x = target.x;
          goal.z = target.z;
          confine(goal);
        }
        const k = 1 - Math.exp(-dt * (target ? GLIDE.follow : GLIDE.free));
        focus.x += (goal.x - focus.x) * k;
        focus.z += (goal.z - focus.z) * k;
      }
      place();
    },

    /** The four corners of the screen on the ground, clockwise from the top left: the camera's footprint. */
    footprint() {
      return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => {
        corner.set(x, y, 0.5).unproject(camera).sub(camera.position);
        const t = -camera.position.y / corner.y;
        return { x: camera.position.x + corner.x * t, z: camera.position.z + corner.z * t };
      });
    },
  };
  place();
  return rig;
}
