// ============================================================
// example.ts
// ============================================================

import {
  createComponent,
  composeComponent,
  not,
  any,
  has,
  createWorld,
  type Entity,
} from "./core";

// ---------- компоненты ----------

const Position = createComponent("Position", { x: "f32", y: "f32" });
const Velocity = createComponent("Velocity", { x: "f32", y: "f32" });
const Scale = createComponent("Scale", { x: "f32", y: "f32" });
const Rotation = createComponent("Rotation", { angle: "f32" });
const Dead = createComponent("Dead", {});
const Frozen = createComponent("Frozen", {});

const Transform = composeComponent(Position, Scale, Rotation);
//    ^? Component<{
//         "Position.x": "f32"; "Position.y": "f32";
//         "Scale.x": "f32"; "Scale.y": "f32";
//         "Rotation.angle": "f32"
//       }>

// ---------- мир ----------

const world = createWorld({ chunkCount: 512 });

// ---------- spawn ----------

const e1: Entity = world.spawn(Transform, {
  "Position.x": 10,
  "Position.y": 20,
  "Scale.x": 1,
  "Scale.y": 1,
  "Rotation.angle": 0,
});

// ---------- query WITH ----------

const q1 = world.query(Position, Velocity);
//    ^? Query<{
//         "Position.x": "f32"; "Position.y": "f32";
//         "Velocity.x": "f32"; "Velocity.y": "f32"
//       }>

for (const chunk of q1) {
  const px = chunk.views["Position.x"]; // Float32Array ✓
  const vx = chunk.views["Velocity.x"]; // Float32Array ✓
  for (let i = 0; i < chunk.count; i++) {
    px[i] += vx[i];
  }
  // @ts-expect-error — Dead не в запросе
  chunk.views["Dead"];
}

// ---------- query WITH + NOT ----------

const q2 = world.query(Position, not(Dead));
//    ^? Query<{ "Position.x": "f32"; "Position.y": "f32" }>

for (const chunk of q2) {
  const px = chunk.views["Position.x"]; // ✓
  // @ts-expect-error — Dead не в layout
  chunk.views["Dead"];
  px[0] += 1;
}

// ---------- query WITH + ANY + has ----------

const q3 = world.query(Position, any(Velocity, Frozen));
//    ^? Query<{ "Position.x": "f32"; "Position.y": "f32" }>
//       Velocity/Frozen НЕ в L — они опциональны

for (const chunk of q3) {
  const px = chunk.views["Position.x"]; // ✓

  if (has(chunk, Velocity)) {
    const vx = chunk.views["Velocity.x"]; // ✓ после type guard
    for (let i = 0; i < chunk.count; i++) px[i] += vx[i];
  } else if (has(chunk, Frozen)) {
    
  }
}

// ---------- query через методы компонента ----------

const q4 = world.query(Position, Dead.exclude());
//    ^? Query<{ "Position.x": "f32"; "Position.y": "f32" }>

const q5 = world.query(Position, Velocity.or(Frozen));
//    ^? Query<{ "Position.x": "f32"; "Position.y": "f32" }>

// ---------- query из bundle ----------

const q6 = world.query(Transform, not(Dead));
//    ^? Query<{
//         "Position.x": "f32"; "Position.y": "f32";
//         "Scale.x": "f32"; "Scale.y": "f32";
//         "Rotation.angle": "f32"
//       }>

for (const chunk of q6) {
  const px = chunk.views["Position.x"]; // ✓
  const sx = chunk.views["Scale.x"]; // ✓
  const angle = chunk.views["Rotation.angle"]; // ✓
  // @ts-expect-error — Dead не в запросе
  chunk.views["Dead"];
  px[0] += sx[0] * angle[0];
}

// ---------- runtime ----------

console.log("spawned entity:", e1);
console.log("sizes:", q1.size, q2.size, q3.size, q6.size);
