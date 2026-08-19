import { Entity } from "@embabel/runtime-types";
// Schema metadata is read off the AST by `embabel-build-manifest`. The local implementations
// are intentional no-ops when the compiled realm module is loaded.
import {
  Id, Node, Property, Relationship, Retrieval, VirtualJoin,
} from "./schema-decorators";

// ─── Data shapes ────────────────────────────────────────────────────────────
// Plain records the methods read or write. They have no behaviour and are not nodes, so
// they stay interfaces. The NODE types are the decorated classes further down.

/**
 * The slice `Movie.rate` writes when creating a rating. Distinct from the {@link MovieRating}
 * node type below: this is an input record, that is a graph node with identity and edges.
 */
export interface MovieRatingInput {
  /** Identity key — `<raterId>::<imdbId>`, so two people rating the same film are distinct rows. */
  ratingKey: string;
  /** The rater's Person id (the current user's id for their own ratings). */
  raterId: string;
  /** The rater's display name, denormalised for cheap recall. */
  raterName?: string;
  /** IMDb id of the rated Movie (same value as Movie.imdbId) — a property, not the identity by itself. */
  imdbId: string;
  /** Title, denormalised for cheap recall without a join. */
  title?: string;
  /** Score from 1 (terrible) to 10 (masterpiece). Whole numbers only. */
  rating: number;
  /** Optional one-line reaction in the rater's own words. */
  notes?: string;
  /** Optional ISO-8601 date the movie was watched. */
  watchedOn?: string;
}

/** The persisted per-user record behind the "Want to See" list. */
export interface MovieWatchlistInput {
  /** Identity key — `<userId>::<imdbId>`, so saving twice updates one entry. */
  watchlistKey: string;
  /** Current user's graph id. */
  userId: string;
  /** IMDb id of the saved Movie. */
  imdbId: string;
  /** Film metadata denormalised so listing the watchlist is an immediate stored-data read. */
  title: string;
  year?: number;
  director?: string;
  genre?: string;
  poster?: string;
  plot?: string;
  /** ISO-8601 timestamp when the film was most recently saved. */
  addedOn: string;
}

/** The current user's country for streaming availability lookups. */
export interface MovieStreamingPreferencesInput {
  /** Current user's graph id; one stable preferences record per user. */
  userId: string;
  /** ISO-3166 alpha-2 country code, lowercase (for example `au` or `us`). */
  countryCode: string;
  /** Display name retained for immediate UI and conversational recall. */
  countryName: string;
  /** ISO-8601 timestamp of the most recent change. */
  updatedAt: string;
}

/** The current user's identity, read from the scoped graph to attribute their own ratings. */
export interface CurrentUser {
  id?: string;
  name?: string;
}

/** One way to watch a title, as returned per country by Streaming Availability. */
export interface StreamingOption {
  service?: { id?: string; name?: string };
  /** `subscription` | `rent` | `buy` | `free` | `addon`. */
  type?: string;
  /** Deep link to the title on the service. */
  link?: string;
  /** Trailer URL, when the service provides one. */
  videoLink?: string;
}

/** A Streaming Availability "show" record — the slice the pack reads. */
export interface StreamingShow {
  imdbId?: string;
  title?: string;
  /** Streaming options keyed by ISO-3166 alpha-2 country code (e.g. `us`, `au`). */
  streamingOptions?: Record<string, StreamingOption[]>;
}

/** An OMDb movie record. OMDb returns Title-cased keys; this is the slice the pack reads. */
export interface OmdbMovie {
  Title?: string;
  Year?: string;
  Rated?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Plot?: string;
  Poster?: string;
  imdbRating?: string;
  imdbID?: string;
}

/** What the workspace repository returns when a MovieRating is created or updated. */
export interface RatingEntry {
  id: string;
}

/**
 * The gateway ops `Movie` calls, typed. Until the host's fully-typed `GatewayContext` is
 * generated, a realm types the slice it uses itself and reads it through {@link Movie.api},
 * so method bodies and return types are fully typed (no `unknown`).
 */
