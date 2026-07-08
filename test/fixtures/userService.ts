/**
 * Fixture module for ts-header extraction tests. Exercises modern TS edge cases.
 */

type Brand<T, B extends string> = T & { readonly __brand: B };

interface Database {
  query(sql: string): Promise<unknown[]>;
}
interface CacheLayer {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
}
interface Config {
  cache?: CacheLayer;
  db: Database;
}

// -- a dense block of exported types --
export type UserId = Brand<string, "UserId">;
export type Role = "admin" | "member" | "guest";
export interface User {
  id: UserId;
  name: string;
  email: string;
  roles: Role[];
}
export interface AuditRecord {
  who: UserId;
  when: Date;
  what: string;
}
export enum Plan {
  Free,
  Pro,
  Enterprise,
}

/**
 * Service for reading and mutating users. Caches aggressively.
 * Second sentence should not appear in brief mode.
 * @remarks not thread-safe
 */
export class UserService {
  private hits = 0;
  readonly createdAt: Date = new Date();

  constructor(private db: Database, private cache?: CacheLayer) {}

  /** Fetches a user by ID, checking cache first. @throws if id malformed */
  async getUser(id: UserId) {
    // inferred return: Promise<User | null>
    const cached = this.cache?.get(id);
    if (cached) return cached as User;
    const rows = await this.db.query(`select * from users`);
    const row = rows[0] as User | undefined;
    return row ?? null;
  }

  /** Applies a partial update and returns the new record. */
  async updateUser(id: UserId, patch: Partial<User>): Promise<User> {
    // inner function inside a method — visible only at depth:"deep"
    function validate(p: Partial<User>): boolean {
      return !("id" in p);
    }
    if (!validate(patch)) throw new Error("cannot change id");
    this.invalidate(id);
    return { ...(await this.getUser(id))!, ...patch };
  }

  /** @deprecated use updateUser instead */
  patch(id: UserId, p: Partial<User>): Promise<User> {
    return this.updateUser(id, p);
  }

  private invalidate(id: UserId): void {
    this.cache?.set(id, undefined);
  }

  get hitCount(): number {
    return this.hits;
  }
}

// overloads
export function parseId(raw: string): UserId;
export function parseId(raw: number): UserId;
export function parseId(raw: string | number): UserId {
  return String(raw) as UserId;
}

/** Factory. Wires cache from cfg.cache if present. */
export function createUserService(cfg: Config) {
  // inferred return: UserService
  const svc = new UserService(cfg.db, cfg.cache);

  // inner arrow-function const — depth:"deep" territory
  const warmup = async (ids: UserId[]) => {
    for (const id of ids) await svc.getUser(id);
  };
  void warmup;
  return svc;
}

// arrow-function const at top level, exported, generic, inferred return
export const chunk = <T,>(items: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// non-exported helper (visible at depth:"all")
function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-");
}
void slugify;

// intentional type error for §7 behavior
export function processOrder(o: Ordr): number {
  return 0;
}

export const MAX_PAGE_SIZE = 100;

// -- framework-style const (regression, design review 2026-07): a large
// `export const x = framework({...})` must NOT be dense-grouped and must
// keep its own L-range annotation, with its rendered type length capped.
type Registered<A, R> = { args: A; run: (a: A) => R };
function endpoint<A, R>(def: { args: A; handler: (args: A) => Promise<R> }): Registered<A, Promise<R>> {
  return { args: def.args, run: (a) => def.handler(a) };
}
export const createBooking = endpoint({
  args: {
    profileId: "" as UserId,
    spotId: "",
    idempotencyKey: "",
    veryLongFieldNameToInflateTheRenderedTypeStringPastTheCapForTesting: 0,
  },
  handler: async (args) => {
    const held = [args.spotId];
    if (held.length === 0) throw new Error("NO_SPOT");
    return { bookingId: args.idempotencyKey, spot: args.spotId, who: args.profileId };
  },
});

// -- multi-line heritage clause (regression: must collapse to one line) --
class Base<P, S> { p!: P; s!: S }
export class Panel extends Base<
  { children: string; fallback?: string },
  { hasError: boolean }
> {
  render(): string { return ""; }
}
