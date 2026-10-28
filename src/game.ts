import { createWebGLRenderer } from "./webgl_renderer";
import {
  World,
  defineComponent,
  compose,
  all,
  componentsOf,
  type Archetype,
  type Entity,
} from "./ecs";
import { Schedule, defineSystem, loadWasm } from "./systems";

/*
 * The build script prepends this constant (movement.wasm as base64) so index.html is one file.
 * With Vite you would not need it:
 *
 *   import init from "./movement.wasm?init";                      // Vite: init(imports) => Promise<Instance>
 *   kernels: async (memory) => {
 *     const { exports } = await init({ env: { memory } });
 *     return { move: exports.move as Move, moveScalar: exports.moveScalar as Move };
 *   }
 */
declare const MOVEMENT_WASM_BASE64: string;

/* ═══════════════════════════ world ═══════════════════════════ */

const W = 960,
  H = 600;

const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent("Velocity", { x: "f32", y: "f32" });
const Life = defineComponent("Life", { age: "f32", max: "f32" });
const Tint = defineComponent("Tint", { rgba: "u32" });
const Frozen = defineComponent("Frozen", {});
const Player = defineComponent("Player", {});

const Body = compose("Body", Position, Velocity);
const Sprite = compose("Sprite", Position, Tint);
const Drifter = compose("Drifter", Body, Tint);
const FrozenDrifter = compose("FrozenDrifter", Drifter, Frozen);
const Particle = compose("Particle", Drifter, Life);
const Pilot = compose("Pilot", Sprite, Player);

// Memory is sized once: 1024 chunks x 16 KiB, plus 64 KiB reserved for wasm stacks/globals.
const world = new World({
  chunkBytes: 16 * 1024,
  maxChunks: 1024 * 4,
  reservedBytes: 64 * 1024,
});

type Mode = "js" | "scalar" | "simd";
type RenderMode = "2d" | "webgl";
const settings = {
  mode: "simd" as Mode,
  renderMode: "webgl" as RenderMode,
  target: 20_000,
  paused: false,
  freeze: 0 as 0 | 1 | 2,
};
const mouse = { x: W / 2, y: H / 2, down: false };
let wasmReady = false;
let wasmError = "";