interface MovieGateway {
  streamingAvailability: { getShow(args: { id: string; country: string }): Promise<StreamingShow> };
  omdb: { getMovie(args: { i: string; plot: string }): Promise<OmdbMovie> };
  repository: {
    createEntry(args: { type: string; data: MovieRatingInput | MovieWatchlistInput }): Promise<RatingEntry>;
  };
  kg: { query(args: { cypher: string; params: string }): Promise<{ rows?: CurrentUser[] } | CurrentUser[]> };
}

// ─── The node types ─────────────────────────────────────────────────────────
// Schema and behaviour together, in one language, checked by one compiler. Previously the
// schema half lived in `types/movies.yml` and nothing verified that a producer, an anchor
// or a target type actually existed until the world loaded and warned.

/**
 * A film, keyed by IMDb id. The canonical metadata record the assistant references when
 * discussing a movie; created on first OMDb lookup and re-used for every subsequent rating,
 * recommendation, or recall.
 *
 * No stored `imdbUrl`: OMDb doesn't return one, but it is derivable from the id in a query —
 * `'https://www.imdb.com/title/' + m.imdbId + '/' AS imdbUrl`.
 */
@Node({
  // Shared reference metadata, NOT user-owned. A film isn't "owned" by a user — the user's
  // relationship to it is the rating. Without this, `Movie` falls to the framework default
  // (`OWNED_BY` from-entry) and every film wrongly gets `(Movie)-[:OWNED_BY]->(User)`,
  // double-anchoring it alongside the rating. `false` makes `MovieRating` the SOLE bridge:
  //   (User)-[:RATED]->(MovieRating)-[:OF]->(Movie)
  userAnchor: false,
})
// When the LLM looks a film up via OMDb, auto-bind the result as a Movie in working state
// (named after a slug of the title, e.g. 'jade') so it's in scope for follow-ups — no
// explicit save needed. fieldMap maps the OMDb response (Title/imdbID-cased) onto the
// Movie's own field names.
@Retrieval({
  operation: "omdb.getMovie",
  nameFrom: "title",
  fieldMap: {
    imdbId: "imdbID",
    title: "Title",
    year: "Year",
    genre: "Genre",
    country: "Country",
    director: "Director",
    runtimeMinutes: "Runtime",
    plot: "Plot",
    imdbRating: "imdbRating",
    imdbVotes: "imdbVotes",
    poster: "Poster",
  },
})
export class Movie extends Entity {
  /**
   * IMDb id, e.g. 'tt0110912' for Pulp Fiction. The identity key — the store MERGEs on it
   * (deterministic, world-scoped id), so the same film is one Movie node however many
   * times it's referenced.
   */
  @Id() declare imdbId: string;

  /** Display title, e.g. 'Pulp Fiction'. */
  declare title: string;

  /** Release year, e.g. 1994. `int` so queries can range/order on it; OMDb's string is coerced. */
  @Property({ type: "int" }) declare year: number;

  /** Comma-separated genres as returned by OMDb, e.g. 'Crime, Drama'. */
  declare genre: string;

  /**
   * Comma-separated production countries from OMDb, e.g. 'France, Italy'. Use CONTAINS to
   * filter (a film can list several).
   */
  declare country: string;

  /** Primary director(s) as returned by OMDb. */
  declare director: string;

  /**
   * Runtime in minutes, e.g. 175. `int` so `WHERE m.runtimeMinutes > 120` works; OMDb
   * returns 'NNN min' and the host coerces it to the number on materialization.
   */
  @Property({ type: "int" }) declare runtimeMinutes: number;

  /** One-paragraph plot summary from OMDb. */
  declare plot: string;

  /**
   * IMDb rating 0–10, e.g. 7.8. OMDb returns it as a string; `number` so it's coerced and
   * you can ORDER BY / filter on it.
   */
  @Property({ type: "number" }) declare imdbRating: number;

  /**
   * Number of IMDb votes, e.g. 1234567 — a popularity proxy. OMDb returns a digit-grouped
   * string ('1,234,567'); `int` so it's coerced and you can ORDER BY / filter on it.
   */
  @Property({ type: "int" }) declare imdbVotes: number;

