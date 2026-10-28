/**
 * systems.ts — deferred commands and systems on top of ecs.ts.
 *
 *  Commands    records spawn / destroy / add / remove / set, applies them in order on flush()
 *  defineSystem declares queries (and optional wasm kernels) up front; run() gets a
 *              narrow context, not the World
 *  loadWasm    instantiates a .wasm file with the engine memory imported as env.memory
 *  Schedule    runs systems in order and flushes the buffer after each one (a sync point)
 */
import type { Component, Entity, Query, QuerySpec, Values, World } from "./ecs";

/* ─────────────────────────────── commands ─────────────────────────────── */

const SPAWN = 0, DESTROY = 1, ADD = 2, REMOVE = 3, SET = 4;

/**
 * A command buffer. spawn() hands back a real Entity id immediately (it is only
 * reserved), so the handle can be used in later commands of the same buffer.
 * Commands are applied in order; commands aimed at dead entities are skipped.
 * Init objects are read at flush time, so pass a fresh object per call.
 */
export class Commands {
  private ops: number[] = [];
  private entities: Entity[] = [];
  private components: (Component<any> | undefined)[] = [];
  private payloads: (object | undefined)[] = [];

  constructor(private readonly world: World) {}

  get length(): number { return this.ops.length; }

  spawn<L>(component?: Component<L>, init?: Partial<Values<L>>): Entity {
    const entity = this.world.reserve();
    this.push(SPAWN, entity, component, init);
    return entity;
  }
  destroy(entity: Entity): void { this.push(DESTROY, entity); }
  add<L>(entity: Entity, component: Component<L>, init?: Partial<Values<L>>): void {
    this.push(ADD, entity, component, init);
  }
  remove(entity: Entity, component: Component<any>): void { this.push(REMOVE, entity, component); }
  set<L>(entity: Entity, component: Component<L>, values: Partial<Values<L>>): void {
    this.push(SET, entity, component, values);
  }

  /** Apply everything in recorded order, then empty the buffer. */
  flush(): void {
    if (this.ops.length === 0) return;
    const { world, ops, entities, components, payloads } = this;
    try {
      for (let i = 0; i < ops.length; i++) {
        const e = entities[i], c = components[i], p = payloads[i] as any;
        switch (ops[i]) {
          case SPAWN:   world.materialize(e, c, p); break;
          case DESTROY: if (world.alive(e)) world.destroy(e); break;
          case ADD:     if (world.alive(e)) world.add(e, c!, p); break;
          case REMOVE:  if (world.alive(e)) world.remove(e, c!); break;
          case SET:     if (world.has(e, c!)) world.set(e, c!, p); break;
        }
      }
    } finally {
      ops.length = entities.length = components.length = payloads.length = 0;
    }
  }

  private push(op: number, entity: Entity, component?: Component<any>, payload?: object): void {
    this.ops.push(op);
    this.entities.push(entity);
    this.components.push(component);
    this.payloads.push(payload);
  }
}

/* ─────────────────────────────── systems ──────────────────────────────── */

type Specs = Record<string, QuerySpec<any>>;
type Resolved<S extends Specs> = {
  [K in keyof S]: S[K] extends QuerySpec<infer L> ? Query<L> : never;
};

/**
 * What a system sees. There is no spawn/destroy/add/remove here, only cmd,
 * so an unsafe structural change is a compile error instead of a runtime one.
 * set() writes values in place (never moves an entity), so it is immediate.
 */
export interface SystemContext<Q, K = {}> {
  readonly dt: number;
  readonly q: Q;
  /** Whatever the system's `kernels` factory returned (wasm exports, helpers...). */
  readonly k: K;
  readonly cmd: Commands;
  alive(entity: Entity): boolean;
  has(entity: Entity, component: Component<any>): boolean;
  get<L>(entity: Entity, component: Component<L>): Values<L> | undefined;
  set<L>(entity: Entity, component: Component<L>, values: Partial<Values<L>>): void;
}

export interface System {
  readonly name: string;
  readonly queries: Specs;
  readonly kernels?: (memory: WebAssembly.Memory) => unknown;
  readonly run: (ctx: any) => void;
}

/**
 * `kernels` receives the engine memory once, when the schedule is initialised, and
 * may be async (loading a .wasm file is). Its result is handed to run() as `ctx.k`.
 */
