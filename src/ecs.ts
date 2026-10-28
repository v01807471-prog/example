/**
 * ecs.ts — a tiny archetype ECS on top of TypedArrays.
 *
 *  Component   name + schema  →  layout { "Position.x": "f32", ... } + a mask bit
 *  compose()   merges components into ONE new component (union of masks, merged layout)
 *  Archetype   owns a component mask and the physical column layout for that mask
 *  Chunk       is only a pointer + size; the bytes live in one fixed WebAssembly.Memory
 *  Query       takes one component (usually a composed one) and yields typed columns
 */

/* ───────────────────────────── field types ───────────────────────────── */

interface ArrayMap {
  i8: Int8Array;   u8: Uint8Array;
  i16: Int16Array; u16: Uint16Array;
  i32: Int32Array; u32: Uint32Array;
  f32: Float32Array; f64: Float64Array;
}
export type FieldType = keyof ArrayMap;
type TypedArray = ArrayMap[FieldType];
type ArrayCtor = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => TypedArray;

const FIELD: Record<FieldType, { ctor: ArrayCtor; size: number }> = {
  i8:  { ctor: Int8Array,    size: 1 }, u8:  { ctor: Uint8Array,   size: 1 },
  i16: { ctor: Int16Array,   size: 2 }, u16: { ctor: Uint16Array,  size: 2 },
  i32: { ctor: Int32Array,   size: 4 }, u32: { ctor: Uint32Array,  size: 4 },
  f32: { ctor: Float32Array, size: 4 }, f64: { ctor: Float64Array, size: 8 },
};

/* ───────────────────────────── components ────────────────────────────── */

export type Schema = Record<string, FieldType>;
export type Layout = Record<string, FieldType>;

export interface Component<L = Layout> {
  readonly name: string;
  readonly mask: bigint;
  readonly layout: Readonly<L>;
}

export type Values<L> = { [K in keyof L]: number };
export type Columns<L> = { [K in keyof L]: L[K] extends FieldType ? ArrayMap[L[K]] : never };

type Qualified<N extends string, S extends Schema> = {
  [K in keyof S & string as `${N}.${K}`]: S[K];
};
type UnionToIntersection<U> =
  (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type Merged<C extends readonly Component<any>[]> = UnionToIntersection<
  { [I in keyof C]: C[I] extends Component<infer L> ? L : never }[number]
>;

const bases: Component[] = [];            // base components, indexed by mask bit
const names = new Set<string>();

/** Declare a component: a name and a schema. Fields are exposed as "Name.field". */
export function defineComponent<N extends string, S extends Schema>(
  name: N,
  schema: S,
): Component<Qualified<N, S>> {
  if (names.has(name)) throw new Error(`Component "${name}" is already defined`);
  const layout: Layout = {};
  for (const [field, type] of Object.entries(schema)) {
    if (!(type in FIELD)) throw new Error(`${name}.${field}: unknown type "${type}"`);
    layout[`${name}.${field}`] = type;
  }
  const component = Object.freeze({
    name,
    mask: 1n << BigInt(bases.length),
    layout: Object.freeze(layout),
  });
  names.add(name);
  bases.push(component);
  return component as unknown as Component<Qualified<N, S>>;
}

/**
 * Merge components into a single new one: mask = OR of the masks,
 * layout = all fields side by side. Composed components can be composed again.
 */
export function compose<N extends string, C extends readonly Component<any>[]>(
  name: N,
  ...parts: C
): Component<Merged<C>> {
  let mask = 0n;
  const layout: Layout = {};
  for (const part of parts) {
    mask |= part.mask;
    Object.assign(layout, part.layout);
  }
  return Object.freeze({ name, mask, layout: Object.freeze(layout) }) as unknown as Component<Merged<C>>;
}

/** Names of the base components whose bits are set in a mask (for inspectors and logs). */
export function componentsOf(mask: bigint): string[] {
  const out: string[] = [];
  for (let bit = 0; bit < bases.length; bit++) {
    if ((mask >> BigInt(bit)) & 1n) out.push(bases[bit].name);
  }
  return out;
}

/** Full field layout for a mask (the union of its base components). */
function layoutOf(mask: bigint): Layout {
  const layout: Layout = {};
  for (let bit = 0; bit < bases.length; bit++) {
    if ((mask >> BigInt(bit)) & 1n) Object.assign(layout, bases[bit].layout);
  }
  return layout;
}

/* ───────────────────── arena: one fixed WebAssembly.Memory ─────────────────── */

/**
 * All chunk bytes live in a single WebAssembly.Memory whose size is fixed up front
 * (initial == maximum), so it never grows and no typed-array view is ever detached.
 * A pointer is a plain byte address in that memory, which is exactly what a wasm
 * kernel expects. The first `reserved` bytes are left alone for kernels' own
 * stack and globals; address 0 is therefore never a valid chunk.
 */
class Arena {
  readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBufferLike;
  private readonly free: number[] = [];
  private top: number;
  private readonly end: number;

  constructor(readonly chunkBytes: number, readonly maxChunks: number, readonly reserved: number, shared: boolean) {
    if (chunkBytes % 16 || reserved % 16) throw new Error("chunkBytes and reservedBytes must be multiples of 16");
    this.end = reserved + chunkBytes * maxChunks;
    const pages = Math.ceil(this.end / 65536);
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared });
    this.buffer = this.memory.buffer;
    this.top = reserved;
  }

  alloc(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.top + this.chunkBytes > this.end) throw new Error("Arena is full: raise maxChunks");
    const ptr = this.top;
    this.top += this.chunkBytes;
    return ptr;
  }

  release(ptr: number): void {
    new Uint8Array(this.buffer, ptr, this.chunkBytes).fill(0);
    this.free.push(ptr);
  }

  stats() {
    return {
      totalBytes: this.memory.buffer.byteLength,
      chunkBytes: this.chunkBytes,
      maxChunks: this.maxChunks,
      reservedBytes: this.reserved,
      allocatedChunks: (this.top - this.reserved) / this.chunkBytes,   // ever handed out
      freeChunks: this.free.length,                                    // released, waiting for reuse
    };
  }

  /** A typed window into a chunk. The memory never moves, so the view stays valid. */
  view(ctor: ArrayCtor, ptr: number, byteOffset: number, length: number): TypedArray {
    return new ctor(this.buffer, ptr + byteOffset, length);
  }
}

