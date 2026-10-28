// ============================================================
// core.ts
// ============================================================

// ---------- Field types ----------

type FieldType = "f32" | "f64" | "i32" | "u32" | "u8" | "bool";
type Schema = Record<string, FieldType>;

type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type ValueOf<F> = F extends "f32" | "f64" | "i32" | "u32" | "u8"
  ? number
  : F extends "bool"
    ? boolean
    : never;

type ValuesOf<L> = { [K in keyof L]: ValueOf<L[K]> };

type TypedArrayOf<F> = F extends "f32"
  ? Float32Array
  : F extends "f64"
    ? Float64Array
    : F extends "i32"
      ? Int32Array
      : F extends "u32"
        ? Uint32Array
        : F extends "u8" | "bool"
          ? Uint8Array
          : never;

type ViewsOf<L> = { readonly [K in keyof L]: TypedArrayOf<L[K]> };

type ComponentLayout<N extends string, S extends Schema> = {
  [K in keyof S as `${N}.${K & string}`]: S[K];
};

// ---------- Component ----------

export interface ComponentLike {
  readonly mask: number;
  readonly layout: Record<string, FieldType>;
}

const NOT: unique symbol = Symbol("not");
const ANY: unique symbol = Symbol("any");

export interface NotTerm {
  readonly [NOT]: ComponentLike;
}
export interface AnyTerm {
  readonly [ANY]: readonly ComponentLike[];
}
export type QueryTerm = ComponentLike | NotTerm | AnyTerm;

export class Component<
  L extends Record<string, FieldType> = Record<string, FieldType>,
> implements ComponentLike {
  constructor(
    readonly mask: number,
    readonly layout: L,
  ) {}

  exclude(): NotTerm {
    return { [NOT]: this };
  }
  or(...others: ComponentLike[]): AnyTerm {
    return { [ANY]: [this, ...others] };
  }
}

export function not(c: ComponentLike): NotTerm {
  return { [NOT]: c };
}
export function any(...cs: ComponentLike[]): AnyTerm {
  return { [ANY]: cs };
}

// ---------- createComponent ----------

let nextComponentId = 0;
const MAX_COMPONENTS = 31;

export function createComponent<N extends string, S extends Schema = {}>(
  name: N,
  schema?: S,
): Component<Expand<ComponentLayout<N, S>>> {
  const id = nextComponentId++;
  if (id >= MAX_COMPONENTS) {
    throw new Error(`Too many components (max ${MAX_COMPONENTS})`);
  }
  const mask = 1 << id;
  const shape = (schema ?? {}) as Schema;
  const layout: Record<string, FieldType> = {};
  for (const k of Object.keys(shape)) {
    layout[`${name}.${k}`] = shape[k];
  }
  return new Component(mask, layout as Expand<ComponentLayout<N, S>>);
}

// ---------- bundle (бывший and) ----------

type MergeLayouts<T extends readonly ComponentLike[]> = T extends readonly [
  infer H,
  ...infer R,
]
  ? H extends Component<infer L>
    ? R extends readonly ComponentLike[]
      ? R extends readonly []
        ? L
        : Expand<L & MergeLayouts<R>>
      : never
    : never
  : {};

export function composeComponent<
  A extends ComponentLike,
  B extends ComponentLike,
  R extends readonly ComponentLike[],
>(a: A, b: B, ...rest: [...R]): Component<MergeLayouts<[A, B, ...R]>> {
  let mask = a.mask | b.mask;
  for (const c of rest) mask |= c.mask;

  const layout: Record<string, FieldType> = { ...a.layout, ...b.layout };
  for (const c of rest) Object.assign(layout, c.layout);

  return new Component(mask, layout as MergeLayouts<[A, B, ...R]>);
}

// ---------- Query typing ----------

type QueryLayout<T extends readonly QueryTerm[]> = T extends readonly [
  infer H,
  ...infer R,
]
  ? R extends readonly QueryTerm[]
    ? H extends Component<infer L>
      ? Expand<L & QueryLayout<R>>
      : QueryLayout<R>
    : {}
  : {};

