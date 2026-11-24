// Headset alignment and multi-room setup ("map mode").
//
// The headset learns where a marker is by touching it: first the centre of the
// marker, then any point to its right on the same wall. Together with gravity this
// gives the marker's full pose in the headset's tracking space (WebXR local-floor).
//
//   Align mode: touch a marker that is already on the map. That fixes the
//     transform between the shared world and this headset session.
//   Map mode:   walk between rooms and touch each marker in turn. The first touch
//     aligns (or creates the map if there is none); every new marker touched after
//     that is added to the map in world coordinates. Headset tracking carries the
//     link from room to room, which is how markers in different rooms end up in one
//     coordinate system.

import * as THREE from 'three';
import { markerMatrixFromTwoPoints, markerWorldMatrix, markerFromMatrix } from '../common/geometry.js';
import { DEFAULT_MARKER_SIZE } from '../common/protocol.js';

export class Aligner {
  constructor({ getMap, publishMap, markerSize = DEFAULT_MARKER_SIZE }) {
    this.getMap = getMap;
    this.publishMap = publishMap;
    this.markerSize = markerSize;
    this.xrFromWorld = null; // Matrix4: world frame expressed in headset tracking space
    this.alignedWith = null;
    this.mode = 'idle';
    this.step = 0;
    this.first = null;
    this.markerId = '0';
    this.message = '';
    this.linkedThisSession = new Set();
  }

  get aligned() {
    return !!this.xrFromWorld;
  }

  knownIds() {
    return Object.keys(this.getMap()?.markers || {}).sort((a, b) => Number(a) - Number(b));
  }

  begin(mode) {
    this.mode = mode;
    this.step = 0;
    this.first = null;
    const map = this.getMap();
    const known = this.knownIds();
    if (mode === 'align') {
      this.markerId = String(map?.anchor ?? known[0] ?? '0');
    } else if (mode === 'map') {
      if (!this.aligned) this.markerId = String(map?.anchor ?? known[0] ?? '0');
      else this.markerId = this.nextFreeId();
    }
    this.message = this.prompt();
  }

  cancel() {
    this.mode = 'idle';
    this.step = 0;
    this.first = null;
    this.message = this.aligned ? `Aligned to marker ${this.alignedWith}.` : 'Not aligned yet.';
  }

  nextFreeId() {
    const used = new Set(this.knownIds());
    let i = 0;
    while (used.has(String(i))) i++;
    return String(i);
  }

  cycleMarker(dir) {
    const n = Math.max(0, Number(this.markerId) + dir);
    this.markerId = String(Math.min(249, n));
    this.step = 0;
    this.first = null;
    this.message = this.prompt();
  }

  prompt() {
    const known = this.knownIds().includes(this.markerId);
    const what = `marker ${this.markerId}${known ? '' : ' (new)'}`;
    if (this.step === 0) return `Touch the CENTRE of ${what} and pull the trigger.`;
    return `Now touch the wall a hand's width to the RIGHT of ${what} and pull the trigger.`;
  }

  /** Feed a touch point in headset tracking space. Returns a status string. */
  tap(point) {
    if (this.mode === 'idle') return this.message;
    if (this.step === 0) {
      this.first = point.clone();
      this.step = 1;
      this.message = this.prompt();
      return this.message;
    }
    const xrFromMarker = markerMatrixFromTwoPoints(this.first, point);
    this.step = 0;
    this.first = null;
    if (!xrFromMarker) {
      this.message = 'The two touches were too close together. Start again at the marker centre.';
      return this.message;
    }
    this.message = this.applyMarker(this.markerId, xrFromMarker);
    return this.message;
  }

  /** Core logic, separated from input so it can be unit-tested. */
  applyMarker(id, xrFromMarker) {
    let map = this.getMap();
    const size = map?.markers?.[id]?.size || this.markerSize;

    if (!map || !map.markers || !Object.keys(map.markers).length) {
      // First marker ever: it becomes the anchor. World origin = floor under it.
      const markerPos = new THREE.Vector3().setFromMatrixPosition(xrFromMarker);
      map = { anchor: id, markers: { [id]: { p: [0, round(markerPos.y), 0], yaw: 0, size } } };
      this.xrFromWorld = xrFromMarker.clone().multiply(markerWorldMatrix(map.markers[id]).invert());
      this.alignedWith = id;
      this.linkedThisSession.add(id);
      this.publishMap(map);
      if (this.mode === 'map') this.markerId = this.nextFreeIdIn(map);
      else this.mode = 'idle';
      return `Map created. Marker ${id} is the anchor (${markerPos.y.toFixed(2)} m above the floor).` +
        (this.mode === 'map' ? ` Walk to the next marker and touch it.` : '');
    }

    const known = map.markers[id];
    if (known) {
      const xrFromWorld = xrFromMarker.clone().multiply(markerWorldMatrix(known).invert());
      if (this.aligned && this.mode === 'map') {
        // Already aligned: report drift instead of silently re-aligning mid-walk.
        const predicted = this.xrFromWorld.clone().multiply(markerWorldMatrix(known));
        const err = new THREE.Vector3().setFromMatrixPosition(predicted).distanceTo(new THREE.Vector3().setFromMatrixPosition(xrFromMarker));
        this.xrFromWorld = xrFromWorld;
        this.alignedWith = id;
        this.linkedThisSession.add(id);
        this.markerId = this.nextFreeId();
        return `Marker ${id} is already on the map (drift ${(err * 100).toFixed(0)} cm, corrected). Touch a new marker.`;
      }
      this.xrFromWorld = xrFromWorld;
      this.alignedWith = id;
      this.linkedThisSession.add(id);
      if (this.mode === 'map') {
        this.markerId = this.nextFreeId();
        return `Aligned to marker ${id}. Walk to a marker that isn't on the map yet and touch it.`;
      }
      this.mode = 'idle';
      return `Aligned to marker ${id}.`;
    }

    if (!this.aligned) {
      return `Marker ${id} isn't on the map yet. First touch a marker that is (${this.knownIds().join(', ')}).`;
    }
    if (this.mode !== 'map') {
      return `Marker ${id} isn't on the map. Use "Map rooms" to add it.`;
    }
    const worldFromMarker = this.xrFromWorld.clone().invert().multiply(xrFromMarker);
    const entry = markerFromMatrix(worldFromMarker, size);
    entry.p = entry.p.map(round);
    entry.yaw = round(entry.yaw);
    const next = { ...map, markers: { ...map.markers, [id]: entry } };
    this.publishMap(next);
    this.linkedThisSession.add(id);
    this.markerId = this.nextFreeIdIn(next);
    return `Added marker ${id} to the map. Touch the next one, or press Done.`;
  }

  nextFreeIdIn(map) {
    const used = new Set(Object.keys(map.markers || {}));
    let i = 0;
    while (used.has(String(i))) i++;
    return String(i);
  }

  /** Restore alignment from a persisted WebXR anchor pose (world origin). */
  setFromAnchor(xrFromWorld) {
    this.xrFromWorld = xrFromWorld;
    if (!this.alignedWith) this.alignedWith = 'saved anchor';
  }
}

const round = (v) => Math.round(v * 1000) / 1000;