const rand = Math.random;
const rgba = (r: number, g: number, b: number) =>
  (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const cool = () =>
  rgba(50 + rand() * 70, 110 + rand() * 100, 190 + rand() * 65);
const warm = () => rgba(255, 130 + rand() * 110, 30 + rand() * 70);

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvasGl = document.getElementById("game-webgl") as HTMLCanvasElement;
const canvas2d = document.getElementById("game-2d") as HTMLCanvasElement;
canvasGl.width = W;
canvasGl.height = H;
canvas2d.width = W;
canvas2d.height = H;

const g2d = canvas2d.getContext("2d")!;
const image = g2d.createImageData(W, H);
const pixels = new Uint32Array(image.data.buffer);
const BG = rgba(11, 15, 20);

// Инициализация WebGL рендерера
let glRenderer: ReturnType<typeof createWebGLRenderer> | null = null;
try {
  glRenderer = createWebGLRenderer(canvasGl, W, H);
  console.log(
    "%c[Renderer] WebGL успешно инициализирован (GPU)",
    "color: #2ec4b6; font-weight: bold;",
  );
} catch (e) {
  console.warn("WebGL недоступен, fallback на 2D:", e);
}

/* ═══════════════════════════ systems ═══════════════════════════ */

type Move = (
  px: number,
  py: number,
  vx: number,
  vy: number,
  count: number,
  dt: number,
) => void;
type Bounce = (
  px: number,
  py: number,
  vx: number,
  vy: number,
  count: number,
  w: number,
  h: number,
) => void;
type Kernels = {
  move: Move | null;
  moveScalar: Move | null;
  bounce?: Bounce | null;
  bounceScalar?: Bounce | null;
};
let wasmExports: any = null;
const MAX_PARTICLES = 30_000;
const BATCH = 2500;

const input = defineSystem({
  name: "input",
  queries: { players: all(Pilot) },
  run({ dt, q }) {
    const follow = Math.min(1, 10 * dt);
    q.players.each(({ count, cols }) => {
      const px = cols["Position.x"],
        py = cols["Position.y"];
      for (let i = 0; i < count; i++) {
        px[i] += (mouse.x - px[i]) * follow;
        py[i] += (mouse.y - py[i]) * follow;
      }
    });
  },
});

const spawner = defineSystem({
  name: "spawner",
  queries: { drifters: all(Drifter).without(Life), particles: all(Life) },
  run({ cmd, q }) {
    const have = q.drifters.count,
      want = settings.target;
    if (have < want) {
      for (let i = 0, n = Math.min(want - have, BATCH); i < n; i++) {
        const a = rand() * Math.PI * 2,
          s = 20 + rand() * 100;
        cmd.spawn(Drifter, {
          "Position.x": rand() * W,
          "Position.y": rand() * H,
          "Velocity.x": Math.cos(a) * s,
          "Velocity.y": Math.sin(a) * s,
          "Tint.rgba": cool(),
        });
      }
    } else if (have > want) {
      let left = Math.min(have - want, BATCH);
      q.drifters.each(({ count, entities }) => {
        for (let i = 0; i < count && left > 0; i++, left--)
          cmd.destroy(entities[i] as Entity);
      });
    }
    if (mouse.down && q.particles.count < MAX_PARTICLES) {
      for (let i = 0; i < 80; i++) {
        const a = rand() * Math.PI * 2,
          s = 40 + rand() * 260;
        cmd.spawn(Particle, {
          "Position.x": mouse.x,
          "Position.y": mouse.y,
          "Velocity.x": Math.cos(a) * s,
          "Velocity.y": Math.sin(a) * s,
          "Tint.rgba": warm(),
          "Life.age": 0,
          "Life.max": 1 + rand() * 2.5,
        });
      }
    }
  },
});

const freezer = defineSystem({
  name: "freeze",
  queries: {
    live: all(Drifter).without(Life, Frozen),
    frozen: all(FrozenDrifter).without(Life),
  },
  run({ cmd, q }) {
    if (settings.freeze === 1) {
      q.live.each(({ count, entities }) => {
        for (let i = 0; i < count; i++) cmd.add(entities[i] as Entity, Frozen);
      });
    } else if (settings.freeze === 2) {
      q.frozen.each(({ count, entities }) => {
        for (let i = 0; i < count; i++)
          cmd.remove(entities[i] as Entity, Frozen);
      });
    }
    settings.freeze = 0;
  },
});

const attract = defineSystem({
  name: "attract",
  queries: { bodies: all(Body).without(Frozen) },
  run({ dt, q }) {
    if (!mouse.down || dt === 0) return;
    const accel = 1400 * dt,
      drag = 1 - Math.min(1, 0.8 * dt),
      mx = mouse.x,
      my = mouse.y;
    q.bodies.each(({ count, cols }) => {
      const px = cols["Position.x"],
        py = cols["Position.y"];
      const vx = cols["Velocity.x"],
        vy = cols["Velocity.y"];
      for (let i = 0; i < count; i++) {
        const dx = mx - px[i],
          dy = my - py[i];
        const k = accel / Math.sqrt(dx * dx + dy * dy + 900);
        vx[i] = (vx[i] + dx * k) * drag;
        vy[i] = (vy[i] + dy * k) * drag;
      }
    });
  },
});

const movement = defineSystem({
  name: "movement",
  queries: { movers: all(Body).without(Frozen) },
  // Runs once in schedule.init(): decode the module, give it the engine memory, keep its exports.
  kernels: async (memory): Promise<Kernels> => {
    try {
      const exports = await loadWasm("/movement.wasm", memory);
      wasmExports = exports;
      wasmReady = true;
      return {
        move: exports.move as Move,
        moveScalar: exports.moveScalar as Move,
        bounce: exports.bounce as Bounce,
        bounceScalar: exports.bounceScalar as Bounce,
      };
    } catch (err) {
      wasmError = String(err);
      return { move: null, moveScalar: null };
    }
  },
  run({ dt, q, k }) {
    const kernel =
      settings.mode === "simd"
        ? k.move
        : settings.mode === "scalar"
          ? k.moveScalar
          : null;
    q.movers.each((v) => {
      if (kernel) {
        // raw column addresses straight into the arena memory
        kernel(
          v.ptr("Position.x"),
          v.ptr("Position.y"),
          v.ptr("Velocity.x"),
          v.ptr("Velocity.y"),
          v.count,
          dt,
        );
        return;
      }
      const { count, cols } = v;
      const px = cols["Position.x"],
        py = cols["Position.y"];
      const vx = cols["Velocity.x"],
        vy = cols["Velocity.y"];
      for (let i = 0; i < count; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    });
  },
});

const bounce = defineSystem({
  name: "bounce",
  queries: { bodies: all(Body).without(Frozen) },
  kernels: async () => ({
    bounce: (wasmExports?.bounce as Bounce) || null,
    bounceScalar: (wasmExports?.bounceScalar as Bounce) || null,
  }),
  run({ q, k }) {
    const kernel =
      settings.mode === "simd"
        ? (k as any)?.bounce
        : settings.mode === "scalar"
          ? (k as any)?.bounceScalar
          : null;
    q.bodies.each((v) => {
      if (kernel) {
        kernel(
          v.ptr("Position.x"),
          v.ptr("Position.y"),
          v.ptr("Velocity.x"),
          v.ptr("Velocity.y"),
          v.count,
          W,
          H,
        );
        return;
      }
      const { count, cols } = v;
      const px = cols["Position.x"],
        py = cols["Position.y"];
      const vx = cols["Velocity.x"],
        vy = cols["Velocity.y"];
      for (let i = 0; i < count; i++) {
        const x = px[i],
          y = py[i];
        if (x < 0) {
          px[i] = 0;
          if (vx[i] < 0) vx[i] = -vx[i];
        } else if (x > W) {
          px[i] = W;
          if (vx[i] > 0) vx[i] = -vx[i];
        }
        if (y < 0) {
          py[i] = 0;
          if (vy[i] < 0) vy[i] = -vy[i];
        } else if (y > H) {
          py[i] = H;
          if (vy[i] > 0) vy[i] = -vy[i];
        }
      }
    });
  },
});

const lifetime = defineSystem({
  name: "lifetime",
  queries: { mortal: all(Life) },
  run({ dt, cmd, q }) {
    q.mortal.each(({ count, cols, entities }) => {
      const age = cols["Life.age"],
        max = cols["Life.max"];
      for (let i = 0; i < count; i++) {
        age[i] += dt;
        if (age[i] >= max[i]) cmd.destroy(entities[i] as Entity);
      }
    });
  },
});

const render = defineSystem({
  name: "render",
  queries: { sprites: all(Sprite), pilots: all(Pilot) },
  run({ q }) {
    if (settings.renderMode === "webgl" && glRenderer) {
      // ═══════════ WebGL Режим (GPU) ═══════════
      glRenderer.begin();
      q.sprites.each(({ count, cols }) => {
        glRenderer!.drawParticleBatch(
          cols["Position.x"],
          cols["Position.y"],
          cols["Tint.rgba"],
          count,
          1.5,
        );
      });
      q.pilots.each(({ count, cols }) => {
        for (let i = 0; i < count; i++) {
          glRenderer!.drawCircle(
            cols["Position.x"][i],
            cols["Position.y"][i],
            9,
            1.0,
            1.0,
            1.0,
          );
        }
      });
      if (mouse.down) {
        glRenderer.drawCircle(mouse.x, mouse.y, 24, 1.0, 0.72, 0.01, 0.8);
      }
    } else {
      // ═══════════ Canvas 2D Режим (CPU) ═══════════
      pixels.fill(BG);
      q.sprites.each(({ count, cols }) => {
        const px = cols["Position.x"],
          py = cols["Position.y"],
          tint = cols["Tint.rgba"];
        for (let i = 0; i < count; i++) {
          const x = px[i] | 0,
            y = py[i] | 0;
          if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) continue;
          const o = y * W + x,
            c = tint[i];
          pixels[o] = c;
          pixels[o + 1] = c;
          pixels[o + W] = c;
          pixels[o + W + 1] = c;
        }
      });
      g2d.putImageData(image, 0, 0);
      g2d.lineWidth = 2;
      q.pilots.each(({ count, cols }) => {
        g2d.strokeStyle = "#ffffff";
        for (let i = 0; i < count; i++) {
          g2d.beginPath();
          g2d.arc(
            cols["Position.x"][i],
            cols["Position.y"][i],
            9,
            0,
            Math.PI * 2,
          );
          g2d.stroke();
        }
      });
      if (mouse.down) {
        g2d.strokeStyle = "rgba(255, 183, 3, 0.8)";
        g2d.beginPath();
        g2d.arc(mouse.x, mouse.y, 24, 0, Math.PI * 2);
        g2d.stroke();
      }
    }
  },
});

const DESCRIPTIONS: Record<string, string> = {
  input: "Игрок плавно следует за курсором (колонки напрямую).",
  spawner:
    "Держит число дрейфующих равным слайдеру, пускает частицы при зажатой мыши (cmd.spawn / cmd.destroy).",
  freeze:
    "Кнопки ниже: cmd.add / cmd.remove(Frozen) — массовая миграция между архетипами.",
  attract: "Притяжение к курсору при зажатой мыши (JS).",
  movement:
    "Position += Velocity · dt. Режим переключается: JS / WASM scalar / WASM SIMD.",
  bounce: "Отражение от стен (JS).",
  lifetime: "Life.age += dt; когда время вышло — cmd.destroy.",
  render: "Пишет пиксели в ImageData и делает putImageData (входит в время).",
};

/* ═══════════════════════════ setup ═══════════════════════════ */

for (let i = 0; i < 500; i++) {
  const v = 60 + rand() * 90;
  world.spawn(Sprite, {
    "Position.x": rand() * W,
    "Position.y": rand() * H,
    "Tint.rgba": rgba(v, v, v + 20),
  });
}
world.spawn(Pilot, {
  "Position.x": W / 2,
  "Position.y": H / 2,
  "Tint.rgba": rgba(255, 255, 255),
});

const schedule = new Schedule(world).add(
  input,
  spawner,
  freezer,
  attract,
  movement,
  bounce,
  lifetime,
  render,
);
const errorBox = $<HTMLElement>("error");
const showError = (err: unknown) => {
  console.error(err);
  errorBox.textContent = String(
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  errorBox.hidden = false;
};

/* ═══════════════════════════ stats ═══════════════════════════ */

const HISTORY = 240;
const slots = schedule.slots;
const COLORS = [
  "#8d99ae",
  "#ffb703",
  "#c77dff",
  "#fb8500",
  "#4cc9f0",
  "#80ed99",
  "#f28482",
  "#f4f1de",
];
const OTHER = "#4a5568";
const hist = slots.map(() => new Float32Array(HISTORY));
const other = new Float32Array(HISTORY);
const totals = new Float32Array(HISTORY);
const ema = slots.map(() => 0);
let head = 0,
  filled = 0,
  yMax = 20,
  fps = 60;

function record(work: number) {
  let sum = 0;
  for (let i = 0; i < slots.length; i++) {
    const ms = slots[i].ms + slots[i].flushMs;
    hist[i][head] = ms;
    sum += ms;
    ema[i] += (ms - ema[i]) * 0.08;
  }
  other[head] = Math.max(0, work - sum);
  totals[head] = work;
  head = (head + 1) % HISTORY;
  filled = Math.min(HISTORY, filled + 1);
}

function fit(c: HTMLCanvasElement, cssHeight: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.floor(c.clientWidth));
  c.style.height = cssHeight + "px";
  if (
    c.width !== Math.round(w * dpr) ||
    c.height !== Math.round(cssHeight * dpr)
  ) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(cssHeight * dpr);
  }
  const x = c.getContext("2d")!;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { x, w, h: cssHeight };
}

