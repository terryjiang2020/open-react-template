"use client";

import { useEffect, useState } from "react";
import { searchAbility } from "@/services/pokemonService";

const AbilityPage = () => {
  const [abilities, setAbilities] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [lastSearch, setLastSearch] = useState<string | null>(null);; // Track the last search term

  const handleSearch = async (e: any) => {
    e.preventDefault();
    const formattedSearchTerm = search.trim().toLowerCase();

    if (formattedSearchTerm !== lastSearch) {
      setCurrentPage(0); // Reset page if search term changes
    }

    setLastSearch(formattedSearchTerm); // Update last search term

    try {
      const data = await searchAbility({ searchterm: formattedSearchTerm, page: currentPage });
      if (data.success) {
        setAbilities(data.result.results);
        setTotalPages(data.result.totalPage);
      } else {
        console.warn("No abilities found for the given search term.");
      }
    } catch (error: any) {
      console.warn(error);
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return;
    setCurrentPage(newPage);
  };

  useEffect(() => {
    handleSearch(new Event("submit")); // Trigger search on start without any search term
  }, []);

  useEffect(() => {
    handleSearch(new Event("submit"));
  }, [currentPage]);

  return (
    <div className="space-y-6">
      <div className="pb-6">
        <h1 className="text-4xl font-semibold text-foreground">Abilities</h1>
        <p className="mt-2 text-muted-foreground">Discover Pokémon abilities and their effects. Search and learn about each ability.</p>
      </div>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Search Ability by name or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "0.5rem", marginRight: "0.5rem", color: "white" }} // Set text color to black
        />
        <button type="submit" style={{ padding: "0.5rem 1rem", marginRight: "0.5rem" }}>Search</button>
      </form>
      {
        abilities.length === 0 && (
          <p style={{ marginTop: "1rem" }}>No abilities found.</p>
        )
      }
      {
        abilities.length > 0 && (       
          <div className="border-border/50 bg-card">
            <div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {abilities.map((ability) => (
                  <div
                    key={ability.id}
                    className="flex flex-col gap-3 rounded-lg border border-white/50 bg-card p-4 transition-colors hover:border-primary/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-xs text-muted-foreground">ID: {ability.id}</div>
                        <h3 className="text-lg font-semibold text-foreground">{ability.localized_name}</h3>
                      </div>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{ability.short_effect || "No description available."}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      }
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1rem" }}>
        <button
          onClick={() => handlePageChange(currentPage - 1)}
          disabled={currentPage === 0}
          style={{ padding: "0.5rem 1rem" }}
        >
          Previous
        </button>
        <span>Page {currentPage + 1} of {totalPages}</span>
        <button
          onClick={() => handlePageChange(currentPage + 1)}
          disabled={currentPage + 1 === totalPages}
          style={{ padding: "0.5rem 1rem" }}
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default AbilityPage;
