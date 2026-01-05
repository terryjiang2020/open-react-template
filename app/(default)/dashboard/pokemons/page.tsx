"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  searchPokemon,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} from "@/services/pokemonService";
import { typeClasses, typeColors } from "./[id]/page";

const PokemonPage = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pokemons, setPokemons] = useState<any[]>([]);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [search, setSearch] = useState(searchParams?.get("searchTerm") || "");
  const [currentPage, setCurrentPage] = useState(
    parseInt(searchParams?.get("page") || "0", 10)
  );
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    searchPokemon({ searchterm: "", page: 0 })
      .then((data) => {
        console.log("Fetched Pokémon data:", data);
        let pokemonList = [];
        let totalPages = 1;
        if (data.success) {
          pokemonList = data.result.results;
          totalPages = data.result.totalPage;
        }
        setPokemons(pokemonList);
        setTotalPages(totalPages);
      })
      .catch((error) => console.warn("Error fetching Pokémon data:", error));
  }, []);

  const fetchWatchlist = async () => {
    try {
      const data = await getWatchlist();
      console.log('Fetched Watchlist data:', data);
      if (data.success) {
        setWatchlist(data.result);
      }
    } catch (error) {
      console.error("Failed to fetch watchlist:", error);
    }
  };

  useEffect(() => {
    fetchWatchlist();
  }, []);

  const updateUrl = (query: string, page: number) => {
    const params = new URLSearchParams();
    if (query) params.set("searchTerm", query);
    params.set("page", page.toString());
    router.push(`/dashboard/pokemons?${params.toString()}`);
  };

  const handleSearch = async (e: any) => {
    e.preventDefault();
    updateUrl(search, 0);
    try {
      const data = await searchPokemon({ searchterm: search, page: 0 });
      let pokemonList = [];
      let totalPages = 1;
      if (data.success) {
        pokemonList = data.result.results;
        totalPages = data.result.totalPage;
      }
      setPokemons(pokemonList);
      setTotalPages(totalPages);
    } catch (error: any) {
      console.warn(error);
    }
  };

  const handlePageChange = async (newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return;
    updateUrl(search, newPage);
    try {
      const data = await searchPokemon({ searchterm: search, page: newPage });
      let pokemonList = [];
      if (data.success) {
        pokemonList = data.result.results;
      }
      setPokemons(pokemonList);
      setCurrentPage(newPage);
    } catch (error: any) {
      console.warn(error);
    }
  };

  useEffect(() => {
    const initialQuery = searchParams?.get("searchTerm") || "";
    const initialPage = parseInt(searchParams?.get("page") || "0", 10);
    setSearch(initialQuery);
    setCurrentPage(initialPage);
    handleSearch(new Event("submit"));
  }, []);

  const handleViewDetail = (pokemon: any) => {
    router.push(`/dashboard/pokemons/${pokemon.id}`);
  };

  const toggleWatchlist = async (pokemonId: number) => {
    try {
      if (watchlist.some((item) => item.pokemonId === pokemonId)) {
        await removeFromWatchlist(pokemonId);
      } else {
        await addToWatchlist(pokemonId);
      }
      fetchWatchlist();
    } catch (error) {
      console.error("Failed to update watchlist:", error);
    }
  };
  
  const getTypeClass = (type: string) => {
    const key = (type || "normal").toLowerCase();
    return typeClasses[key] || typeClasses.normal;
  };

  return (
    <div className="space-y-6">
      <div className="pb-6">
        <h1 className="text-4xl font-semibold text-foreground">Pokémons</h1>
        <p className="mt-2 text-muted-foreground">Browse and manage your Pokémon collection. Search, filter, and add favorites to your watchlist.</p>
      </div>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Search Pokémon by name or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "0.5rem",
            marginRight: "0.5rem",
            color: "white",
          }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>
          Search
        </button>
      </form>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pokemons.map((pokemon) => (
          <div
            key={pokemon.id}
            className="flex flex-col gap-3 rounded-lg border border-border/50 bg-card p-4 transition-colors hover:border-white/50"
          >
            {/* Pokemon Info */}
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="font-mono text-xs text-muted-foreground">
                  #{pokemon.id.toString().padStart(3, "0")}
                </div>
                <h3 className="text-lg font-semibold text-foreground">{pokemon.identifier}</h3>
              </div>
              <img
                src={pokemon.sprite}
                alt={pokemon.identifier}
                className="size-16 object-contain"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {pokemon.types && pokemon.types.length > 0 ? (
                pokemon.types.map((type: string, index: number) => {
                  const typeIdentifier = type || "";
                  const typeName = type || typeIdentifier;

                  return (
                    <span
                      key={index}
                      className={`text-xs capitalize ${getTypeClass(typeName)}`}
                      style={{
                        padding: "0.5rem 1rem",
                        borderRadius: "12px",
                        fontWeight: "bold",
                        display: "inline-block",
                        minWidth: "80px",
                        textAlign: "center",
                        textTransform: "capitalize",
                      }}
                    >
                      {typeName || "Unknown"}
                    </span>
                  );
                })
              ) : (
                <p>No type information available</p>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <button
                onClick={() => handleViewDetail(pokemon)}
                className="flex-1 gap-1.5 border border-white rounded-lg text-base h-10 hover:bg-white/10"
              >
                View Details
              </button>
              <button
                onClick={() => toggleWatchlist(pokemon.id)}
                className={`flex-1 gap-1.5 text-base h-10 ${
                  watchlist.some(item => item.pokemonId === pokemon.id)
                    ? "border border-primary bg-primary/10 text-primary rounded-lg hover:bg-primary/20"
                    : "border border-white rounded-lg hover:bg-white/10"
                }`}
              >
                {watchlist.some((item) => item.pokemonId === pokemon.id)
                  ? "Remove from Watchlist"
                  : "Add to Watchlist"}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: "1rem",
        }}
      >
        <button
          onClick={() => handlePageChange(currentPage - 1)}
          disabled={currentPage === 0} // Adjusted for 0-based index
          style={{ padding: "0.5rem 1rem" }}
        >
          Previous
        </button>
        <span>
          Page {currentPage + 1} of {totalPages}{" "}
        </span>{" "}
        {/* Adjusted display for 1-based UI */}
        <button
          onClick={() => handlePageChange(currentPage + 1)}
          disabled={currentPage + 1 === totalPages} // Adjusted for 0-based index
          style={{ padding: "0.5rem 1rem" }}
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default PokemonPage;

/*
Let's say tomorrow
*/