const chart = $<HTMLCanvasElement>("chart");
function drawChart() {
  const { x, w, h } = fit(chart, 230);
  x.clearRect(0, 0, w, h);
  const padL = 40,
    padT = 10,
    padB = 4,
    plotW = w - padL - 6,
    plotH = h - padT - padB;
  let maxTotal = 0;
  for (let i = 0; i < HISTORY; i++) maxTotal = Math.max(maxTotal, totals[i]);
  const target = Math.max(20, maxTotal * 1.15);
  yMax += (target - yMax) * (target > yMax ? 0.5 : 0.04);
  const sy = plotH / yMax,
    base = padT + plotH;

  x.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  x.textBaseline = "middle";
  x.lineWidth = 1;
  for (const [ms, label] of [
    [16.7, "16.7 · 60fps"],
    [33.3, "33.3 · 30fps"],
    [50, "50"],
  ] as const) {
    if (ms > yMax) continue;
    const y = Math.round(base - ms * sy) + 0.5;
    x.strokeStyle =
      ms === 16.7 ? "rgba(255, 200, 87, 0.55)" : "rgba(138, 160, 180, 0.25)";
    x.setLineDash([4, 4]);
    x.beginPath();
    x.moveTo(padL, y);
    x.lineTo(w - 4, y);
    x.stroke();
    x.setLineDash([]);
    x.fillStyle = ms === 16.7 ? "#ffc857" : "#8aa0b4";
    x.textAlign = "right";
    x.fillText(label.split(" · ")[0], padL - 6, y);
  }
  x.fillStyle = "#8aa0b4";
  x.textAlign = "right";
  x.fillText("0", padL - 6, base - 6);
  x.fillText(yMax.toFixed(0) + " мс", padL - 6, padT + 6);

  const barW = plotW / HISTORY;
  for (let k = 0; k < filled; k++) {
    const idx = (head - filled + k + HISTORY) % HISTORY;
    const bx = padL + (HISTORY - filled + k) * barW,
      bw = Math.max(1, barW - 0.6);
    let y0 = base;
    for (let i = 0; i < slots.length; i++) {
      const hh = hist[i][idx] * sy;
      if (hh <= 0.2) continue;
      x.fillStyle = COLORS[i % COLORS.length];
      x.fillRect(bx, y0 - hh, bw, hh);
      y0 -= hh;
    }
    const oh = other[idx] * sy;
    if (oh > 0.2) {
      x.fillStyle = OTHER;
      x.fillRect(bx, y0 - oh, bw, oh);
      y0 -= oh;
    }
    if (totals[idx] > 16.7) {
      x.fillStyle = "#ff4d4d";
      x.fillRect(bx, y0 - 2, bw, 2);
    } // lag cap
  }
}

