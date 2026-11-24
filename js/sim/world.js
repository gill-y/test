// The simulated house used by simulator mode.
//
// World frame = house frame. Marker 0 (the anchor) hangs on the living-room side of
// the wall between the living room and the kitchen, so the world origin is on the
// floor right below it and +Z points into the living room, where the viewer stands.
//
//          z
//          ^
//    +-----+-----------+
//    |  Living room (A)|   <- viewer stands here, looking at -Z (the wall)
//    |   [M0]          |
//  0 +--door--+--------+
//    | Kitchen| Bedroom|
//    |  (B)  door (C)  |
// -5 +--------+--------+  -> x
//   -4        1        4

export const WALL_HEIGHT = 2.6;
export const WALL_T = 0.12;

export const ROOMS = [
  { id: 'A', name: 'Living room', x: [-4, 4], z: [0, 5] },
  { id: 'B', name: 'Kitchen', x: [-4, 1], z: [-5.12, -0.12] },
  { id: 'C', name: 'Bedroom', x: [1, 4], z: [-5.12, -0.12] },
];

// Walls as axis-aligned boxes: [xmin, xmax, zmin, zmax].
export const WALLS = [
  // outer walls
  [-4.12, 4.12, 5, 5.12],
  [-4.12, 4.12, -5.24, -5.12],
  [-4.12, -4, -5.12, 5],
  [4, 4.12, -5.12, 5],
  // living room / kitchen+bedroom wall at z in [-0.12, 0], with a door at x in [-3.6, -2.8]
  [-4, -3.6, -0.12, 0],
  [-2.8, 4, -0.12, 0],
  // kitchen / bedroom wall at x in [1, 1.12], with a door at z in [-4.4, -3.6]
  [1, 1.12, -3.6, -0.12],
  [1, 1.12, -5.12, -4.4],
];

// The pre-built marker map for the simulated house (as if setup mode had been run).
export const SIM_MAP = {
  anchor: '0',
  markers: {
    0: { p: [0, 1.5, 0], yaw: 0, size: 0.2 }, // living-room side of the middle wall, faces +Z
    1: { p: [-1.6, 1.5, -0.12], yaw: Math.PI, size: 0.2 }, // kitchen side, faces -Z
    2: { p: [4, 1.5, -2.5], yaw: -Math.PI / 2, size: 0.2 }, // bedroom east wall, faces -X
  },
};

// Simulated camera nodes (true poses). Each one calibrates against a marker in its
// room when it can see one; the kitchen door cam can't, so it stands in for a camera
// that was placed using setup mode instead.
export const SIM_CAMERAS = [
  { id: 'sim-kitchen', name: 'Kitchen cam', room: 'B', pos: [-1.0, 2.3, -3.2], target: [-1.8, 0.8, -0.6], fov: 70, w: 1280, h: 720 },
  { id: 'sim-kitchen2', name: 'Kitchen door cam', room: 'B', pos: [-3.8, 2.3, -0.5], target: [-0.8, 0.5, -3.6], fov: 75, w: 1280, h: 720 },
  { id: 'sim-bedroom', name: 'Bedroom cam', room: 'C', pos: [1.4, 2.2, -4.9], target: [3.2, 0.6, -1.5], fov: 72, w: 1280, h: 720 },
];

// Simulated objects. Movers walk around a loop of waypoints (metres/second).
export const SIM_OBJECTS = [
  { label: 'person', size: [0.5, 1.75, 0.35], speed: 0.9, path: [[-3.2, -1.2], [-0.6, -1.5], [-0.4, -3.8], [0.4, -4.0], [2.5, -4.0], [3.3, -2.2], [2.0, -1.0], [2.4, -4.0], [0.4, -4.0], [-2.0, -4.2], [-3.3, -3.0]] },
  { label: 'person', size: [0.45, 1.6, 0.32], speed: 0.6, path: [[-2.6, -2.6], [-1.0, -2.9], [-1.4, -1.0], [-3.0, -1.6]] },
  { label: 'dog', size: [0.75, 0.55, 0.3], speed: 1.2, path: [[-0.6, -3.2], [-3.0, -3.6], [-2.2, -1.2], [-0.5, -1.4]] },
  { label: 'cat', size: [0.45, 0.3, 0.2], speed: 0.4, path: [[3.4, -4.4], [3.4, -2.0], [2.0, -2.4]] },
  { label: 'chair', size: [0.5, 0.9, 0.5], speed: 0, path: [[-2.4, -4.3]] },
  { label: 'couch', size: [1.9, 0.85, 0.9], speed: 0, path: [[2.7, -4.5]] },
];

export function roomAt(x, z) {
  return ROOMS.find((r) => x >= r.x[0] && x <= r.x[1] && z >= r.z[0] && z <= r.z[1]) || null;
}