  /** URL of the film's poster image from OMDb (or 'N/A' when it has none). */
  declare poster: string;

  /**
   * Streaming services where this Movie can be watched in the user's country. Only films
   * with at least one option appear, so a plain MATCH filters recommendations to what the
   * user can stream. The EDGE carries the per-film option details (producer `edgeProject`):
   * `watchLink` (deep link to THIS film on the service) and `offerType` (subscription /
   * free / rent / buy) — read them off the relationship:
   * `MATCH (m)-[ao:AVAILABLE_ON]->(s) RETURN ao.watchLink, ao.offerType`.
   */
  @Relationship({
    type: "AVAILABLE_ON", producer: "streamingByImdb",
    keyField: "imdbId", recordKeyField: "imdbId",
    description:
      "Streaming services where this Movie can be watched in the user's country. Only films with at " +
      "least one option appear, so a plain MATCH filters recommendations to what the user can stream. " +
      "The EDGE carries the per-film option details (producer edgeProject): `watchLink` (deep link to " +
      "THIS film on the service) and `offerType` (subscription / free / rent / buy) — read them off " +
      "the relationship: MATCH (m)-[ao:AVAILABLE_ON]->(s) RETURN ao.watchLink, ao.offerType.",
  })
  declare availableOn: StreamingService[];

  /**
   * Individual web-found reviews of this film. Many per film, each keyed by its url.
   * A two-stage chain works: `(rt)-[:SIMILAR_TO]->(m:Movie)-[:HAS_REVIEW]->(r)`.
   */
  @Relationship({
    type: "HAS_REVIEW", producer: "movieReviews",
    keyField: "title", recordKeyField: "movieTitle",
    description:
      "Individual web-found reviews of the film (one node per review — url, headline, outlet, critic, " +
      "excerpt, score), gathered by an LLM with web search and cached. Many per film; ORDER BY " +
      "r.score DESC for the best. Reach it from a recommendation: (m:Movie)-[:HAS_REVIEW]->(r:MovieReview).",
  })
  declare reviews: MovieReview[];

  /** The injected gateway, typed to the ops this realm uses. */
  private get api(): MovieGateway {
    return this.gateway as unknown as MovieGateway;
  }

  /**
   * Where this movie is streaming in a country (ISO-3166 alpha-2, lowercase — e.g. 'us', 'au').
   */
  async streaming(args: { country: string }): Promise<StreamingShow> {
    return this.api.streamingAvailability.getShow({ id: this.imdbId, country: args.country });
  }

  /**
   * Fresh OMDb metadata (full plot, ratings, runtime) for this movie.
   */
  async details(): Promise<OmdbMovie> {
    return this.api.omdb.getMovie({ i: this.imdbId, plot: "full" });
  }

  /**
   * Record the CURRENT USER's rating of this movie (1–10). Recording IS making the link:
   * createEntry against MovieRating auto-emits (me)-[:RATED]->(MovieRating) — and `me` is
   * also a Person, so it reads uniformly with other people's ratings. Identity is
   * `<myId>::<imdbId>`, so a re-rate updates in place. The same gateway op the card's star
   * widget calls. (Attributing a rating to ANOTHER person is a separate flow that resolves
   * that person and links their node.)
   */
  async rate(args: { rating: number; notes?: string; watchedOn?: string }): Promise<RatingEntry> {
    const me = await this.currentUser();
    const raterId = me.id || "";
    const data: MovieRatingInput = {
      ratingKey: `${raterId}::${this.imdbId}`,
      raterId,
      raterName: me.name,
      imdbId: this.imdbId,
      title: this.title,
      rating: args.rating,
      notes: args.notes,
      watchedOn: args.watchedOn,
    };
    return this.api.repository.createEntry({ type: "MovieRating", data });
  }