/* ─────────────────────────── chunk & archetype ────────────────────────── */

/** A chunk is just where it lives and how many rows are used. */
export class Chunk {
  constructor(readonly ptr: number, public size = 0) {}
}

/** Typed lens over a chunk, built once when the chunk is allocated. */
export class ChunkView<L = Layout> {
  constructor(
    readonly chunk: Chunk,
    readonly entities: Uint32Array,
    readonly cols: Columns<L>,
    readonly arrays: TypedArray[],
    private readonly offsets: ReadonlyMap<string, number>,
  ) {}
  get count(): number { return this.chunk.size; }

  /** Byte address of a column in the arena memory, for handing to a wasm kernel. */
  ptr(name: (keyof L & string) | "$entity"): number {
    const offset = this.offsets.get(name);
    if (offset === undefined) throw new Error(`Unknown column "${name}"`);
    return this.chunk.ptr + offset;
  }
}

interface Column { name: string; type: FieldType; offset: number }
const ENTITY = "$entity";

/**
 * Owns the component mask and the physical layout for that mask.
 * Columns are sorted by element size (descending), so every column is
 * naturally aligned without padding.
 */
export class Archetype {
  readonly columns: Column[];
  readonly capacity: number;
  /** Bytes one entity occupies across all columns. */
  readonly stride: number;
  readonly chunks: Chunk[] = [];
  readonly views: ChunkView[] = [];
  readonly column = new Map<string, number>();
  readonly offsets = new Map<string, number>();
  private readonly entityColumn: number;

  constructor(
    readonly id: number,
    readonly mask: bigint,
    layout: Layout,
    private readonly arena: Arena,
  ) {
    const fields = [[ENTITY, "u32"], ...Object.entries(layout)] as [string, FieldType][];
    fields.sort((a, b) => FIELD[b[1]].size - FIELD[a[1]].size);
    const stride = fields.reduce((sum, [, type]) => sum + FIELD[type].size, 0);
    this.stride = stride;
    this.capacity = Math.floor(arena.chunkBytes / stride);
    if (this.capacity < 1) throw new Error("Components do not fit into one chunk");

    let offset = 0;
    this.columns = fields.map(([name, type]) => {
      const column = { name, type, offset };
      offset += FIELD[type].size * this.capacity;
      return column;
    });
    this.columns.forEach((c, i) => { this.column.set(c.name, i); this.offsets.set(c.name, c.offset); });
    this.entityColumn = this.column.get(ENTITY)!;
  }

