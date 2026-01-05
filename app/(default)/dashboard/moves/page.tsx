"use client";

import { useEffect, useState } from "react";
import { searchMove } from "@/services/pokemonService";
import { getTypeClass } from "@/services/typeStyleService";

const MovePage = () => {
  const [moves, setMoves] = useState<any[]>([]);
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
      const data = await searchMove({ searchterm: formattedSearchTerm, page: currentPage });
      if (data.success) {
        setMoves(data.result.results);
        setTotalPages(data.result.totalPage);
      } else {
        console.warn("No moves found for the given search term.");
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
    handleSearch(new Event("submit"));
  }, [currentPage]);

  useEffect(() => {
    handleSearch(new Event("submit")); // Trigger search on start without any search term
  }, []);

  return (
    <div className="space-y-6">
      <div className="pb-6">
        <h1 className="text-4xl font-semibold text-foreground">Moves</h1>
        <p className="mt-2 text-muted-foreground">Explore all available Pokémon moves. Search by name, type, and power.</p>
      </div>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Search Move by name or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "0.5rem", marginRight: "0.5rem", color: "white" }} // Set text color to black
        />
        <button type="submit" style={{ padding: "0.5rem 1rem", marginRight: "0.5rem" }}>Search</button>
      </form>
      <div className="max-h-[600px] overflow-y-auto">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {moves.map((move: any, index: number) => (
            <div key={index} className="flex flex-col gap-2 rounded-lg border border-border/50 p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold capitalize">{move.localized_name}</span>
                {
                  <span
                    key={index}
                    className={`text-xs capitalize ${getTypeClass(move.type_name)}`}
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
                    {move.type_name || "Unknown"}
                  </span>
                }
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono text-xs text-muted-foreground">
                <div>
                  Power: <span className="text-foreground">{move.power ?? "-"}</span>
                </div>
                <div>
                  Accuracy: <span className="text-foreground">{move.accuracy ?? "-"}%</span>
                </div>
              </div>
            </div>
          ))}
          {moves.length === 0 && (
            <div className="col-span-2 text-sm text-muted-foreground">No moves for this filter.</div>
          )}
        </div>
      </div>

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

export default MovePage;
