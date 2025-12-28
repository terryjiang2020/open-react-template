"use client";

import { useEffect, useState } from "react";
import { fetchPokemons, searchPokemon } from "@/services/pokemonService";

const PokemonPage = () => {
  const [pokemons, setPokemons] = useState([]);
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(0); // Updated to start at 0
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    fetchPokemons()
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

    try {
        const formattedSearchTerm = search.trim().toLowerCase();
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
          style={{ padding: "0.5rem", marginRight: "0.5rem" }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Search</button>
      </form>
      <ul>
        {pokemons.map((pokemon, index) => (
          <li key={index} style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center" }}>
            <img
              src={pokemon.sprite}
              alt={pokemon.identifier}
              style={{ width: "50px", height: "50px", marginRight: "1rem" }}
            />
            <span>{pokemon.identifier}</span>
          </li>
        ))}
      </ul>
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