  /**
   * Put this film on the CURRENT USER's persistent "Want to See" list. Identity is
   * `<myId>::<imdbId>`, so saving it again refreshes the same node rather than duplicating it.
   */
  async saveForLater(): Promise<RatingEntry> {
    const me = await this.currentUser();
    const userId = me.id || "";
    if (!userId) throw new Error("The current user could not be resolved.");
    const data: MovieWatchlistInput = {
      watchlistKey: `${userId}::${this.imdbId}`,
      userId,
      imdbId: this.imdbId,
      title: this.title,
      year: this.year,
      director: this.director,
      genre: this.genre,
      poster: this.poster,
      plot: this.plot,
      addedOn: new Date().toISOString(),
    };
    return this.api.repository.createEntry({ type: "MovieWatchlistEntry", data });
  }

  /** The current user's own Person id + name, read from the scoped graph. */
  private async currentUser(): Promise<CurrentUser> {
    const res = await this.api.kg.query({
      cypher: "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1",
      params: JSON.stringify({}),
    });
    const rows = Array.isArray(res) ? res : res.rows || [];
    return rows[0] || {};
  }
}

/**
 * A streaming service (Netflix, Stan, …) a Movie can be watched on in the user's country.
 *
 * VIRTUAL — fetched on demand from the Streaming Availability API when a query traverses
 * AVAILABLE_ON; never stored. ONE node per service (identity `serviceId`), shared by every
 * film — the per-film facts (the deep link, how it's offered) live on each film's own
 * AVAILABLE_ON edge. Use it to filter recommendations to films the user can actually
 * stream, and to tell them WHERE:
 *
 * ```cypher
 * MATCH (m:Movie)-[ao:AVAILABLE_ON]->(s:StreamingService)
 * RETURN m.title, s.serviceName, ao.offerType, ao.watchLink
 * ```
 */
@Node({ userAnchor: false })
export class StreamingService extends Entity {
  /** Streaming service id, e.g. 'netflix'. Identity key. */
  @Id() declare serviceId: string;

  /** Display name of the service, e.g. 'Netflix'. */
  declare serviceName: string;
}

/**
 * A streaming service the CURRENT USER subscribes to — the per-user half of the streaming
 * catalog. Created and deleted through the app's country-specific checklist. The user anchor
 * gives `(:AssistantUser)-[:SUBSCRIBES_TO]->(:UserStreamingSubscription)`; filter recommendations
 * to what the user can actually watch by intersecting a Movie's AVAILABLE_ON services on
 * `serviceId`:
 *
 * ```cypher
 * MATCH (m:Movie)-[:AVAILABLE_ON]->(s:StreamingService)
 * WHERE EXISTS { (:AssistantUser)-[:SUBSCRIBES_TO]->(:UserStreamingSubscription {serviceId: s.serviceId}) }
 * ```
 */
@Node({ userAnchor: { predicate: "SUBSCRIBES_TO", direction: "from-user" } })
export class UserStreamingSubscription extends Entity {
  /**
   * Streaming service id (matches StreamingService.serviceId / the API's service.id),
   * e.g. 'netflix'.
   */
  @Id() declare serviceId: string;

  /** Display name, e.g. 'Netflix'. */
  declare serviceName: string;
}

/**
 * The CURRENT USER's streaming market. Streaming catalogues and licences vary by
 * country, so this is persisted explicitly rather than guessed from locale or a
 * deployment default.
 */
@Node({ userAnchor: { predicate: "HAS_MOVIE_STREAMING_PREFERENCES", direction: "from-user" } })
export class MovieStreamingPreferences extends Entity {
  /** Current user's id. One identity means changing country updates this node in place. */
  @Id() declare userId: string;

  /** ISO-3166 alpha-2 country code, lowercase. */
  declare countryCode: string;

  /** Human-readable country name. */
  declare countryName: string;

  /** ISO-8601 timestamp of the most recent change. */
  declare updatedAt: string;
}