// ---------- ChunkAccess / Query ----------

export interface ChunkAccess<
  L extends Record<string, FieldType> = Record<string, FieldType>,
> {
  readonly count: number;
  readonly views: ViewsOf<L>;
  readonly mask: number;
}

export interface Query<
  L extends Record<string, FieldType> = Record<string, FieldType>,
> extends Iterable<ChunkAccess<L>> {
  readonly mask: number;
  readonly size: number;
}

// ---------- has (type guard) ----------

export function has<L extends Record<string, FieldType>>(
  chunk: ChunkAccess<Record<string, FieldType>>,
  c: Component<L>,
): chunk is ChunkAccess<L> {
  return (chunk.mask & c.mask) === c.mask;
}

// ---------- World ----------

export type Entity = number;

export interface WorldConfig {
  readonly chunkCount: number;
  readonly chunkSize: number;
}

const SIZE: Record<FieldType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  u32: 4,
  u8: 1,
  bool: 1,
};

interface Chunk {
  offset: number;
  count: number;
}

interface Archetype {
  mask: number;
  layout: Record<string, FieldType>;
  columnKeys: string[];
  columnOffsets: Map<string, number>; // байт от начала чанка до начала колонки
  columnTypes: Map<string, FieldType>;
  capacity: number;
  stride: number; // байт на сущность (сумма elemSize всех колонок)
  chunks: Chunk[];
}

export class World {
  private readonly config: WorldConfig;
  private readonly arena: ArrayBuffer;
  private readonly chunkPool: Chunk[] = [];
  private readonly archetypes = new Map<number, Archetype>();
  private nextEntity: Entity = 0;
  private readonly locations = new Map<
    Entity,
    { archetype: Archetype; chunk: Chunk; index: number }
  >();

  constructor(config: WorldConfig) {
    this.config = config;
    this.arena = new ArrayBuffer(config.chunkCount * config.chunkSize);
    for (let i = 0; i < config.chunkCount; i++) {
      this.chunkPool.push({ offset: i * config.chunkSize, count: 0 });
    }
  }

  // ---------- spawn ----------

  spawn<L extends Record<string, FieldType>>(
    b: Component<L>,
    values: ValuesOf<L>,
  ): Entity {
    const arch = this.getOrCreateArchetype(b.mask, b.layout);

    let chunk = arch.chunks[arch.chunks.length - 1];
    if (!chunk || chunk.count >= arch.capacity) {
      const raw = this.chunkPool.pop();
      if (!raw) throw new Error("Chunk pool exhausted");
      raw.count = 0;
      arch.chunks.push(raw);
      chunk = raw;
    }

    const entity = this.nextEntity++;
    const index = chunk.count++;

    for (const [key, value] of Object.entries(
      values as Record<string, unknown>,
    )) {
      const colOff = arch.columnOffsets.get(key);
      const type = arch.columnTypes.get(key);
      if (colOff === undefined || type === undefined) continue;
      const elemSize = SIZE[type];
      const byteOffset = chunk.offset + colOff + index * elemSize;
      this.writeField(byteOffset, type, value);
    }

    this.locations.set(entity, { archetype: arch, chunk, index });
    return entity;
  }

  // ---------- query ----------