export function defineSystem<S extends Specs = {}, K = {}>(def: {
  name: string;
  queries?: S;
  kernels?: (memory: WebAssembly.Memory) => K | Promise<K>;
  run: (ctx: SystemContext<Resolved<S>, K>) => void;
}): System {
  return Object.freeze({
    name: def.name,
    queries: def.queries ?? {},
    kernels: def.kernels,
    run: def.run,
  });
}

/* ───────────────────────────────── wasm ───────────────────────────────── */

export type WasmSource = ArrayBuffer | ArrayBufferView | string | URL | Response | Promise<Response>;

/**
 * Instantiate a module that imports the engine memory as `env.memory`
 * (the usual name for Rust/C/AssemblyScript "import memory" builds).
 * Pass bytes, a URL (fetched), or a Response.
 */
export async function loadWasm(
  source: WasmSource,
  memory: WebAssembly.Memory,
  imports: WebAssembly.Imports = {},
): Promise<WebAssembly.Exports> {
  const all: WebAssembly.Imports = { ...imports, env: { ...imports.env, memory } };
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return (await WebAssembly.instantiate(source as BufferSource, all)).instance.exports;
  }
  const response = await (typeof source === "string" || source instanceof URL ? fetch(source) : source);
  if (typeof WebAssembly.instantiateStreaming === "function") {
    return (await WebAssembly.instantiateStreaming(response, all)).instance.exports;
  }
  return (await WebAssembly.instantiate(await response.arrayBuffer(), all)).instance.exports;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

function makeContext<Q>(world: World, q: Q, cmd: Commands): Mutable<SystemContext<Q, unknown>> {
  return {
    dt: 0, q, cmd, k: {},
    alive: (e) => world.alive(e),
    has: (e, c) => world.has(e, c),
    get: (e, c) => world.get(e, c),
    set: (e, c, v) => world.set(e, c, v),
  };
}

/* ─────────────────────────────── schedule ─────────────────────────────── */

/** Runtime state of one scheduled system: switch it off, read what it cost last frame. */
export interface SystemSlot {
  readonly name: string;
  enabled: boolean;
  /** Milliseconds run() took in the last frame (0 when disabled). */
  ms: number;
  /** Milliseconds spent applying its command buffer in the last frame. */
  flushMs: number;
}

export class Schedule {
  readonly cmd: Commands;
  /** One slot per system, in execution order. */
  readonly slots: SystemSlot[] = [];
  private readonly entries: {
    system: System;
    ctx: Mutable<SystemContext<any, unknown>>;
    slot: SystemSlot;
    loaded: boolean;
  }[] = [];
  private ready = true;

  constructor(readonly world: World) {
    this.cmd = new Commands(world);
  }

  /** Systems run in the order they are added. Queries are resolved once, here. */
  add(...systems: System[]): this {
    for (const system of systems) {
      const q: Record<string, Query<any>> = {};
      for (const [key, spec] of Object.entries(system.queries)) q[key] = this.world.resolve(spec);
      const slot: SystemSlot = { name: system.name, enabled: true, ms: 0, flushMs: 0 };
      this.slots.push(slot);
      this.entries.push({ system, ctx: makeContext(this.world, q, this.cmd), slot, loaded: !system.kernels });
      if (system.kernels) this.ready = false;
    }
    return this;
  }

  /** Load every system's kernels (in parallel). Needed once, before run(), if any system has them. */
  async init(): Promise<this> {
    await Promise.all(this.entries.map(async (entry) => {
      if (entry.loaded) return;
      entry.ctx.k = await entry.system.kernels!(this.world.memory);
      entry.loaded = true;
    }));
    this.ready = true;
    return this;
  }

  run(dt: number): void {
    if (!this.ready) throw new Error("Some systems have kernels to load: await schedule.init() before run()");
    for (const { system, ctx, slot } of this.entries) {
      if (!slot.enabled) { slot.ms = slot.flushMs = 0; continue; }
      ctx.dt = dt;
      const t0 = performance.now();
      system.run(ctx);
      const t1 = performance.now();
      this.cmd.flush();                      // sync point after every system
      slot.ms = t1 - t0;
      slot.flushMs = performance.now() - t1;
    }
  }
}
