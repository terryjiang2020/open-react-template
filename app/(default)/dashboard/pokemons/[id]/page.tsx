"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchPokemonDetails } from "@/services/pokemonService";

const typeColors = {
  normal: "#A8A878",
  fighting: "#C03028",
  flying: "#A890F0",
  poison: "#A040A0",
  ground: "#E0C068",
  rock: "#B8A038",
  bug: "#A8B820",
  ghost: "#705898",
  steel: "#B8B8D0",
  fire: "#F08030",
  water: "#6890F0",
  grass: "#78C850",
  electric: "#F8D030",
  psychic: "#F85888",
  ice: "#98D8D8",
  dragon: "#7038F8",
  dark: "#705848",
  fairy: "#EE99AC",
  stellar: "#FFD700", // Custom color for stellar
};

const PokemonDetailPage = () => {
  const params = useParams();
  const id = params?.id;
  const [pokemon, setPokemon] = useState(null);
  const [filter, setFilter] = useState("level-up");

  useEffect(() => {
    if (id) {
      fetchPokemonDetails(Number(id))
        .then((data) => {
          if (data.success) {
            data.result.moves = data.result.moves.map((move: any) => ({
              ...move,
              type: move.type ? move.type : "Normal",
            })) || [];
            setPokemon(data.result);
          } else {
            console.warn("Failed to fetch Pokémon details.");
          }
        })
        .catch((error) => console.warn(error));
    }
  }, [id]);

  if (!pokemon) {
    return <div>Loading...</div>;
  }

  return (
    <div style={{ padding: "1rem", fontFamily: "Arial, sans-serif" }}>
      <style jsx global>{`
        body {
          background-color: #121212;
          color: #ffffff;
        }
        button {
          transition: background-color 0.3s, color 0.3s;
        }
      `}</style>

      <button
        onClick={() => window.history.back()}
        style={{
          padding: "0.5rem 1rem",
          backgroundColor: "#1e88e5",
          color: "#ffffff",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
          marginBottom: "1rem",
        }}
      >
        Back
      </button>

      <h1 style={{ textAlign: "center" }}>{pokemon.name}</h1>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "1rem" }}>
        <img src={pokemon.sprite} alt={pokemon.name} style={{ width: "200px", height: "200px" }} />
      </div>
      <p><strong>Height:</strong> {pokemon.height} decimetres</p>
      <p><strong>Weight:</strong> {pokemon.weight} hectograms</p>
      <p><strong>Base Experience:</strong> {pokemon.baseExperience}</p>
      <p><strong>Flavor Text:</strong> {pokemon.flavorText}</p>

      <h2>Types</h2>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        {pokemon.types.map((type, index) => (
          <span
            key={index}
            style={{
              backgroundColor: typeColors[type.type.toLowerCase()] || "#ccc",
              color: "#fff",
              padding: "0.5rem 1rem",
              borderRadius: "12px",
              fontWeight: "bold",
            }}
          >
            {type.type_name}
          </span>
        ))}
      </div>

      <h2>Abilities</h2>
      <ul>
        {pokemon.abilities.map((ability, index) => (
          <li key={index}>{ability.ability_name}</li>
        ))}
      </ul>

      <h2>Moves</h2>
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <button
          onClick={() => setFilter("level-up")}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: filter === "level-up" ? "#1e88e5" : "#424242",
            color: filter === "level-up" ? "#ffffff" : "#bdbdbd",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Level-Up
        </button>
        <button
          onClick={() => setFilter("tutor")}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: filter === "tutor" ? "#1e88e5" : "#424242",
            color: filter === "tutor" ? "#ffffff" : "#bdbdbd",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Tutor
        </button>
        <button
          onClick={() => setFilter("machine")}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: filter === "machine" ? "#1e88e5" : "#424242",
            color: filter === "machine" ? "#ffffff" : "#bdbdbd",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Machine
        </button>
      </div>

      <div style={{ maxHeight: "400px", overflowY: "auto", marginTop: "1rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, backgroundColor: "#212121", zIndex: 1 }}>
            <tr>
              <th style={{ border: "1px solid #424242", padding: "8px", color: "#ffffff" }}>Name</th>
              <th style={{ border: "1px solid #424242", padding: "8px", color: "#ffffff" }}>Type</th>
              <th style={{ border: "1px solid #424242", padding: "8px", color: "#ffffff" }}>Power</th>
              <th style={{ border: "1px solid #424242", padding: "8px", color: "#ffffff" }}>Accuracy</th>
              <th style={{ border: "1px solid #424242", padding: "8px", color: "#ffffff" }}>Method</th>
              <th style={{ border: "1px solid #424242", padding: "8px", color: "#ffffff" }}>Level</th>
            </tr>
          </thead>
          <tbody>
            {pokemon.moves
              ?.filter((move) => filter === "all" || move.move_method === filter)
              .map((move, index) => (
                <tr key={index}>
                  <td style={{ border: "1px solid #424242", padding: "8px" }}>{move.name}</td>
                  <td style={{ border: "1px solid #424242", padding: "8px", textAlign: "center" }}>
                    <span
                      style={{
                        backgroundColor: typeColors[move.type?.toLowerCase()] || "#616161",
                        color: "#ffffff",
                        padding: "0.3rem 0.6rem",
                        borderRadius: "8px",
                        fontWeight: "bold",
                      }}
                    >
                      {move.type || "Unknown"}
                    </span>
                  </td>
                  <td style={{ border: "1px solid #424242", padding: "8px", textAlign: "center" }}>{move.power || "-"}</td>
                  <td style={{ border: "1px solid #424242", padding: "8px", textAlign: "center" }}>{move.accuracy || "-"}</td>
                  <td style={{ border: "1px solid #424242", padding: "8px", textAlign: "center" }}>{move.move_method || "Unknown"}</td>
                  <td style={{ border: "1px solid #424242", padding: "8px", textAlign: "center" }}>{move.move_method === "level-up" ? move.level : "-"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default PokemonDetailPage;