/**
 * A one-per-user synthesis of the user's film taste, distilled from their MovieRatings.
 *
 * VIRTUAL — there is no stored MovieTasteSummary; it is materialized on demand by
 * aggregating (fan-IN) the user's ratings into ~100 words (producer `movieTasteSummary`,
 * cached weekly). Reach it from the user and read `ts.summary`:
 *
 * ```cypher
 * MATCH (me:AssistantUser)-[:HAS_MOVIE_TASTE_SUMMARY]->(ts:MovieTasteSummary) RETURN ts.summary
 * ```
 */
@Node({
  // Shared/virtual, not user-OWNED in the persistence sense: like Movie/StreamingService it
  // is materialized on demand and reached FROM the scoped `(me:AssistantUser)`, so it needs
  // no from-user anchor of its own. Movie-prefixed label + edge so this realm's fan-in node
  // can't collide with another realm's summary type.
  userAnchor: false,
})
// The fan-IN edge, and the one join in this realm whose ANCHOR the realm does not own —
// `AssistantUser` is a host type, so there is no class to hang a @Relationship field on.
// keyField is the user's `id` (== the world scope key), echoed by the producer into
// `anchorKey` so the one node links back.
@VirtualJoin({
  anchorLabel: "AssistantUser",
  relationship: "HAS_MOVIE_TASTE_SUMMARY",
  keyField: "id",
  recordKeyField: "anchorKey",
  producer: "movieTasteSummary",
  description:
    "The user's film-taste summary, synthesized from every MovieRating they've recorded. One node per " +
    "user — ask for `ts.summary`. Materialized on demand and cached weekly, so it is cheap to read " +
    "repeatedly. Use it to answer \"what's my taste in film?\" / \"summarize what I like\" without " +
    "hand-scanning the ratings.",
})
export class MovieTasteSummary extends Entity {
  /**
   * The user this summary is for — the identity key, so there is exactly ONE
   * MovieTasteSummary per user.
   */
  @Id() declare userId: string;

  /**
   * The ~100-word synthesis of the user's film taste: directors, genres, eras, countries,
   * and moods they love and avoid.
   */
  declare summary: string;

  /** How many ratings the summary was distilled from. */
  @Property({ type: "int" }) declare count: number;

  /** ISO-8601 timestamp the summary was generated (materialization time). */
  declare generatedAt: string;

  /**
   * Films that match your OVERALL taste, generated from your taste summary rather than from
   * any one rating. Fan-OUT off the taste summary — a good "surprise me based on everything
   * I like" list.
   *
   * ```cypher
   * MATCH (me:AssistantUser)-[:HAS_MOVIE_TASTE_SUMMARY]->(ts:MovieTasteSummary)-[:SUGGESTS]->(m:Movie)
   * WHERE NOT EXISTS { (me)-[:RATED]->(seen:MovieRating) WHERE seen.imdbId = m.imdbId }
   * RETURN DISTINCT m
   * ```
   */
  @Relationship({
    type: "SUGGESTS", producer: "tasteBasedPicks",
    keyField: "summary", recordKeyField: "fromTaste",
    description:
      "Films that match your OVERALL taste, generated from your taste summary rather than from any one " +
      "rating. A good \"surprise me based on everything I like\" list; exclude films you've already rated.",
  })
  declare suggestions: Movie[];

  /**
   * The WEB-GROUNDED sibling of {@link suggestions} — NEWLY RELEASED films matching the
   * taste summary. What is newly out is volatile, so the producer searches the live web
   * instead of answering from parametric memory; each find still resolves onto the Movie
   * spine via OMDb so it dedupes against rated films.
   */
  @Relationship({
    type: "SUGGESTS_NEW", producer: "newReleasePicks",
    // distinct from SUGGESTS's `fromTaste`, so the two fan-outs cannot cross-link
    keyField: "summary", recordKeyField: "freshFromTaste",
    description:
      "NEWLY RELEASED films matching your overall taste — currently in cinemas or fresh on streaming, " +
      "found by live web search rather than from memory. Use for \"anything new out I'd like?\"; " +
      "exclude films you've already rated.",
  })
  declare newReleases: Movie[];
}

