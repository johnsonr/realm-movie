/**
 * No-op decorators used as statically readable schema annotations.
 *
 * `embabel-build-manifest` reads these decorator calls from the TypeScript AST and writes
 * their metadata into `dist/manifest.json`. JavaScript still emits decorator calls, so the
 * compiled realm keeps these tiny local implementations available at runtime as well.
 */

export type UserAnchor = false | { predicate: string; direction?: "from-user" | "to-user" };

export function Node(_spec: {
  description?: string;
  userAnchor?: UserAnchor;
  partial?: boolean;
  internal?: boolean;
} = {}): ClassDecorator {
  return () => undefined;
}

export function Id(): PropertyDecorator {
  return () => undefined;
}

export function Property(_spec: {
  type?: "int" | "number" | "string" | "boolean";
  description?: string;
}): PropertyDecorator {
  return () => undefined;
}

export function Relationship(_spec: {
  type: string;
  producer: string;
  keyField: string;
  recordKeyField: string;
  direction?: "OUTGOING" | "INCOMING";
  description?: string;
}): PropertyDecorator {
  return () => undefined;
}

export function VirtualJoin(_spec: {
  anchorLabel: string;
  relationship: string;
  keyField: string;
  recordKeyField: string;
  producer: string;
  direction?: "FROM_ANCHOR" | "TO_ANCHOR";
  description?: string;
}): ClassDecorator {
  return () => undefined;
}

export function Retrieval(_spec: {
  operation: string;
  nameFrom?: string;
  fieldMap: Record<string, string>;
}): ClassDecorator {
  return () => undefined;
}
