"use client";

import { useEffect, useState } from "react";
import { searchMove } from "@/services/pokemonService";

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
    <div>
      <h1>Moves</h1>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Search Move by name or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "0.5rem", marginRight: "0.5rem", color: "black" }} // Set text color to black
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Search</button>
      </form>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
        <thead>
          <tr>
            <th style={{ border: "1px solid #ddd", padding: "8px" }}>Name</th>
            <th style={{ border: "1px solid #ddd", padding: "8px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((move, index) => (
            <tr key={index}>
              <td style={{ border: "1px solid #ddd", padding: "8px" }}>{move.identifier}</td>
              <td style={{ border: "1px solid #ddd", padding: "8px" }}>
                <button style={{ marginRight: "8px" }}>View Detail</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