/**
 * A rating of a Movie, attributed to a PERSON in the world — the current user OR any Person
 * they've recorded a rating for (a friend, a family member). One rating per (rater, movie):
 * re-rating updates in place. Reads power "what have I rated?", "what did &lt;person&gt;
 * think of X?", the "exclude already-seen" filter, and cross-person queries like "films
 * &lt;A&gt; and &lt;B&gt; would both like".
 *
 * Every rating hangs off a Person by `(Person)-[:RATED]->(MovieRating)`. The current user's
 * own ratings anchor on their AssistantUser node, which ALSO carries the `Person` label — so
 * the SAME edge and direction serve "me" and everyone else, and a two-person query is one
 * uniform join:
 *
 * ```cypher
 * MATCH (a:Person)-[:RATED]->(ra:MovieRating), (b:Person)-[:RATED]->(rb:MovieRating)
 * WHERE ra.imdbId = rb.imdbId AND ra.rating >= 8 AND rb.rating >= 8
 * ```
 */
@Node({
  // For the CURRENT user the framework emits `(me)-[:RATED]->` automatically on create_entry.
  // Attributing a rating to ANOTHER person is done by seeding or a future skill that resolves
  // the person (by email) and links `(person)-[:RATED]->(r)`.
  userAnchor: { predicate: "RATED", direction: "from-user" },
})
export class MovieRating extends Entity {
  /**
   * The identity key — `<raterId>::<imdbId>`. Composite (rater + movie) so two people rating
   * the SAME film are two distinct nodes, and a re-rate by the same person updates in place.
   * When recording for the current user, raterId is the user's own id.
   */
  @Id() declare ratingKey: string;

  /**
   * The id of the Person this rating belongs to — the current user's id for their own
   * ratings, or a contact's Person id. Matches the Person that `(Person)-[:RATED]->(this)`
   * links from.
   */
  declare raterId: string;

  /** Display name of the rater, denormalised for cheap recall without a join to the Person. */
  declare raterName: string;

  /**
   * IMDb id of the rated Movie (NOT the identity by itself — a movie can be rated by several
   * people). Use the same value as Movie.imdbId so ratings join to films and to each other.
   */
  declare imdbId: string;

  /** Title of the rated movie, denormalised for cheap recall without a join. */
  declare title: string;

  /** Score from 1 (terrible) to 10 (masterpiece). Whole numbers only. */
  @Property({ type: "int" }) declare rating: number;

  /** Optional one-line reaction, in the rater's own words. */
  declare notes?: string;

  /** Optional ISO-8601 date the movie was watched. */
  declare watchedOn?: string;

  /**
   * The film this rating is OF — its canonical Movie metadata, fetched by imdbId. This
   * makes the documented spine `(User)-[:RATED]->(MovieRating)-[:OF]->(Movie)` a real,
   * traversable path, so "top 3 rated films and their reviews" is a single query:
   *
   * ```cypher
   * MATCH (u:AssistantUser)-[:RATED]->(rt:MovieRating) WITH rt ORDER BY rt.rating DESC LIMIT 3
   * MATCH (rt)-[:OF]->(m:Movie)-[:HAS_REVIEW]->(r:MovieReview) RETURN m.title, r.title, r.score
   * ```
   */
  @Relationship({
    type: "OF", producer: "movieByImdbId",
    keyField: "imdbId", recordKeyField: "imdbId",
    description:
      "The film a rating is OF — its canonical Movie metadata, fetched by imdbId. Traverse this to go " +
      "from a MovieRating to the full film record (title, year, genre, director, plot, imdbRating) and " +
      "onward to its reviews or streaming options: (rt:MovieRating)-[:OF]->(m:Movie). One Movie per rating.",
  })
  declare movie: Movie;

