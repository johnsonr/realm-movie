import { Entity } from "@embabel/runtime-types";

// ─── Data shapes ────────────────────────────────────────────────────────────
// Plain records the methods read or write. They have no behaviour of their own,
// so they stay interfaces and live beside the `Movie` type that uses them.

/**
 * A rating of a Movie, attributed to a person. Identity is `ratingKey`
 * (`<raterId>::<imdbId>`), so one row per (rater, movie); the framework also
 * anchors it to the current user via `RATED` on createEntry. Canonical schema
 * lives in `types/movies.yml`; this is the slice `Movie.rate` writes.
 */
export interface MovieRating {
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
 * The gateway ops `Movie` calls, typed. Until `embabel-pack sync` generates the
 * host's fully-typed `GatewayContext`, a pack types the slice it uses itself and
 * reads it through {@link Movie.api}, so method bodies and return types are fully
 * typed (no `unknown`). Swap this for the generated surface when `sync` lands.
 */
interface MovieGateway {
  streamingAvailability: { getShow(args: { id: string; country: string }): Promise<StreamingShow> };
  omdb: { getMovie(args: { i: string; plot: string }): Promise<OmdbMovie> };
  repository: { createEntry(args: { type: string; data: MovieRating }): Promise<RatingEntry> };
  kg: { query(args: { cypher: string; params: string }): Promise<{ rows?: CurrentUser[] } | CurrentUser[]> };
}

// ─── The type ───────────────────────────────────────────────────────────────

/**
 * A film in the knowledge graph. Identity is `imdbId`.
 *
 * Extending `Entity` is the whole declaration: it makes the host recognise
 * `Movie` as a type, hydrates an in-scope object's fields onto `this`, and gives
 * it `neighbors()` for free. Each async method below is an affordance callable on
 * that object — `movie.streaming({ country: "us" })` — with no `ctx`/`self`
 * plumbing: `this` is the movie, `this.api` reaches the APIs the pack brings in
 * (where the credentials live, server-side).
 */
export class Movie extends Entity {
  /** IMDb id — the identity key (e.g. "tt0114367"). */
  imdbId!: string;
  title?: string;
  year?: string;
  genre?: string;
  director?: string;
  runtimeMinutes?: string;

  /** The injected gateway, typed to the ops this pack uses. */
  private get api(): MovieGateway {
    return this.gateway as unknown as MovieGateway;
  }

  /**
   * Where this movie is streaming in a country (ISO-3166 alpha-2, lowercase —
   * e.g. 'us', 'au').
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
   * Record the CURRENT USER's rating of this movie (1–10). Recording IS making the
   * link: createEntry against MovieRating auto-emits (me)-[:RATED]->(MovieRating) —
   * and `me` is also a Person, so it reads uniformly with other people's ratings.
   * Identity is `<myId>::<imdbId>`, so a re-rate updates in place. The same gateway
   * op the card's star widget calls. (Attributing a rating to ANOTHER person is a
   * separate flow that resolves that person and links their node.)
   */
  async rate(args: { rating: number; notes?: string; watchedOn?: string }): Promise<RatingEntry> {
    const me = await this.currentUser();
    const raterId = me.id || "";
    const data: MovieRating = {
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