  /** Append an entity, return its slot (chunkIndex * capacity + row). */
  insert(entity: number): number {
    let ci = this.chunks.length - 1;
    if (ci < 0 || this.chunks[ci].size === this.capacity) { this.grow(); ci++; }
    const row = this.chunks[ci].size++;
    this.views[ci].entities[row] = entity;
    return ci * this.capacity + row;
  }

  /** Swap-remove a slot. Returns the entity that was moved into it (0 if none). */
  remove(slot: number): number {
    const ci = Math.floor(slot / this.capacity);
    const row = slot - ci * this.capacity;
    const last = this.chunks.length - 1;
    const lastChunk = this.chunks[last];
    const lastRow = lastChunk.size - 1;

    let moved = 0;
    if (ci !== last || row !== lastRow) {
      const dst = this.views[ci].arrays;
      const src = this.views[last].arrays;
      for (let k = 0; k < dst.length; k++) dst[k][row] = src[k][lastRow];
      moved = this.views[ci].entities[row];
    }
    if (--lastChunk.size === 0) {
      this.chunks.pop();
      this.views.pop();
      this.arena.release(lastChunk.ptr);
    }
    return moved;
  }

  viewOf(slot: number): ChunkView { return this.views[Math.floor(slot / this.capacity)]; }
  rowOf(slot: number): number { return slot % this.capacity; }

  private grow(): void {
    const chunk = new Chunk(this.arena.alloc());
    const arrays = this.columns.map((c) =>
      this.arena.view(FIELD[c.type].ctor, chunk.ptr, c.offset, this.capacity));
    const cols: Record<string, TypedArray> = {};
    this.columns.forEach((c, i) => { if (i !== this.entityColumn) cols[c.name] = arrays[i]; });
    this.chunks.push(chunk);
    this.views.push(new ChunkView(chunk, arrays[this.entityColumn] as Uint32Array, cols as Columns<Layout>, arrays, this.offsets));
  }
}

/* ───────────────────────────────── query ──────────────────────────────── */

/** A query described without a world, so systems can declare it up front. */
export class QuerySpec<L> {
  constructor(
    readonly component: Component<L>,
    readonly excluded: readonly Component<any>[] = [],
  ) {}
  without(...components: Component<any>[]): QuerySpec<L> {
    return new QuerySpec(this.component, [...this.excluded, ...components]);
  }
}

/** Entities that have the whole component (usually a composed one). */
export const all = <L>(component: Component<L>): QuerySpec<L> => new QuerySpec(component);

export class Query<L> implements Iterable<ChunkView<L>> {
  private matched: Archetype[] = [];
  private seen = 0;
  private variants = new Map<bigint, Query<L>>();

  constructor(
    private readonly world: World,
    readonly component: Component<L>,
    private readonly excluded = 0n,
  ) {}

  /** Same query, minus archetypes that contain any of these components. */
  without(...components: Component<any>[]): Query<L> {
    const excluded = components.reduce((m, c) => m | c.mask, this.excluded);
    let q = this.variants.get(excluded);
    if (!q) this.variants.set(excluded, (q = new Query(this.world, this.component, excluded)));
    return q;
  }

  /** Hot path: one callback per non-empty chunk, no allocations. */
  each(fn: (view: ChunkView<L>) => void): void {
    const world = this.world;
    world.iterating++;                       // structural changes now throw
    try {
      for (const archetype of this.archetypes()) {
        for (const view of archetype.views) if (view.count > 0) fn(view as ChunkView<L>);
      }
    } finally {
      world.iterating--;
    }
  }

  *[Symbol.iterator](): Iterator<ChunkView<L>> {
    const world = this.world;
    world.iterating++;
    try {
      for (const archetype of this.archetypes()) {
        for (const view of archetype.views) if (view.count > 0) yield view as ChunkView<L>;
      }
    } finally {
      world.iterating--;
    }
  }

  get count(): number {
    let n = 0;
    for (const a of this.archetypes()) for (const c of a.chunks) n += c.size;
    return n;
  }

  private archetypes(): Archetype[] {
    const all = this.world.archetypes;
    const need = this.component.mask;
    for (; this.seen < all.length; this.seen++) {
      const a = all[this.seen];
      if ((a.mask & need) === need && (a.mask & this.excluded) === 0n) this.matched.push(a);
    }
    return this.matched;
  }
}

/* ───────────────────────────────── world ──────────────────────────────── */

export type Entity = number & { readonly __entity: unique symbol };

const INDEX_BITS = 20;                       // 1M live entities, 4096 generations
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const GEN_MASK = 0xfff;
const PENDING = -2;                          // id handed out, entity not placed yet

