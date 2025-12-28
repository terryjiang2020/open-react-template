"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation"; // Corrected import for Next.js 13+
import { searchPokemon } from "@/services/pokemonService";

const PokemonPage = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pokemons, setPokemons] = useState<any>([]);
  const [search, setSearch] = useState(searchParams.get("query") || "");
  const [currentPage, setCurrentPage] = useState(
    parseInt(searchParams.get("page") || "0", 10)
  );
  const [totalPages, setTotalPages] = useState(1);
  const [lastSearch, setLastSearch] = useState<string | null>(null);; // Track the last search term

  useEffect(() => {
    searchPokemon({ query: "", page: 0 })
      .then((data) => {
        console.log('Fetched Pokémon data:', data);
        let pokemonList = [];
        let totalPages = 1;
        if (data.success) {
            pokemonList = data.result.results;
            totalPages = data.result.totalPage;
        }
        setPokemons(pokemonList);
        setTotalPages(totalPages);
    })
      .catch((error) => console.error("Error fetching Pokémon data:", error));
  }, []);

  const updateUrl = (query: string, page: number) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    params.set("page", page.toString());
    router.push(`/dashboard/pokemons?${params.toString()}`);
  };

  const handleSearch = async (e: any) => {
    e.preventDefault();
    updateUrl(search, 0);
    try {
      const data = await searchPokemon({ query: search, page: 0 });
      let pokemonList = [];
      let totalPages = 1;
      if (data.success) {
        pokemonList = data.result.results;
        totalPages = data.result.totalPage;
      }
      setPokemons(pokemonList);
      setTotalPages(totalPages);
    } catch (error) {
      console.error(error);
    }
  };

  const handlePageChange = async (newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return;
    updateUrl(search, newPage);
    try {
      const data = await searchPokemon({ query: search, page: newPage });
      let pokemonList = [];
      if (data.success) {
        pokemonList = data.result.results;
      }
      setPokemons(pokemonList);
      setCurrentPage(newPage);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    const initialQuery = searchParams.get("query") || "";
    const initialPage = parseInt(searchParams.get("page") || "0", 10);
    setSearch(initialQuery);
    setCurrentPage(initialPage);
    handleSearch(new Event("submit"));
  }, []);

  const handleViewDetail = (pokemon: any) => {
    router.push(`/dashboard/pokemons/${pokemon.id}`);
  };

  return (
    <div>
      <h1>Pokémons</h1>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Search Pokémon by name or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "0.5rem", marginRight: "0.5rem", color: "black" }} // Set text color to black
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Search</button>
      </form>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
        <thead>
          <tr>
            <th style={{ border: "1px solid #ddd", padding: "8px" }}>Image</th>
            <th style={{ border: "1px solid #ddd", padding: "8px" }}>Name</th>
            <th style={{ border: "1px solid #ddd", padding: "8px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {pokemons.map((pokemon: any, index: number) => (
            <tr key={index}>
              <td style={{ border: "1px solid #ddd", padding: "8px", textAlign: "center" }}>
                <img src={pokemon.sprite} alt={pokemon.identifier} style={{ width: "50px", height: "50px" }} />
              </td>
              <td style={{ border: "1px solid #ddd", padding: "8px" }}>{pokemon.identifier}</td>
              <td style={{ border: "1px solid #ddd", padding: "8px" }}>
                <button style={{ marginRight: "8px" }} onClick={() => handleViewDetail(pokemon)}>View Detail</button>
                <button>{pokemon.isInWatchlist ? "Remove from Watchlist" : "Add to Watchlist"}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1rem" }}>
        <button
          onClick={() => handlePageChange(currentPage - 1)}
          disabled={currentPage === 0} // Adjusted for 0-based index
          style={{ padding: "0.5rem 1rem" }}
        >
          Previous
        </button>
        <span>Page {currentPage + 1} of {totalPages}</span> {/* Adjusted display for 1-based UI */}
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