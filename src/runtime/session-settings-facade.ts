const SUPPRESSED_SETTERS = new Set<PropertyKey>([
  "setDefaultProvider",
  "setDefaultModel",
  "setDefaultModelAndProvider",
  "setDefaultThinkingLevel",
]);

/**
 * Keep Pi's session-local model/thinking behavior while preventing its normal
 * persistence hooks from competing with global Agent runtime defaults.
 */
export function createSessionSettingsFacade<T extends object>(settings: T): T {
  const boundMethods = new Map<PropertyKey, { source: Function; bound: Function }>();
  const noops = new Map<PropertyKey, () => void>();

  return new Proxy(settings, {
    get(target, property) {
      if (SUPPRESSED_SETTERS.has(property)) {
        let noop = noops.get(property);
        if (!noop) {
          noop = () => {};
          noops.set(property, noop);
        }
        return noop;
      }

      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const cached = boundMethods.get(property);
      if (cached?.source === value) return cached.bound;
      const bound = value.bind(target) as Function;
      boundMethods.set(property, { source: value, bound });
      return bound;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}