/* ── formatting ── */
const n = (v: number) => v.toLocaleString("ru-RU");
const kib = (b: number) =>
  b >= 1048576
    ? (b / 1048576).toFixed(2) + " МиБ"
    : (b / 1024).toFixed(1) + " КиБ";
const hex = (v: number) => "0x" + v.toString(16).toUpperCase();
const archColor = (id: number) => `hsl(${(id * 67 + 190) % 360} 65% 58%)`;
const archName = (a: Archetype) =>
  componentsOf(a.mask).join(" + ") || "(пустой)";
const BYTES: Record<string, number> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  f32: 4,
  f64: 8,
};

/* ── legend, controls, system rows (built once) ── */
$<HTMLElement>("legend").innerHTML =
  slots
    .map(
      (s, i) =>
        `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${s.name}</span>`,
    )
    .join("") +
  `<span><i style="background:${OTHER}"></i>прочее</span><span><i style="background:#ff4d4d"></i>кадр &gt; 16.7 мс</span>`;

const sysRows: { bar: HTMLElement; ms: HTMLElement }[] = [];
slots.forEach((slot, i) => {
  const row = document.createElement("label");
  row.className = "sys";
  row.title = DESCRIPTIONS[slot.name] ?? "";
  row.innerHTML =
    `<input type="checkbox" checked><i style="background:${COLORS[i % COLORS.length]}"></i>` +
    `<span class="sys-name">${slot.name}</span><span class="sys-bar"><b></b></span><span class="sys-ms">0.00</span>`;
  row.querySelector("input")!.addEventListener("change", (e) => {
    slot.enabled = (e.target as HTMLInputElement).checked;
  });
  $("systems").appendChild(row);
  sysRows.push({
    bar: row.querySelector("b")!,
    ms: row.querySelector(".sys-ms")!,
  });
});

const modeButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("#mode button"),
);
const selectMode = (mode: Mode) => {
  settings.mode = mode;
  for (const b of modeButtons)
    b.classList.toggle("on", b.dataset.mode === mode);
};
for (const b of modeButtons)
  b.addEventListener("click", () => selectMode(b.dataset.mode as Mode));

const renderButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("#renderMode button"),
);
function selectRenderMode(mode: RenderMode) {
  settings.renderMode = mode;
  if (mode === "webgl" && glRenderer) {
    canvasGl.style.display = "block";
    canvas2d.style.display = "none";
  } else {
    canvasGl.style.display = "none";
    canvas2d.style.display = "block";
  }
  for (const b of renderButtons)
    b.classList.toggle("on", b.dataset.render === mode);
}
for (const b of renderButtons) {
  b.addEventListener("click", () =>
    selectRenderMode(b.dataset.render as RenderMode),
  );
}
// Начальная синхронизация видимости
selectRenderMode(glRenderer ? "webgl" : "2d");

const target = $<HTMLInputElement>("target");
target.addEventListener("input", () => {
  settings.target = Number(target.value);
  $("targetOut").textContent = n(settings.target);
});
$("pause").addEventListener("click", (e) => {
  settings.paused = !settings.paused;
  (e.target as HTMLElement).classList.toggle("on", settings.paused);
});
$("freeze").addEventListener("click", () => {
  settings.freeze = 1;
});
$("thaw").addEventListener("click", () => {
  settings.freeze = 2;
});

