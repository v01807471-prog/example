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

const NOT: unique symbol = Symbol("not");
const ANY: unique symbol = Symbol("any");

interface NotTerm {
  readonly [NOT]: Component;
}
interface AnyTerm {
  readonly [ANY]: readonly Component[];
}
type QueryTerm = Component | NotTerm | AnyTerm;

type ComponentLayout<N extends string, S extends Schema> = {
  [K in keyof S as `${N}.${K & string}`]: S[K];
};

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

export interface WorldConfig {
  /** Количество чанков в арене. Фиксировано на весь запуск. */
  readonly chunkCount: number;
  /** Размер одного чанка в байтах. Должен быть кратен 16. */
  readonly chunkSize: number;
}

export interface ChunkAccess<
  L extends Record<string, FieldType> = Record<string, FieldType>,
> {
  readonly count: number;
  readonly views: ViewsOf<L>;
  readonly mask: number;
}

export interface Query<L extends Schema = Schema> extends Iterable<
  ChunkAccess<L>
> {
  readonly mask: number;
  readonly size: number;
}

class World {
  private readonly arena: ArrayBuffer;

  constructor(config: WorldConfig) {
    this.arena = new ArrayBuffer(config.chunkCount * config.chunkSize);
  }

  query<T extends readonly QueryTerm[]>(
    ...terms: [...T]
  ): Query<Expand<QueryLayout<T>>> {
    return { mask: 0, size: 0 } as Query<Expand<QueryLayout<T>>>;
  }
}

class Component<
  L extends Record<string, FieldType> = Record<string, FieldType>,
> {
  constructor(
    readonly mask: number,
    readonly layout: L,
  ) {}
  field<K extends keyof L & string>(key: K): L[K] {
    return this.layout[key];
  }
}

let nextComponentId = 0;
const byId: Component[] = [];
const byMask = new Map<number, Component>();

export function has<L extends Schema>(
  chunk: ChunkAccess<Schema>,
  c: Component<L>,
): chunk is ChunkAccess<L> {
  return (chunk.mask & c.mask) === c.mask;
}

export function createComponent<N extends string, S extends Schema = {}>(
  name: N,
  schema?: S,
): Component<Expand<ComponentLayout<N, S>>> {
  const id = nextComponentId++;
  if (id >= 31) throw new Error("Too many components (max 31)");
  const mask = 1 << id;

  const shape: Schema = schema ?? {};
  const layout: Record<string, FieldType> = {};
  for (const k of Object.keys(shape)) {
    layout[`${name}.${k}`] = shape[k];
  }
  const component = new Component(
    mask,
    layout as Expand<ComponentLayout<N, S>>,
  );

  byId[id] = component;
  byMask.set(mask, component);

  return component;
}

type MergeLayouts<T extends readonly Component[]> = T extends readonly [
  infer H,
  ...infer R,
]
  ? H extends Component<infer L>
    ? R extends readonly Component[]
      ? R extends readonly []
        ? L // последний элемент
        : Expand<L & MergeLayouts<R>> // голова & хвост
      : L
    : never
  : {}; // пустой tuple

export function composeComponent<
  A extends Component,
  B extends Component,
  R extends readonly Component[],
>(a: A, b: B, ...rest: [...R]): Component<MergeLayouts<[A, B, ...R]>> {
  let mask = a.mask | b.mask;
  for (const c of rest) mask |= c.mask;

  const cached = byMask.get(mask);
  if (cached) return cached as Component<MergeLayouts<[A, B, ...R]>>;

  const layout: Record<string, FieldType> = { ...a.layout, ...b.layout };
  for (const c of rest) Object.assign(layout, c.layout);

  const component = new Component(mask, layout as MergeLayouts<[A, B, ...R]>);
  byMask.set(mask, component);
  return component;
}

const DEFAULT_CONFIG: WorldConfig = {
  chunkCount: 512,
  chunkSize: 16 * 1024,
};

export function createWorld(config: Partial<WorldConfig> = {}) {
  return new World({ ...DEFAULT_CONFIG, ...config });
}

export const Position2D = createComponent("Position", { x: "f32", y: "f32" });
export const Scale2D = createComponent("Scale", { x: "f32", y: "f32" });
export const Rotation2D = createComponent("Rotation", { angle: "f32" });

export const Transform2D = composeComponent(Position2D, Rotation2D, Scale2D);