  query<T extends readonly QueryTerm[]>(
    ...terms: [...T]
  ): Query<Expand<QueryLayout<T>>> {
    let withMask = 0;
    let withoutMask = 0;
    let anyMask = 0;
    const withComponents: ComponentLike[] = [];

    for (const t of terms) {
      if (typeof t === "object" && t !== null && NOT in t) {
        withoutMask |= (t as NotTerm)[NOT].mask;
      } else if (typeof t === "object" && t !== null && ANY in t) {
        for (const c of (t as AnyTerm)[ANY]) anyMask |= c.mask;
      } else {
        const c = t as ComponentLike;
        withMask |= c.mask;
        withComponents.push(c);
      }
    }

    // ViewsOnly для with-компонентов (any/not не дают данных)
    const exposedLayout: Record<string, FieldType> = {};
    for (const c of withComponents) Object.assign(exposedLayout, c.layout);

    const chunks: ChunkAccess<any>[] = [];
    for (const arch of this.archetypes.values()) {
      if ((arch.mask & withMask) !== withMask) continue;
      if ((arch.mask & withoutMask) !== 0) continue;
      if (anyMask !== 0 && (arch.mask & anyMask) === 0) continue;
      for (const chunk of arch.chunks) {
        if (chunk.count === 0) continue;
        chunks.push(this.makeChunkAccess(arch, chunk, exposedLayout));
      }
    }

    const result: Query<any> = {
      mask: withMask | anyMask,
      size: chunks.length,
      *[Symbol.iterator]() {
        for (const c of chunks) yield c;
      },
    };
    return result as Query<Expand<QueryLayout<T>>>;
  }

  // ---------- helpers ----------

  private getOrCreateArchetype(
    mask: number,
    layout: Record<string, FieldType>,
  ): Archetype {
    let arch = this.archetypes.get(mask);
    if (arch) return arch;

    const columnKeys = Object.keys(layout);
    let stride = 0;
    for (const key of columnKeys) stride += SIZE[layout[key]];

    const capacity = Math.max(1, Math.floor(this.config.chunkSize / stride));

    const columnOffsets = new Map<string, number>();
    const columnTypes = new Map<string, FieldType>();
    let curOffset = 0;
    for (const key of columnKeys) {
      const type = layout[key];
      const elemSize = SIZE[type];
      columnOffsets.set(key, curOffset);
      columnTypes.set(key, type);
      curOffset += capacity * elemSize;
    }

    arch = {
      mask,
      layout,
      columnKeys,
      columnOffsets,
      columnTypes,
      capacity,
      stride,
      chunks: [],
    };
    this.archetypes.set(mask, arch);
    return arch;
  }

  private makeChunkAccess(
    arch: Archetype,
    chunk: Chunk,
    exposed: Record<string, FieldType>,
  ): ChunkAccess<any> {
    const views: Record<string, any> = {};
    for (const key of Object.keys(exposed)) {
      const colOff = arch.columnOffsets.get(key);
      const type = arch.columnTypes.get(key);
      if (colOff === undefined || type === undefined) continue;
      views[key] = this.makeView(type, chunk.offset + colOff, chunk.count);
    }
    return { count: chunk.count, views, mask: arch.mask };
  }

  private makeView(
    type: FieldType,
    byteOffset: number,
    length: number,
  ): Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array {
    switch (type) {
      case "f32":
        return new Float32Array(this.arena, byteOffset, length);
      case "f64":
        return new Float64Array(this.arena, byteOffset, length);
      case "i32":
        return new Int32Array(this.arena, byteOffset, length);
      case "u32":
        return new Uint32Array(this.arena, byteOffset, length);
      case "u8":
      case "bool":
        return new Uint8Array(this.arena, byteOffset, length);
    }
  }

  private writeField(
    byteOffset: number,
    type: FieldType,
    value: unknown,
  ): void {
    switch (type) {
      case "f32":
        new Float32Array(this.arena, byteOffset, 1)[0] = value as number;
        break;
      case "f64":
        new Float64Array(this.arena, byteOffset, 1)[0] = value as number;
        break;
      case "i32":
        new Int32Array(this.arena, byteOffset, 1)[0] = value as number;
        break;
      case "u32":
        new Uint32Array(this.arena, byteOffset, 1)[0] = value as number;
        break;
      case "u8":
        new Uint8Array(this.arena, byteOffset, 1)[0] = value as number;
        break;
      case "bool":
        new Uint8Array(this.arena, byteOffset, 1)[0] = value ? 1 : 0;
        break;
    }
  }
}

const DEFAULT_CONFIG: WorldConfig = {
  chunkCount: 512,
  chunkSize: 16 * 1024,
};

export function createWorld(config: Partial<WorldConfig> = {}): World {
  return new World({ ...DEFAULT_CONFIG, ...config });
}