const toCanvas = (e: PointerEvent) => {
  const target =
    (e.currentTarget as HTMLElement) ||
    (settings.renderMode === "webgl" ? canvasGl : canvas2d);
  const r = target.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) * (W / r.width);
  mouse.y = (e.clientY - r.top) * (H / r.height);
};

for (const c of [canvasGl, canvas2d]) {
  c.addEventListener("pointerdown", (e) => {
    c.setPointerCapture(e.pointerId);
    mouse.down = true;
    toCanvas(e);
  });
  c.addEventListener("pointermove", toCanvas);
  c.addEventListener("pointerup", () => {
    mouse.down = false;
  });
  c.addEventListener("pointercancel", () => {
    mouse.down = false;
  });
}

/* ── archetypes ── */
const expanded = new Set<number>();
const archContainer = $("archetypes");

archContainer.addEventListener("click", (e) => {
  const head = (e.target as HTMLElement).closest<HTMLElement>(".arch-head");
  if (!head) return;
  const id = Number(head.dataset.id);
  const card = head.closest<HTMLElement>(".arch");
  if (!card) return;

  if (expanded.has(id)) {
    expanded.delete(id);
    card.classList.remove("open");
  } else {
    expanded.add(id);
    card.classList.add("open");
  }
  updateArchetypesUi(world.memoryStats().chunkBytes);
});

function updateArchetypesUi(chunkBytes: number) {
  let idle = 0;
  for (const a of world.archetypes) {
    if (a.chunks.length === 0) {
      idle++;
      const existing = archContainer.querySelector<HTMLElement>(
        `.arch[data-arch-id="${a.id}"]`,
      );
      if (existing) existing.remove();
      continue;
    }

    let entities = 0;
    for (const c of a.chunks) entities += c.size;
    const fill = (entities / (a.chunks.length * a.capacity)) * 100;
    const isOpen = expanded.has(a.id);

    let card = archContainer.querySelector<HTMLElement>(
      `.arch[data-arch-id="${a.id}"]`,
    );
    if (!card) {
      card = document.createElement("div");
      card.className = `arch${isOpen ? " open" : ""}`;
      card.dataset.archId = String(a.id);
      card.innerHTML = `
        <div class="arch-head" data-id="${a.id}"><i style="background:${archColor(a.id)}"></i><b>${archName(a)}</b>
          <span class="muted">#${a.id}</span><span class="chev">▸</span></div>
        <div class="arch-stats">
          <span><em class="val-ent"></em> сущностей</span><span><em class="val-chk"></em> чанков</span>
          <span><em>${a.capacity}</em> строк/чанк</span><span><em>${a.stride}</em> Б/сущность</span>
          <span><em class="val-mem"></em> памяти</span>
        </div>
        <div class="fillbar"><b class="bar" style="background:${archColor(a.id)}"></b><u class="lbl"></u></div>
        <div class="arch-details"></div>`;
      archContainer.appendChild(card);
    }

    // Сохраняем класс раскрытия
    card.classList.toggle("open", isOpen);

    // Точечное обновление чисел без пересоздания DOM
    card.querySelector(".val-ent")!.textContent = n(entities);
    card.querySelector(".val-chk")!.textContent = String(a.chunks.length);
    card.querySelector(".val-mem")!.textContent = kib(
      a.chunks.length * chunkBytes,
    );
    card.querySelector<HTMLElement>(".bar")!.style.width =
      `${fill.toFixed(1)}%`;
    card.querySelector(".lbl")!.textContent = `${fill.toFixed(0)}% заполнено`;

    const details = card.querySelector<HTMLElement>(".arch-details")!;
    if (isOpen) {
      const first = a.chunks
        .slice(0, 5)
        .map((c) => `${hex(c.ptr)} · ${c.size}/${a.capacity}`)
        .join("<br>");
      const last = a.chunks[a.chunks.length - 1];
      details.innerHTML =
        `<table class="mini"><tr><th>колонка</th><th>тип</th><th>смещение</th><th>байт/чанк</th></tr>` +
        a.columns
          .map(
            (c) =>
              `<tr><td>${c.name}</td><td>${c.type}</td><td>${n(c.offset)}</td><td>${n(BYTES[c.type] * a.capacity)}</td></tr>`,
          )
          .join("") +
        `</table><div class="muted small">чанки (указатель · строк):<br>${first}${
          a.chunks.length > 5
            ? `<br>… ещё ${a.chunks.length - 5}, последний ${hex(last.ptr)} · ${last.size}/${a.capacity}`
            : ""
        }</div>`;
    } else {
      details.innerHTML = "";
    }
  }

  let idleEl = archContainer.querySelector<HTMLElement>(".arch-idle-note");
  if (idle > 0) {
    if (!idleEl) {
      idleEl = document.createElement("div");
      idleEl.className = "muted small arch-idle-note";
      archContainer.appendChild(idleEl);
    }
    idleEl.textContent = `+ ${idle} архетип(ов) без чанков`;
  } else if (idleEl) {
    idleEl.remove();
  }
}

