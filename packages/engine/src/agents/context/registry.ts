/**
 * Scoped registry cho các nguồn system context V2.
 * Registration key là duy nhất; load chạy song song rồi combine theo key ổn định.
 * @module
 */
export * as SystemContextRegistry from "./registry"

import { Context, Effect, Layer, Ref, Scope } from "effect"
import { SystemContext } from "./system"

export interface Entry {
  readonly key: SystemContext.Key
  readonly load: Effect.Effect<SystemContext.SystemContext>
}

export interface Interface {
  readonly register: (entry: Entry) => Effect.Effect<void, never, Scope.Scope>
  readonly load: () => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@phins/v2/SystemContextRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<Entry>>([])

    return Service.of({
      /** Đăng ký theo scope và tự gỡ contribution khi scope đóng. */
      register: Effect.fn("SystemContextRegistry.register")(function* (entry) {
        yield* Effect.acquireRelease(
          Ref.modify(entries, (current) => {
            if (current.some((item) => item.key === entry.key)) return [false, current]
            return [true, [...current, entry]]
          }).pipe(
            Effect.flatMap((added) =>
              added ? Effect.void : Effect.die(`Duplicate system context entry key: ${entry.key}`),
            ),
            Effect.as(entry),
          ),
          (entry) => Ref.update(entries, (current) => current.filter((item) => item !== entry)),
        )
      }),
      /** Load snapshot nguồn theo thứ tự key xác định, nhưng thực thi song song. */
      load: Effect.fn("SystemContextRegistry.load")(function* () {
        const current = (yield* Ref.get(entries)).toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return SystemContext.combine(
          yield* Effect.forEach(current, (entry) => entry.load, { concurrency: "unbounded" }),
        )
      }),
    })
  }),
)
