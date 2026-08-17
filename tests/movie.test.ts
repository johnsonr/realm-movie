/**
 * Tests for the `Movie` type's methods. Each runs against a MOCKED gateway (no
 * live server, no API keys): `entityForTest` builds a real `Movie` with its
 * fields set and the mock gateway injected — exactly what the host does at
 * runtime — so the method under test runs unchanged. We then assert it called
 * the right underlying gateway op with the right args.
 */
import { describe, it, expect, vi } from "vitest";
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { Movie } from "../src/api/movie";

describe("Movie.streaming", () => {
  it("reads the movie's imdbId and the country arg, calls streamingAvailability.getShow", async () => {
    const getShow = vi
      .fn()
      .mockResolvedValue({ streamingOptions: { au: [{ service: "netflix", type: "subscription" }] } });
    const movie = entityForTest(
      Movie,
      { imdbId: "tt0113451" },
      mockGateway<GenericGatewayContext>({ streamingAvailability: { getShow } }),
    );

    const r = await movie.streaming({ country: "au" });

    expect(getShow).toHaveBeenCalledWith({ id: "tt0113451", country: "au" });
    expect(r).toMatchObject({ streamingOptions: { au: [{ service: "netflix" }] } });
  });
});

describe("Movie.details", () => {
  it("reads the movie's imdbId, calls omdb.getMovie with the full plot", async () => {
    const getMovie = vi.fn().mockResolvedValue({ Title: "Jade", imdbID: "tt0113451" });
    const movie = entityForTest(
      Movie,
      { imdbId: "tt0113451" },
      mockGateway<GenericGatewayContext>({ omdb: { getMovie } }),
    );

    const r = await movie.details();

    expect(getMovie).toHaveBeenCalledWith({ i: "tt0113451", plot: "full" });
    expect(r).toMatchObject({ Title: "Jade" });
  });
});

describe("Movie.rate", () => {
  it("attributes the rating to the current user with a rater-inclusive identity key", async () => {
    const createEntry = vi.fn().mockResolvedValue({ id: "mr1" });
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "rod_johnson_assistant", name: "Rod Johnson" }] });
    const movie = entityForTest(
      Movie,
      { imdbId: "tt0113451", title: "Jade" },
      mockGateway<GenericGatewayContext>({ repository: { createEntry }, kg: { query } }),
    );

    await movie.rate({ rating: 7, notes: "messy but fun" });

    expect(createEntry).toHaveBeenCalledWith({
      type: "MovieRating",
      data: {
        ratingKey: "rod_johnson_assistant::tt0113451",
        raterId: "rod_johnson_assistant",
        raterName: "Rod Johnson",
        imdbId: "tt0113451",
        title: "Jade",
        rating: 7,
        notes: "messy but fun",
        watchedOn: undefined,
      },
    });
  });
});

describe("Movie.saveForLater", () => {
  it("persists one user-anchored watchlist entry keyed by user and IMDb id", async () => {
    const createEntry = vi.fn().mockResolvedValue({ id: "watch1" });
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "rod_johnson_assistant" }] });
    const movie = entityForTest(
      Movie,
      {
        imdbId: "tt0038355", title: "The Big Sleep", year: 1946,
        director: "Howard Hawks", genre: "Crime, Film-Noir", poster: "https://poster.example/big-sleep.jpg",
        plot: "Philip Marlowe is drawn into the affairs of the Sternwood family.",
      },
      mockGateway<GenericGatewayContext>({ repository: { createEntry }, kg: { query } }),
    );

    await movie.saveForLater();

    expect(createEntry).toHaveBeenCalledWith({
      type: "MovieWatchlistEntry",
      data: expect.objectContaining({
        watchlistKey: "rod_johnson_assistant::tt0038355",
        userId: "rod_johnson_assistant",
        imdbId: "tt0038355",
        title: "The Big Sleep",
        year: 1946,
        addedOn: expect.any(String),
      }),
    });
  });
});

describe("Movie.neighbors (inherited from Entity)", () => {
  it("walks the graph from this movie's id via kg.neighbors — no per-type code", async () => {
    const neighbors = vi.fn().mockResolvedValue([{ id: "p1", label: "Person", name: "Linda Fiorentino" }]);
    const movie = entityForTest(
      Movie,
      { id: "movie-tt0113451", imdbId: "tt0113451" },
      mockGateway<GenericGatewayContext>({ kg: { neighbors } }),
    );

    const r = await movie.neighbors({ hops: 2 });

    expect(neighbors).toHaveBeenCalledWith({ id: "movie-tt0113451", hops: 2 });
    expect(r).toMatchObject([{ name: "Linda Fiorentino" }]);
  });
});
