"use client";

import { useEffect, useState } from "react";
import { searchPokemon } from "@/services/pokemonService";

const PokemonPage = () => {
  const [pokemons, setPokemons] = useState<any>([]);
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(0); // Updated to start at 0
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

  const handleSearch = async (e: any) => {
    e.preventDefault();
    const formattedSearchTerm = search.trim().toLowerCase();

    if (formattedSearchTerm !== lastSearch) {
      setCurrentPage(0); // Reset page if search term changes
    }

    setLastSearch(formattedSearchTerm); // Update last search term

    try {
        const data = await searchPokemon({ query: formattedSearchTerm, page: currentPage });
        let pokemonList = [];
        let totalPages = 1;
        if (data.success) {
            pokemonList = data.result.results;
            totalPages = data.result.totalPage;
        } else {
            console.error("No Pokémon found for the given search term.");
        }
        setPokemons(pokemonList);
        setTotalPages(totalPages);
    } catch (error) {
      console.error(error);
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return; // Adjusted bounds for 0-based index
    setCurrentPage(newPage);
  };

  useEffect(() => {
    console.log('Current page changed to:', currentPage);
    handleSearch(new Event("submit"));
  }, [currentPage]);

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
          {pokemons.map((pokemon, index) => (
            <tr key={index}>
              <td style={{ border: "1px solid #ddd", padding: "8px", textAlign: "center" }}>
                <img src={pokemon.sprite} alt={pokemon.identifier} style={{ width: "50px", height: "50px" }} />
              </td>
              <td style={{ border: "1px solid #ddd", padding: "8px" }}>{pokemon.identifier}</td>
              <td style={{ border: "1px solid #ddd", padding: "8px" }}>
                <button style={{ marginRight: "8px" }}>View Detail</button>
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