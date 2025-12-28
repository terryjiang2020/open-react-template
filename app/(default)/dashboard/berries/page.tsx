"use client";

import { useEffect, useState } from "react";
import { searchBerry } from "@/services/pokemonService";

const BerryPage = () => {
  const [berries, setBerries] = useState([]);
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [lastSearch, setLastSearch] = useState(""); // Track the last search term

  const handleSearch = async (e: any) => {
    e.preventDefault();
    const formattedSearchTerm = search.trim().toLowerCase();

    if (formattedSearchTerm !== lastSearch) {
      setCurrentPage(0); // Reset page if search term changes
    }

    setLastSearch(formattedSearchTerm); // Update last search term

    try {
      const data = await searchBerry({ query: formattedSearchTerm, page: currentPage });
      if (data.results) {
        setBerries(data.results);
        setTotalPages(data.totalPage);
      } else {
        console.error("No berries found for the given search term.");
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return;
    setCurrentPage(newPage);
  };

  useEffect(() => {
    if (search.trim() !== "") {
      handleSearch(new Event("submit"));
    }
  }, [currentPage]);

  return (
    <div>
      <h1>Berries</h1>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Search Berry by name or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: "0.5rem", marginRight: "0.5rem", color: "black" }} // Set text color to black
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Search</button>
      </form>
      <ul>
        {berries.map((berry, index) => (
          <li key={index} style={{ marginBottom: "0.5rem" }}>
            <span>{berry.name} - Flavor: {berry.flavor}, Firmness: {berry.firmness}, Natural Gift Power: {berry.naturalGiftPower}</span>
          </li>
        ))}
      </ul>
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

export default BerryPage;
