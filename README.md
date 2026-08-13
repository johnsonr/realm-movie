# realm-movie

Movie recommendations for the Embabel assistant — grounded in what the user
has rated, what's actually streamable in their country, and live OMDb
metadata.

This realm is a reimagining of the original
[`movie-finder`](https://github.com/embabel/movie-finder) reference agent as
an Embabel assistant realm. Where `movie-finder` was a standalone Spring Boot
app with hand-coded `@Action` planning, JPA persistence, and its own UI,
this realm ships only the things a realm can ship: APIs, types, a workflow
skill, and a personality. The chat LLM owns the workflow; the assistant
owns the persistence and the UI.

## What's in the realm

| Directory | What it contributes |
|---|---|
| `apis/` | Two OpenAPI 3 specs — OMDb (film metadata) and Streaming Availability (per-country streaming options). Calls go through `gateway.omdb.*` / `gateway.streamingAvailability.*` from `execute_javascript` / `execute_python`. |
| `types/movies.yml` | `Movie` (canonical metadata, keyed by IMDb id) and `MovieRating` (the user's score for a Movie). Read/written via the world repository tools. `MovieRating` declares `userAnchor: { predicate: RATED, direction: from-user }`, so the assistant auto-emits `(User)-[:RATED]->(MovieRating)` on every `create_entry`. |
| `skills/recommend-movie/` | "What should I watch?" / "where can I stream X?" — owns the OMDb + Streaming Availability workflow and the cardinal rules (don't default the country; the response field is `streamingOptions`, not `streamingInfo`). Activates only for the recommend / availability paths. |
| `skills/rate-movie/` | "I just watched X, give it N" — resolves the film on OMDb, then creates or updates the `MovieRating` (keyed by rater + imdbId). Nothing else is persisted: the `RATED` user edge is automatic, and the `(MovieRating)-[:OF]->(Movie)` spine edge is a virtual join (`producers/movie.yml`), materialized on demand from the rating's imdbId. |
| `skills/recall-movies/` | "What did I think of X?" / "what have I rated?" — reads `MovieRating` via `list_entries` for single-title recall, or Cypher for anything cross-cutting. |
| `personalities/roger/` | Ebert-style film-critic voice — used only by the recommend write-up. Rate confirmations and recall replies stay in the default assistant voice. |
| `src/api/movie.ts` | The **`Movie` type** — a TypeScript class `extends Entity`. Its fields are the shape; its async methods (`movie.streaming`, `movie.details`, `movie.rate`, plus inherited `movie.neighbors`) are affordances callable on an in-scope object. Built to `dist/`. See "Type methods" below. |

## Sample queries

Run these in the Cypher console (Settings → Data → **Query**). Each virtual edge materializes on demand and
streams its stages in the console's **Trace** tab. Grouped by cost: instant (Neo4j only), generative (an LLM
call, ~20–40s), web-grounded (LLM + web search, ~30–60s).

> **`WITH … LIMIT` narrows the chain.** A leading `MATCH … WITH x ORDER BY … LIMIT n` bounds the anchor `x`
> to the top-n BEFORE the rest of the query expands off it — and a downstream virtual join (`OF`, `HAS_REVIEW`,
> `SIMILAR_TO`, …) hanging off `x` DOES still materialize, fetching for only those n. This holds whether `x`
> is a real node (a `MovieRating`) or one an upstream virtual join already materialized (a `Movie` from
> `SUGGESTS`). So "top-3 rated films and their reviews" is one query (below). What is NOT supported is pinning
> SEVERAL virtual `Movie` anchors by value at once — `IN`, `UNION`, and variable-pins are rejected; only a
> single literal `{title:'…'}` seeds a `Movie` anchor. Bound with `WITH … LIMIT` (a narrowing), not a value set.

**Instant**
```cypher
-- Your top-rated films
MATCH (me:AssistantUser)-[:RATED]->(r:MovieRating)
RETURN r.title, r.rating ORDER BY r.rating DESC, r.title LIMIT 15
```

**Generative (SIMILAR_TO / fan-IN summary / two-stage SUGGESTS)**
```cypher
-- Recommendations from films you LOVED, best-rated first, excluding what you've seen
MATCH (me:AssistantUser)-[:RATED]->(rt:MovieRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
RETURN DISTINCT m.title, m.year, m.director, m.imdbRating
ORDER BY m.imdbRating DESC LIMIT 15
```
```cypher
-- Your taste in ~100 words (a fan-IN aggregate node over all your ratings)
MATCH (me:AssistantUser)-[:HAS_MOVIE_TASTE_SUMMARY]->(ts:MovieTasteSummary)
RETURN ts.summary, ts.count
```
```cypher
-- Recommendations from your WHOLE taste — a two-stage chain (fan-IN summary → fan-OUT SUGGESTS).
-- This is the TasteBasedRecommendations view.
MATCH (me:AssistantUser)-[:HAS_MOVIE_TASTE_SUMMARY]->(ts:MovieTasteSummary)
MATCH (ts)-[:SUGGESTS]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
RETURN DISTINCT m.title, m.year, m.imdbRating, m.plot,
       'https://www.imdb.com/title/' + m.imdbId + '/' AS imdbUrl
ORDER BY m.imdbRating DESC
```
```cypher
-- Films you'd probably HATE (SIMILAR_TO anchored on your LOW ratings)
MATCH (me:AssistantUser)-[:RATED]->(rt:MovieRating) WHERE rt.rating <= 4
MATCH (rt)-[:SIMILAR_TO]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
RETURN DISTINCT m.title, m.year
```

**Filters + streaming (SIMILAR_TO ∩ AVAILABLE_ON ∩ SUBSCRIBES_TO)**
```cypher
-- French/Italian, pre-1980, under 100 minutes
MATCH (me:AssistantUser)-[:RATED]->(rt:MovieRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
  AND m.year < 1980 AND m.runtimeMinutes < 100
  AND (m.country CONTAINS 'France' OR m.country CONTAINS 'Italy')
RETURN DISTINCT m.title, m.year, m.country, m.runtimeMinutes
```
```cypher
-- Recommendations you can actually STREAM on a service you subscribe to
MATCH (me:AssistantUser)-[:RATED]->(rt:MovieRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
  AND EXISTS { MATCH (m)-[:AVAILABLE_ON]->(s:StreamingService)
               WHERE EXISTS { (me)-[:SUBSCRIBES_TO]->(:UserStreamingSubscription {serviceId: s.serviceId}) } }
RETURN DISTINCT m.title, m.year
```

**Web-grounded reviews (HAS_REVIEW → many MovieReview nodes)**
```cypher
-- Real published reviews of one film — pin the film by title, newest first
MATCH (m:Movie {title:'Stalker'})-[:HAS_REVIEW]->(r:MovieReview)
RETURN r.publication, r.reviewDate, r.sentiment, r.originalScore, r.verdict, r.url
ORDER BY r.reviewDate DESC
```
```cypher
-- Your top-3 rated films AND their reviews, in ONE query. `rt` is a real MovieRating, so the WITH…LIMIT
-- narrows it to your 3 highest ratings; OF then fetches each film (by imdbId) and HAS_REVIEW its reviews —
-- both bounded to those 3, never your whole rated library. (rt)-[:OF]->(m) is the canonical spine hop.
MATCH (me:AssistantUser)-[:RATED]->(rt:MovieRating)
WITH rt ORDER BY rt.rating DESC LIMIT 3
MATCH (rt)-[:OF]->(m:Movie)-[:HAS_REVIEW]->(r:MovieReview)
RETURN m.title, r.publication, r.originalScore, r.verdict, r.url
ORDER BY m.title, r.reviewDate DESC
```

**LLM-judged (the `ai` namespace — per-row judgment a property can't express)**

The reserved `ai` namespace invokes a per-row LLM call over rows a virtual join has already fetched, for a
subjective discriminator no stored property or embedding captures. An `{ai: {…}}` directive map on a
generative edge *steers and tunes* what it produces (`hint`, plus `model` — a world role like
`chat_cheap` — `temperature`, `confidence`, `fresh`); `ai.score(n, '…')` *reranks* by fit;
`ai.relevant(n, '…')` *filters* to matching rows. `ai` is never a stored property. An `{realm: {…}}` map
carries THIS realm's own prompt parameters (see below).

```cypher
-- Recommendations from films you LOVED — but lean arthouse and slow-burn, generated by a cheap model
-- and only picks it's confident in. The ai block is a SOFT STEER + per-query tuning on the generative
-- SIMILAR_TO edge: it colours what gets suggested, it is NOT a filter, so it must NOT also appear in a
-- WHERE. The imdbRating / NOT-EXISTS below are the real filters.
MATCH (me:AssistantUser)-[:RATED]->(rt:MovieRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO {ai: {hint: 'lean arthouse and slow-burn — contemplative, unhurried, character over plot',
                              model: 'chat_cheap', confidence: 0.7}}]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
RETURN DISTINCT m.title, m.year, m.director, m.imdbRating
ORDER BY m.imdbRating DESC LIMIT 15
```
```cypher
-- THIS realm's own prompt parameter, via the open {realm: {…}} namespace: both generative prompts
-- opt into an `era` steer ({% if era %} … {{ era }} in producers/movie.yml). The engine carries
-- any realm key verbatim; only keys the realm's prompt references have an effect.
MATCH (me:AssistantUser)-[:HAS_MOVIE_TASTE_SUMMARY]->(ts:MovieTasteSummary)
MATCH (ts)-[:SUGGESTS {realm: {era: 'the 1970s'}}]->(m:Movie)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
RETURN DISTINCT m.title, m.year, m.director LIMIT 10
```
```cypher
-- The best-WRITTEN reviews of one film, not the highest-scored — a subjective sort no column holds.
-- ai.score reranks the fetched HAS_REVIEW rows by the LLM's read of writing quality; LIMIT takes the top few.
MATCH (m:Movie {title:'Stalker'})-[:HAS_REVIEW]->(r:MovieReview)
RETURN r.publication, r.verdict, r.originalScore, r.url
ORDER BY ai.score(r, 'the most eloquent, beautifully written film criticism') DESC LIMIT 5
```
```cypher
-- Reviews of one film that specifically praise its cinematography — a criterion sentiment/score can't encode.
-- ai.relevant keeps only the fetched MovieReview rows the LLM judges on-criterion; compose more with AND.
MATCH (m:Movie {title:'Stalker'})-[:HAS_REVIEW]->(r:MovieReview)
WHERE ai.relevant(r, 'the review specifically praises the film''s cinematography or visual style')
RETURN r.publication, r.verdict, r.originalScore, r.url
ORDER BY r.reviewDate DESC
```

You can also click **Run** on the saved views in the console's **Views** tab: `MyFilmTaste`,
`StreamableRecommendations`, `NoirRecommendations`, `MoviesYoullProbablyHate`, `TasteBasedRecommendations`,
`NewReleases` (web-searched new releases matching your taste), and the multi-person views
`RatingsByRater`, `MutualFavourites`, `DividedOpinions`.
`MoviesLike` needs its film named, so run it as a query: `MATCH (m:MoviesLike {movie: 'Heat'}) RETURN m`
— similars to any film you name (rated or not), excluding everything you've already rated.

## Multi-person taste

A `MovieRating` is attributed to a **person** — the current user *or* any contact — via
`(Person)-[:RATED]->(MovieRating)`, and the rating carries `raterName`/`raterId`. Your own node
(`AssistantUser`) is also a `Person`, so one uniform edge covers everyone and you can compare tastes across
people. (`MutualFavourites` / `RatingsByRater` / `DividedOpinions` are the saved forms of these.)

```cypher
-- Films you and one named person both love
MATCH (me:AssistantUser)-[:RATED]->(rm:MovieRating)              WHERE rm.rating >= 8
MATCH (other:Person)-[:RATED]->(ro:MovieRating)
  WHERE other <> me AND other.name = 'Lynda M Coker'
    AND ro.rating >= 8 AND ro.imdbId = rm.imdbId
RETURN rm.title AS Film, rm.rating AS Mine, ro.rating AS Theirs ORDER BY Film
```
```cypher
-- Whom do you share taste with? (data-only, no LLM)
MATCH (me:AssistantUser)-[:RATED]->(rm:MovieRating)  WHERE rm.rating >= 8
MATCH (other:Person)-[:RATED]->(ro:MovieRating)
  WHERE other <> me AND ro.rating >= 8 AND ro.imdbId = rm.imdbId
RETURN other.name AS With, collect(rm.title) AS FilmsYouBothLove, count(*) AS Overlap
ORDER BY Overlap DESC
```
```cypher
-- SHARED recommendations — films that appeal to BOTH, new to both. Two SIMILAR_TO fan-outs that intersect;
-- this now works because a generative pick can name every anchor it resembles (sourceIndexes). ~1–2 min.
MATCH (me:AssistantUser)-[:RATED]->(rm:MovieRating) WHERE rm.rating >= 8
MATCH (rm)-[:SIMILAR_TO]->(m:Movie)
MATCH (other:Person)-[:RATED]->(ro:MovieRating) WHERE other.name = 'Lynda M Coker' AND ro.rating >= 8
MATCH (ro)-[:SIMILAR_TO]->(m)
WHERE NOT EXISTS { (s:MovieRating) WHERE s.imdbId = m.imdbId }
RETURN DISTINCT m.title, m.year, m.director LIMIT 20
```

Recording a rating for another person is a **seeding** operation today — `create_entry` only auto-anchors the
current user (its `relations` are outgoing-only), so a contact's ratings are added by Cypher, not chat.

### Top 3 films with reviews

"My top 3 rated films, each with its reviews" is a single Cypher query — the last example above. The `OF` edge
`(MovieRating)-[:OF]->(Movie)` bridges a rating to its film, so a `WITH rt ORDER BY rt.rating DESC LIMIT 3`
narrows to your 3 top ratings and both downstream hops (`OF`, then the per-film web-search `HAS_REVIEW`) fetch
for only those three. Three web searches → give it a minute or two.

The **`Top 3 — Reviews`** lens (`lenses/top-reviews.yml`) remains as a saved, click-to-run form of the same
result (it pins each of the 3 titles individually); the single query above is the general pattern.

## Why no MovieBuff entity?

The original `movie-finder` kept a `MovieBuff` JPA entity carrying the
user's country code, hobbies, preferred streaming services, "movie likes /
dislikes", and free-form `about` text. None of that is redeclared here.
The assistant already extracts and stores user-profile facts via the DICE
proposition pipeline ("user lives in AU", "user uses Netflix and Stan",
"user likes Tarantino") — re-modelling them as a parallel `MovieBuff`
entity would just create a second source of truth that drifts from the
proposition graph. The skill recalls those facts the same way it recalls
anything else about the user.

## Required environment variables

The assistant process needs both API keys set as environment variables:

```bash
export OMDB_API_KEY=<from https://www.omdbapi.com/apikey.aspx>
export X_RAPIDAPI_KEY=<from https://rapidapi.com/movie-of-the-night-movie-of-the-night-default/api/streaming-availability/>
```

Both keys are deployment-level (one OMDb account, one RapidAPI account),
not per-user OAuth. End users do not need to authorize anything.

## Installation

Install via the assistant's realm manager. On install the realm contributes:

- `gateway.omdb.*` and `gateway.streamingAvailability.*` tool surfaces
  (visible inside `execute_javascript` / `execute_python`).
- The `Movie` and `MovieRating` types, surfaced through the world
  repository tools (`describe`, `list_entries`, `create_entry`,
  `update_entry`, `delete_entry`).
- The three skills above, activated by the chat LLM by name match against
  user phrasing.
- The `roger` personality, available to `recommend-movie` write-ups.

Ratings persist into the world graph store via
`NamedEntityDataRepository`. `create_entry` for a `MovieRating` lands the
implicit `RATED` edge to the User; the `(MovieRating)-[:OF]->(Movie)` spine
edge is a virtual join (materialized on demand by imdbId, `producers/movie.yml`),
so the rating carries only imdbId + title at rest and the film is fetched when
a query traverses `OF`. The schema projector exposes both edges to the Cypher
tool and the DICE proposition pipeline.

## Type methods (TypeScript)

`Movie` is authored in TypeScript as a **class that `extends Entity`** under
`src/api/` — not declared in YAML. Its fields are the shape and its async methods
are affordances callable on an in-scope object: `movie.streaming({ country })`,
not a bare `gateway.movie.streaming(...)`. See
[`specs/PACK_TYPES.md`](../assistant/specs/PACK_TYPES.md) in the assistant repo
for the full model and [`specs/PACK_COMPILER.md`](../assistant/specs/PACK_COMPILER.md)
for the build pipeline.

**Authoring.** One class per type, in `src/api/<namespace>.ts` (the filename is
the namespace — `movie.ts` → `movie`). There is no `ctx`/`self` plumbing: `this`
is the object, `this.gateway` is the context. Each method's JSDoc first paragraph
becomes the LLM-facing description; its single `args` parameter and return type
become the input/output JSON Schema.

```ts
import { Entity } from "@embabel/runtime-types";

// Data shapes the methods read/write, declared alongside the type that uses them.
interface StreamingShow { streamingOptions?: Record<string, unknown[]> }
interface RatingEntry { id: string }
interface MovieRating { imdbId: string; title?: string; rating: number; notes?: string; watchedOn?: string }

// The gateway ops this type calls, typed. Until `embabel-realm sync` generates the
// host's `GatewayContext`, the realm types the slice it uses and reads it through
// `this.api`, so bodies and return types are fully typed — no `unknown`.
interface MovieGateway {
  streamingAvailability: { getShow(args: { id: string; country: string }): Promise<StreamingShow> };
  repository: { createEntry(args: { type: string; data: MovieRating }): Promise<RatingEntry> };
}

export class Movie extends Entity {
  imdbId!: string;
  title?: string;

  private get api(): MovieGateway {
    return this.gateway as unknown as MovieGateway;
  }

  /** Where this movie is streaming in a country (ISO-3166 alpha-2, lowercase). */
  async streaming(args: { country: string }): Promise<StreamingShow> {
    return this.api.streamingAvailability.getShow({ id: this.imdbId, country: args.country });
  }

  /** Record the user's rating (1–10); createEntry auto-emits (User)-[:RATED]->(MovieRating). */
  async rate(args: { rating: number; notes?: string; watchedOn?: string }): Promise<RatingEntry> {
    const data: MovieRating = { imdbId: this.imdbId, title: this.title, ...args };
    return this.api.repository.createEntry({ type: "MovieRating", data });
  }
}
```

Extending `Entity` also gives `movie.neighbors({ hops })` for free — graph
navigation (typed `NeighborNode[]`) with no per-type code. The whole type — its
fields, methods, result shapes (`StreamingShow`, `OmdbMovie`, `RatingEntry`), and
the `MovieRating` record it writes — lives in the single file `src/api/movie.ts`.

**Where it runs.** A method body runs **in the realm sandbox**; the gateway ops it
calls (`this.gateway.streamingAvailability.*`, `this.gateway.omdb.*`,
`this.gateway.repository.*`) route back through the **server**, which holds the
API keys and makes the external call. Convenience/composition is local; every
credentialed call is server-mediated.

**Testing.** `entityForTest` builds a real instance with its fields set and a
mock gateway injected — the same shape the host uses — so a method is tested in
milliseconds with no live server:

```ts
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { Movie } from "../src/api/movie";

const movie = entityForTest(
  Movie,
  { imdbId: "tt0114367" },
  mockGateway<GenericGatewayContext>({ streamingAvailability: { getShow } }),
);
await movie.streaming({ country: "us" });
expect(getShow).toHaveBeenCalledWith({ id: "tt0114367", country: "us" });
```

**Build.**

```bash
npm install          # links @embabel/runtime-types (file: dep) + typescript + vitest
npm run build        # tsc -> dist/, vendor runtime, embabel-build-manifest -> dist/manifest.json
npm test             # vitest — methods tested against a mocked gateway
npm run typecheck    # tsc --noEmit
```

`npm run build` produces:

- `dist/api/movie.js` — the compiled CommonJS `Movie` class (seeded into the
  sandbox at `/world/realm-handlers/realm-movie/` and `require()`d there).
- `dist/node_modules/@embabel/runtime-types/` — the vendored CommonJS base class,
  so the seeded handler can `require("@embabel/runtime-types")` for `Entity`
  without a global install.
- `dist/manifest.json` — one entry per method, each carrying `onType: "Movie"`
  and `className: "Movie"`, read by the assistant's `PackHandlerLoader`.

The world install step (`WorldBootstrap`) runs `npm install && npm run
build` automatically when the realm is cloned, so `dist/` is regenerated on
install. `dist/` is gitignored.

**Adding a method:** add an `async` method to the `Movie` class in
`src/api/movie.ts`, add a test in `tests/`, run `npm run build`. Done — no
Kotlin, no YAML.
