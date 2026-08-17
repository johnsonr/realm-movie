const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const builder = join(
  process.cwd(),
  "node_modules",
  "@embabel",
  "runtime-types",
  "dist",
  "build-manifest.js",
);
const builderSource = readFileSync(builder, "utf8");

// Older local builds of runtime-types emitted handler methods but silently omitted every
// @Node declaration and virtual join. Refuse to replace a valid realm manifest with that
// incomplete shape.
if (!builderSource.includes("function extractType") || !builderSource.includes("attachVirtualJoins")) {
  throw new Error(
    "@embabel/runtime-types manifest builder is stale and cannot emit realm types. " +
      "Rebuild that package before building realm-movie.",
  );
}

const result = spawnSync(process.execPath, [builder], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const manifest = JSON.parse(readFileSync(join(process.cwd(), "dist", "manifest.json"), "utf8"));
const types = new Map((manifest.types || []).map((type) => [type.name, type]));
const requiredTypes = [
  "Movie",
  "MovieRating",
  "MovieReview",
  "MovieTasteSummary",
  "MovieWatchlistEntry",
  "StreamingService",
  "UserStreamingSubscription",
];
for (const name of requiredTypes) {
  if (!types.has(name)) throw new Error(`Generated realm manifest is missing type ${name}`);
}

const relationships = [...types.values()].flatMap((type) =>
  (type.virtualJoins || []).map((join) => join.relationship),
);
for (const relationship of ["HAS_MOVIE_TASTE_SUMMARY", "OF"]) {
  if (!relationships.includes(relationship)) {
    throw new Error(`Generated realm manifest is missing relationship ${relationship}`);
  }
}
if (types.get("MovieWatchlistEntry")?.spec?.userAnchor?.predicate !== "WANTS_TO_SEE") {
  throw new Error("Generated realm manifest is missing the WANTS_TO_SEE user relationship");
}