  /**
   * Films similar to this one, from the assistant's own film knowledge (not an API). A LAZY
   * query-time join: the SIMILAR_TO edges are materialized transiently when the query
   * traverses them and rolled back after.
   *
   * Ratings are 1–10, so anchor recommendations on films the user LOVED, not merely watched.
   */
  @Relationship({
    type: "SIMILAR_TO", producer: "similarMovies",
    keyField: "title", recordKeyField: "similarTo",
    description:
      "Films similar to one the user rated, from the assistant's own film knowledge (not an API). " +
      "Ratings are on a 1–10 scale, so anchor recommendations on the films the user LOVED, not merely " +
      "watched: filter `WHERE rt.rating >= 8` (8+/10) — a low-rated film is a negative signal, not a " +
      "\"more like this\". Each suggestion resolves to its imdbId so it dedupes against already-rated " +
      "films; exclude everything the user has seen with a NOT EXISTS over their MovieRating imdbIds, " +
      "and rank by how many loved films point at each candidate (`count(*) DESC`).",
  })
  declare similar: Movie[];
}

/**
 * One film the current user wants to see. This is a REAL persisted node, reached through
 * `(me:AssistantUser)-[:WANTS_TO_SEE]->(entry:MovieWatchlistEntry)`. Film metadata is copied
 * onto the entry for fast list rendering; the virtual `OF` hop resolves the canonical Movie
 * from IMDb when a query needs the full movie graph.
 */
@Node({ userAnchor: { predicate: "WANTS_TO_SEE", direction: "from-user" } })
export class MovieWatchlistEntry extends Entity {
  /** `<userId>::<imdbId>` — one saved entry per user and film. */
  @Id() declare watchlistKey: string;

  /** User who owns this list entry. */
  declare userId: string;

  /** IMDb identity of the saved film. */
  declare imdbId: string;

  /** Denormalised display fields for an immediate stored-data list read. */
  declare title: string;
  @Property({ type: "int" }) declare year?: number;
  declare director?: string;
  declare genre?: string;
  declare poster?: string;
  declare plot?: string;
  declare addedOn: string;

  /** Canonical movie metadata, resolved on demand from this entry's IMDb id. */
  @Relationship({
    type: "OF", producer: "movieByImdbId",
    keyField: "imdbId", recordKeyField: "imdbId",
    description:
      "The canonical Movie this saved-list entry refers to. The watchlist node and WANTS_TO_SEE edge " +
      "are persisted; this OF hop resolves full IMDb-backed film metadata on demand.",
  })
  declare movie: Movie;
}

/**
 * An INDIVIDUAL published review of a film — one node PER review (many per film): its url,
 * headline, the outlet, the critic, a representative excerpt, and a normalized score.
 *
 * VIRTUAL: found on demand by an LLM WITH WEB SEARCH (producer `movieReviews`), never
 * stored. A PROMPTED, TOOL-GROUNDED edge that returns this type directly — the LLM produces
 * these fields (no OMDb resolve). Reach it from a Movie:
 *
 * ```cypher
 * MATCH (m:Movie)-[:HAS_REVIEW]->(r:MovieReview)
 * RETURN r.title, r.url, r.publication, r.score ORDER BY r.score DESC
 * ```
 */
@Node({ userAnchor: false })
export class MovieReview extends Entity {
  /** Link to the review — the identity key (each distinct review is its own node). */
  @Id() declare url: string;

  /** The review's headline / title. */
  declare title: string;

  /** The outlet the review appeared in, e.g. 'The Guardian', 'RogerEbert.com'. */
  declare publication: string;

  /** The critic's name, if known. */
  declare author: string;

  /** A representative sentence or two from the review. */
  declare excerpt: string;

  /** ISO-8601 date the review was published, if shown — nullable (many carry no date). */
  declare reviewDate?: string;

  /** Overall sentiment of the review: 'positive', 'mixed', or 'negative'. */
  declare sentiment: string;

  /**
   * The review's score normalized to 0–10 if the review gives a numeric one; often absent
   * (stars/letters live in {@link originalScore}).
   */
  @Property({ type: "number" }) declare score: number;

  /**
   * The rating exactly as the review gives it, e.g. '4/5', 'A-', '★★★★' — kept because
   * normalizing to {@link score} loses the native scale.
   */
  declare originalScore: string;

  /** A one-sentence takeaway of the review's overall verdict. */
  declare verdict: string;

  /** The film this review is of — links the review back to its Movie (matches Movie.title). */
  declare movieTitle: string;
}
