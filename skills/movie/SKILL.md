---
name: movie
description: Films — facts (this realm's OMDb source is authoritative, NOT web search), recommendations, streaming availability, and ratings. Activate for ANY movie request; it returns the methods and rules to follow.
---

# Movies

One skill for everything film-related. The realm ships two APIs (`omdb`,
`streaming_availability`), the `Movie` and `MovieRating` world types, and the
`roger` personality (Roger-Ebert voice for write-ups).

All API calls go through `gateway.<ns>.<method>(args)` from inside
`execute_javascript` — never as top-level tools.

| Surface | Shape |
|---|---|
| `gateway.omdb.getMovie(args)` | Pass exactly ONE of `i` (IMDb id, cheapest), `t` (exact title), `s` (search term). |
| `gateway.streamingAvailability.getShow({ id, country })` | `id` is the IMDb id (with `tt`). `searchShowsByTitle({ country, title })` when you don't have an id. |
| `gateway.kg.query({ cypher, params })` | Read world entries — there is NO `listEntries`. Reads go through the graph via Cypher; `gateway.repository` is create / update / delete + `describe` only. |
| `gateway.repository.createEntry({ type, data, relations })` | Create/merge an entry (MERGEs on the identity key). |

## Look up a film — "tell me about X", plot, cast, director, year, runtime

This is the default for any factual question about a specific film.

```js
const omdb = await gateway.omdb.getMovie({ t: "Jade" });  // or { i: "tt0112443" } if you have the id
if (!omdb || omdb.Response === "False") {
  // OMDb returns HTTP 200 even on a miss — check Response, read omdb.Error.
  return `OMDb has no film matching that title — ask the user to confirm it.`;
}
// Answer from the structured record: omdb.Title, .Year, .Genre, .Director,
// .Actors, .Plot, .Runtime, .imdbID, .Ratings. This is authoritative for film
// facts — prefer it over web search.
```

Calling `gateway.omdb.getMovie` also **auto-binds the film as a `Movie` in your
working state** (you'll see it in the `## State` block, e.g. `jade: Movie`), so
follow-ups ("how long is it", "where can I stream it") can act on the in-scope
object instead of looking it up again. Only fall back to web search if OMDb
genuinely lacks a detail the user asked for.

## "What should I watch?" — a recommendation

1. **Exclude what they've seen:** read their ratings via Cypher —
   `gateway.kg.query` over `(me:AssistantUser)-[:RATED]->(r:MovieRating)-[:OF]->(m:Movie)`,
   read `imdbId`/`rating`. Empty is fine.
2. **Honour preferences** from the user's profile (directors, genres, mood in your
   context). If vague ("something good"), ask ONE clarifying question first.
3. **Generate 5–8 candidates** in your head, not already rated.
4. **Verify each via OMDb** (`getMovie({ s })` → pick `imdbID` → `getMovie({ i })`).
   Drop any OMDb can't find — likely a hallucination.
5. **Filter by streaming** (see below); prefer the user's known services.
6. **Write up the top 3** in the `roger` voice — one image-led paragraph each,
   markdown link to the streaming option.

## "Where can I stream X?"

1. **NEVER default the country — ASK.** It's in the user's profile/context as
   `country: <code>`. If you can't see one, reply `"Which country are you in? I
   need it to check streaming."` and STOP.
2. **If the film is ALREADY in scope** (a `Movie` variable in your `## State`
   block, e.g. `jade: Movie`), call its method — do NOT re-fetch and do NOT use
   memory or web:
   ```js
   const m = state.get('jade');           // the in-scope Movie variable
   const r = await m.streaming({ country: 'au' });
   ```
   Otherwise resolve the IMDb id via OMDb, then
   `const r = await gateway.streamingAvailability.getShow({ id, country });`.
3. The field is **`streamingOptions`**, not `streamingInfo`:
   `r.streamingOptions[country]` is an array of `{ service, type, link, ... }`.
   `console.log(JSON.stringify(r, null, 2))` if unsure.
4. Render as a short markdown list grouped by `type` (subscription / free / rent /
   buy), each a link to the option's `link`. Don't drop rent/buy — list them after.
5. **If the call errors, SAY the tool failed — never substitute web search or
   "memory" and never invent services/links.**

## Asking the user to choose — `choices` payloads

Whenever a flow needs the user to pick from a small closed set (a score, one of
several matching films), do NOT guess, do NOT pick silently, and do NOT bury the
options in prose. Instead the script RETURNS a `choices` payload as its result,
and you then present the question and options to the user and STOP — take no
recording/lookup action until they pick. The structured result lets a client
that can render forms show one; everywhere else, present the options as a short
list. The payload shape:

```json
{"kind": "choices",
 "question": "<one short question>",
 "options": ["<option>", "..."],
 "context": { "<ids the follow-up turn needs>": "..." },
 "hint": "Present these options to the user and wait for their pick."}
```

Carry the ids the next turn needs in `context` so you never re-resolve.

### Film named, NO score yet — "Rate Heat for me", "I watched Heat last night"

Resolve the film via OMDb first (disambiguates and yields the imdbId), then
return the choices payload and wait:

```js
const userTitle = "Heat";
const omdb = await gateway.omdb.getMovie({ t: userTitle });
if (!omdb || omdb.Response === "False") return `No film matching "${userTitle}" on OMDb — confirm the title.`;
return JSON.stringify({
  kind: "choices",
  question: `How would you rate ${omdb.Title} (${omdb.Year})?`,
  options: ["1","2","3","4","5","6","7","8","9","10"],
  context: { imdbId: omdb.imdbID, title: omdb.Title },
  hint: "Present these options to the user and wait for their pick, then record the rating.",
});
```

When the user answers with a score, record it with the rating script below —
but use `context.imdbId` / `context.title` from the payload and SKIP the OMDb
re-lookup.

### Several films match — "Crash", "The Getaway"

When an OMDb search (`getMovie({ s })`) returns more than one plausible match
and the user's words don't settle it (year, director, "the newer one"):

```js
const results = await gateway.omdb.getMovie({ s: "Crash" });
const hits = (results.Search || []).filter((h) => h.Type === "movie").slice(0, 5);
if (hits.length > 1) return JSON.stringify({
  kind: "choices",
  question: `Which "Crash" do you mean?`,
  options: hits.map((h) => `${h.Title} (${h.Year})`),
  context: { candidates: hits.map((h) => ({ imdbId: h.imdbID, title: h.Title, year: h.Year })) },
  hint: "Present these options to the user and wait for their pick, then continue with that film's imdbId.",
});
```

Then continue the original request (lookup, rating, streaming) with the chosen
candidate's `imdbId` from `context`.

## "I gave X an 8" — record a rating

A rating belongs to a PERSON. For the current user, resolve their own id and build the
rater-inclusive identity key. Run as one `execute_javascript` and reply with **exactly the
string it returns**. (If the user named a film but gave NO score, do not run this yet —
see "Asking the user to choose" above.)

```js
const userTitle = "The Matrix", rating = 9;   // whole number 1–10
const omdb = await gateway.omdb.getMovie({ t: userTitle });
if (!omdb || omdb.Response === "False") return `No film matching "${userTitle}" on OMDb — confirm the title.`;
const imdbId = omdb.imdbID, title = omdb.Title;
// The rater is the current user (also a Person node). ratingKey = "<myId>::<imdbId>".
const meRows = await gateway.kg.query({ cypher: "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1", params: JSON.stringify({}) });
const me = ((meRows && meRows.rows) ? meRows.rows[0] : (meRows && meRows[0])) || {};
await gateway.repository.createEntry({ type: "MovieRating",
  data: { ratingKey: `${me.id}::${imdbId}`, raterId: me.id, raterName: me.name, imdbId, title, rating } });
return `Saved ${title} (${imdbId}) — ${rating}/10.`;
```

Ratings are whole numbers 1–10 (round a half and confirm). The `(me)-[:RATED]->(MovieRating)`
edge is added automatically for the current user — don't add it. Do NOT persist a `Movie`
node or an `OF` edge: the rating stores only `imdbId`/`title`, and the
`(MovieRating)-[:OF]->(Movie)` spine hop is a VIRTUAL join — the film's full metadata is
fetched from OMDb by `imdbId` whenever a query traverses `OF` (same write shape as the
`movie.rate()` card widget).

**Recording a rating for SOMEONE ELSE** ("Lynda gave Barry Lyndon a 9"): the data model
supports it — `MovieRating` carries `raterId`/`raterName` and hangs off any `Person` by
`(Person)-[:RATED]->(rating)`, so cross-person views like `MutualFavourites` already work.
But `create_entry` only auto-anchors the CURRENT user (and its `relations` create outgoing
edges only), so it can't yet build the `(otherPerson)-[:RATED]->` edge. Until the host adds
an anchor-on-person path, attributing a rating to another person is a **seeding** operation,
not a chat one — tell the user that plainly rather than recording it under their own name.

## "What have I rated?" / "What did I think of X?"

Read via Cypher — `gateway.kg.query` over
`(me:AssistantUser)-[:RATED]->(r:MovieRating)-[:OF]->(m:Movie)` — optionally filter by
title substring or `imdbId`. Report the score and quote any `notes` verbatim.
If nothing matches, say so plainly — never invent a rating. For cross-cuts
(highest-rated noirs, rated-above-8-and-streaming), use the Cypher tool; the
canonical shape is `(User {id:$userId})-[:RATED]->(r:MovieRating)-[:OF]->(m:Movie)`.

## "Save this for later" / "What films do I want to see?"

The watchlist is graph-backed, never local or conversational state:
`(me:AssistantUser)-[:WANTS_TO_SEE]->(w:MovieWatchlistEntry)`. Resolve the film through
OMDb, read the current user's id, then create/merge the stable per-user entry:

```js
const film = await gateway.omdb.getMovie({ t: "The Big Sleep" });
const meResult = await gateway.kg.query({
  cypher: "MATCH (me:AssistantUser) RETURN me.id AS id LIMIT 1", params: "{}"
});
const me = ((meResult && meResult.rows) || meResult || [])[0] || {};
await gateway.repository.createEntry({ type: "MovieWatchlistEntry", data: {
  watchlistKey: `${me.id}::${film.imdbID}`, userId: me.id,
  imdbId: film.imdbID, title: film.Title, year: Number(film.Year),
  director: film.Director, genre: film.Genre, poster: film.Poster, plot: film.Plot,
  addedOn: new Date().toISOString()
}});
```

List it with a stored-data query (no API call needed):

```cypher
MATCH (me:AssistantUser)-[:WANTS_TO_SEE]->(w:MovieWatchlistEntry)
RETURN w ORDER BY w.addedOn DESC
```

## Always

- **Never fabricate** an IMDb id, rating, or streaming claim — each comes from a
  real OMDb / Streaming Availability call.
- `omdb`'s `i`/`t`/`s` are mutually exclusive — pass exactly one.
- Use the `roger` voice only for recommendation write-ups; stay in the default
  voice for facts, status, and clarifications.