/* ── memory map ── */
type Cell = {
  kind: "reserved" | "chunk" | "free" | "unused";
  ptr: number;
  arch?: Archetype;
  size?: number;
};
const memCanvas = $<HTMLCanvasElement>("memmap");
const PITCH = 8;
let memCells: Cell[] = [],
  memCols = 1;

function drawMemMap(m: ReturnType<World["memoryStats"]>) {
  const total = Math.round(
    (m.reservedBytes + m.maxChunks * m.chunkBytes) / m.chunkBytes,
  );
  memCols = Math.max(8, Math.floor(memCanvas.clientWidth / PITCH));
  const { x } = fit(memCanvas, Math.ceil(total / memCols) * PITCH);
  x.clearRect(0, 0, memCanvas.clientWidth, memCanvas.clientHeight);

  const reservedCells = Math.ceil(m.reservedBytes / m.chunkBytes);
  memCells = Array.from(
    { length: total },
    (_, i): Cell => ({
      kind:
        i < reservedCells
          ? "reserved"
          : i < reservedCells + m.allocatedChunks
            ? "free"
            : "unused",
      ptr: i * m.chunkBytes,
    }),
  );
  for (const a of world.archetypes) {
    for (const c of a.chunks)
      memCells[Math.floor(c.ptr / m.chunkBytes)] = {
        kind: "chunk",
        ptr: c.ptr,
        arch: a,
        size: c.size,
      };
  }
  const S = PITCH - 1;
  memCells.forEach((cell, i) => {
    const cx = (i % memCols) * PITCH,
      cy = Math.floor(i / memCols) * PITCH;
    if (cell.kind === "chunk") {
      const fill = cell.size! / cell.arch!.capacity;
      x.fillStyle = "#1b2430";
      x.fillRect(cx, cy, S, S);
      x.fillStyle = archColor(cell.arch!.id);
      const hh = Math.max(1, Math.round(S * fill));
      x.fillRect(cx, cy + S - hh, S, hh);
    } else if (cell.kind === "reserved") {
      x.fillStyle = "#59677a";
      x.fillRect(cx, cy, S, S);
    } else if (cell.kind === "free") {
      x.strokeStyle = "#ffc857";
      x.lineWidth = 1;
      x.strokeRect(cx + 0.5, cy + 0.5, S - 1, S - 1);
    } else {
      x.fillStyle = "#10161d";
      x.fillRect(cx, cy, S, S);
    }
  });
}
memCanvas.addEventListener("pointermove", (e) => {
  const r = memCanvas.getBoundingClientRect();
  const i =
    Math.floor((e.clientY - r.top) / PITCH) * memCols +
    Math.floor((e.clientX - r.left) / PITCH);
  const cell = memCells[i];
  $("memhover").textContent = !cell
    ? ""
    : cell.kind === "chunk"
      ? `ячейка ${i} · ptr ${hex(cell.ptr)} · ${archName(cell.arch!)} · ${cell.size}/${cell.arch!.capacity} строк`
      : cell.kind === "reserved"
        ? `ячейка ${i} · ${hex(cell.ptr)} · резерв для стека и глобальных данных wasm-модулей`
        : cell.kind === "free"
          ? `ячейка ${i} · ${hex(cell.ptr)} · освобождён, ждёт повторного использования (free-list)`
          : `ячейка ${i} · ${hex(cell.ptr)} · ещё не выдавался`;
});
memCanvas.addEventListener("pointerleave", () => {
  $("memhover").textContent = "";
});