export interface WorldOptions {
  chunkBytes?: number;      // bytes per chunk, multiple of 16 (default 16 KiB)
  maxChunks?: number;       // chunks the arena can ever hold (default 1024)
  reservedBytes?: number;   // untouched bytes at the start for kernels' stack/globals (default 64 KiB)
  shared?: boolean;         // back the arena with a shared memory (SharedArrayBuffer)
}

export class World {
  readonly archetypes: Archetype[] = [];
  /** > 0 while a query is being iterated. Managed by Query. */
  iterating = 0;
  private readonly byMask = new Map<bigint, Archetype>();
  private readonly queries = new Map<bigint, Query<any>>();
  private readonly arena: Arena;

  // entity table: one row per entity index
  private generation = new Uint16Array(1024);
  private recArch = new Int32Array(1024);
  private recSlot = new Int32Array(1024);
  private freeIndices: number[] = [];
  private nextIndex = 1;                     // index 0 is reserved: entity 0 = null

  constructor({ chunkBytes = 16 * 1024, maxChunks = 1024, reservedBytes = 64 * 1024, shared = false }: WorldOptions = {}) {
    this.arena = new Arena(chunkBytes, maxChunks, reservedBytes, shared);
    this.archetypeFor(0n);                   // archetype 0: the empty one
  }

  /** The linear memory that holds every chunk; import it into wasm kernels. */
  get memory(): WebAssembly.Memory { return this.arena.memory; }

  /* lifecycle */

  spawn<L>(component?: Component<L>, init?: Partial<Values<L>>): Entity {
    const entity = this.reserve();
    try {
      this.materialize(entity, component, init);
    } catch (err) {
      this.abandon(entity);                  // arena full, bad init field...: give the id back
      throw err;
    }
    return entity;
  }

  /** Claim an id now; the entity shows up in the world once it is materialized. */
  reserve(): Entity {
    const index = this.freeIndices.pop() ?? this.newIndex();
    this.recArch[index] = PENDING;
    return (((this.generation[index] << INDEX_BITS) | index) >>> 0) as Entity;
  }

  /** Place a reserved entity into its archetype. */
  materialize<L>(entity: Entity, component?: Component<L>, init?: Partial<Values<L>>): void {
    this.assertUnlocked("spawn");
    const index = entity & INDEX_MASK;
    if (this.recArch[index] !== PENDING || this.generation[index] !== entity >>> INDEX_BITS) {
      throw new Error(`Entity ${entity} was not reserved`);
    }
    const archetype = this.archetypeFor(component?.mask ?? 0n);
    const slot = archetype.insert(entity);   // may throw (arena full): nothing is recorded yet
    this.recArch[index] = archetype.id;
    this.recSlot[index] = slot;
    if (init) this.write(index, init);
  }

  destroy(entity: Entity): void {
    this.assertUnlocked("destroy");
    const index = this.indexOf(entity);
    this.detach(index);
    this.recArch[index] = -1;
    this.generation[index] = (this.generation[index] + 1) & GEN_MASK;
    this.freeIndices.push(index);
  }

  alive(entity: Entity): boolean {
    const index = entity & INDEX_MASK;
    return index > 0 && index < this.nextIndex &&
      this.generation[index] === entity >>> INDEX_BITS && this.recArch[index] >= 0;
  }

  /* structural changes: move the entity to the archetype of the new mask */

  add<L>(entity: Entity, component: Component<L>, init?: Partial<Values<L>>): void {
    this.assertUnlocked("add");
    const index = this.indexOf(entity);
    const mask = this.archetypes[this.recArch[index]].mask | component.mask;
    this.moveTo(index, this.archetypeFor(mask));
    if (init) this.write(index, init);
  }

  remove(entity: Entity, component: Component<any>): void {
    this.assertUnlocked("remove");
    const index = this.indexOf(entity);
    const mask = this.archetypes[this.recArch[index]].mask & ~component.mask;
    this.moveTo(index, this.archetypeFor(mask));
  }

  has(entity: Entity, component: Component<any>): boolean {
    if (!this.alive(entity)) return false;
    const mask = this.archetypes[this.recArch[entity & INDEX_MASK]].mask;
    return (mask & component.mask) === component.mask;
  }

  /* single-entity access (slow path — use queries for bulk work) */

  get<L>(entity: Entity, component: Component<L>): Values<L> | undefined {
    if (!this.has(entity, component)) return undefined;
    const index = entity & INDEX_MASK;
    const a = this.archetypes[this.recArch[index]];
    const slot = this.recSlot[index];
    const { arrays } = a.viewOf(slot);
    const row = a.rowOf(slot);
    const out: Record<string, number> = {};
    for (const key of Object.keys(component.layout)) out[key] = arrays[a.column.get(key)!][row];
    return out as Values<L>;
  }

  set<L>(entity: Entity, component: Component<L>, values: Partial<Values<L>>): void {
    if (!this.has(entity, component)) throw new Error(`Entity has no ${component.name}`);
    this.write(entity & INDEX_MASK, values);
  }

  /* queries */

  query<L>(component: Component<L>): Query<L> {
    let q = this.queries.get(component.mask);
    if (!q) this.queries.set(component.mask, (q = new Query(this, component)));
    return q as Query<L>;
  }

  /** Turn a declared query into this world's cached Query. */
  resolve<L>(spec: QuerySpec<L>): Query<L> {
    const q = this.query(spec.component);
    return spec.excluded.length ? q.without(...spec.excluded) : q;
  }

  /** Arena layout: sizes, how many chunks were handed out, how many wait for reuse. */
  memoryStats() { return this.arena.stats(); }

  stats() {
    let entities = 0, chunks = 0;
    for (const a of this.archetypes) for (const c of a.chunks) { chunks++; entities += c.size; }
    return { entities, archetypes: this.archetypes.length, chunks };
  }

  /* internals */

  private archetypeFor(mask: bigint): Archetype {
    let a = this.byMask.get(mask);
    if (!a) {
      a = new Archetype(this.archetypes.length, mask, layoutOf(mask), this.arena);
      this.archetypes.push(a);
      this.byMask.set(mask, a);
    }
    return a;
  }

  /** Undo a spawn that failed half-way: drop the row if it was placed, free the id. */
  private abandon(entity: Entity): void {
    const index = entity & INDEX_MASK;
    if (this.recArch[index] >= 0) this.detach(index);
    this.recArch[index] = -1;
    this.freeIndices.push(index);
  }

  private assertUnlocked(op: string): void {
    if (this.iterating > 0) {
      throw new Error(`world.${op}() while a query is iterating would corrupt chunks; queue it with cmd.${op}() instead`);
    }
  }

  private indexOf(entity: Entity): number {
    if (!this.alive(entity)) throw new Error(`Entity ${entity} is not alive`);
    return entity & INDEX_MASK;
  }

  private newIndex(): number {
    const index = this.nextIndex++;
    if (index >= this.generation.length) {
      const size = this.generation.length * 2;
      this.generation = grow(this.generation, size);
      this.recArch = grow(this.recArch, size);
      this.recSlot = grow(this.recSlot, size);
    }
    return index;
  }

  /** Remove the entity's row; whoever got swapped into the hole gets a new slot. */
  private detach(index: number): void {
    const a = this.archetypes[this.recArch[index]];
    const slot = this.recSlot[index];
    const moved = a.remove(slot);
    if (moved) this.recSlot[moved & INDEX_MASK] = slot;
  }

  private moveTo(index: number, to: Archetype): void {
    const from = this.archetypes[this.recArch[index]];
    if (from === to) return;
    const oldSlot = this.recSlot[index];
    const entity = from.viewOf(oldSlot).entities[from.rowOf(oldSlot)];

    const newSlot = to.insert(entity);
    const src = from.viewOf(oldSlot).arrays, srcRow = from.rowOf(oldSlot);
    const dst = to.viewOf(newSlot).arrays, dstRow = to.rowOf(newSlot);
    for (const [name, k] of to.column) {
      const j = from.column.get(name);
      if (j !== undefined) dst[k][dstRow] = src[j][srcRow];   // shared fields travel along
    }

    this.detach(index);
    this.recArch[index] = to.id;
    this.recSlot[index] = newSlot;
  }

  private write(index: number, values: object): void {
    const a = this.archetypes[this.recArch[index]];
    const slot = this.recSlot[index];
    const { arrays } = a.viewOf(slot);
    const row = a.rowOf(slot);
    for (const [key, value] of Object.entries(values)) {
      const k = a.column.get(key);
      if (k === undefined) throw new Error(`Unknown field "${key}"`);
      arrays[k][row] = value as number;
    }
  }
}

function grow<T extends Uint16Array | Int32Array>(old: T, size: number): T {
  const next = new (old.constructor as new (n: number) => T)(size);
  next.set(old);
  return next;
}