/* ── periodic DOM update (4 Hz) ── */
function updateUi() {
  const s = world.stats(),
    m = world.memoryStats();
  const live: number[] = [];
  for (let k = 0; k < filled; k++)
    live.push(totals[(head - filled + k + HISTORY) % HISTORY]);
  const sorted = live.slice().sort((a, b) => a - b);
  const avg = live.length ? live.reduce((a, b) => a + b, 0) / live.length : 0;
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    : 0;
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  const now = live.length ? live[live.length - 1] : 0;

  let data = 0,
    slack = 0,
    usedChunks = 0;
  for (const a of world.archetypes) {
    for (const c of a.chunks) {
      data += c.size * a.stride;
      usedChunks++;
    }
  }
  slack = usedChunks * m.chunkBytes - data;

  const kpi = (label: string, value: string, cls = "") =>
    `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b></div>`;
  $("kpis").innerHTML =
    kpi(
      "работа за кадр",
      now.toFixed(2) + " мс",
      now > 16.7 ? "bad" : now > 8 ? "warn" : "good",
    ) +
    kpi(
      "среднее / p95 / макс",
      `${avg.toFixed(1)} / ${p95.toFixed(1)} / ${max.toFixed(1)}`,
    ) +
    kpi("кадров/с (rAF)", fps.toFixed(0)) +
    kpi("сущностей", n(s.entities)) +
    kpi(
      "архетипов с данными",
      String(world.archetypes.filter((a) => a.chunks.length).length),
    ) +
    kpi("чанков в работе", `${usedChunks} / ${m.maxChunks}`);
  $("fps").textContent = `${fps.toFixed(0)} fps · ${now.toFixed(1)} мс`;

  sysRows.forEach((r, i) => {
    r.ms.textContent = slots[i].enabled ? ema[i].toFixed(2) : "выкл";
    r.bar.style.width = Math.min(100, (ema[i] / 16.7) * 100).toFixed(1) + "%";
  });

  updateArchetypesUi(m.chunkBytes);
  drawMemMap(m);
  $("memtext").innerHTML =
    `<div><b>Арена:</b> ${kib(m.totalBytes)}, фиксированная <code>WebAssembly.Memory</code> — не растёт, виды не отсоединяются.</div>` +
    `<div><b>Раскладка:</b> резерв ядрам ${kib(m.reservedBytes)} · чанк ${kib(m.chunkBytes)} · maxChunks ${m.maxChunks}</div>` +
    `<div><b>Чанки:</b> выдано ${m.allocatedChunks} · в работе ${usedChunks} · free-list ${m.freeChunks} · не выдавались ${m.maxChunks - m.allocatedChunks}</div>` +
    `<div><b>Данные сущностей:</b> ${kib(data)} · пустоты внутри чанков ${kib(slack)} (${usedChunks ? ((slack / (usedChunks * m.chunkBytes)) * 100).toFixed(0) : 0}%)</div>` +
    `<div class="legend-mem"><span><i style="background:#59677a"></i>резерв</span><span><i style="background:#4cc9f0"></i>чанк (высота = заполнение)</span>` +
    `<span><i class="ring"></i>free-list</span><span><i style="background:#10161d"></i>не выдан</span></div>`;
}

/* ═══════════════════════════ run ═══════════════════════════ */

(window as unknown as { __ecs: unknown }).__ecs = {
  world,
  schedule,
  settings,
  mouse,
};

try {
  await schedule.init();
} catch (err) {
  showError(err);
}

if (!wasmReady) {
  for (const b of modeButtons) if (b.dataset.mode !== "js") b.disabled = true;
  selectMode("js");
  $("wasmNote").textContent =
    "WASM недоступен: " +
    (wasmError || "модуль не загрузился") +
    ". Работает JS.";
} else {
  $("wasmNote").textContent =
    "WASM-ядро загружено: общая память движка, указатели колонок передаются прямо в модуль.";
}
selectMode(settings.mode);

let last = performance.now(),
  lastUi = 0;
function frame(now: number) {
  try {
    const delta = now - last;
    last = now;
    if (delta > 0) fps += (1000 / delta - fps) * 0.05;
    const dt = settings.paused ? 0 : Math.min(delta / 1000, 0.05);
    const t0 = performance.now();
    schedule.run(dt);
    record(performance.now() - t0);
    drawChart();
    if (now - lastUi > 250) {
      lastUi = now;
      updateUi();
    }
    requestAnimationFrame(frame);
  } catch (err) {
    showError(err);
  }
}
requestAnimationFrame(frame);
