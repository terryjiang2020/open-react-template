"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchPokemonDetails } from "@/services/pokemonService";
import { getTypeClass } from "@/services/typeStyleService";

import { Button } from "@headlessui/react";

// export const typeColors = {
//   normal: "#A8A878",
//   fighting: "#C03028",
//   flying: "#A890F0",
//   poison: "#A040A0",
//   ground: "#E0C068",
//   rock: "#B8A038",
//   bug: "#A8B820",
//   ghost: "#705898",
//   steel: "#B8B8D0",
//   fire: "#F08030",
//   water: "#6890F0",
//   grass: "#78C850",
//   electric: "#F8D030",
//   psychic: "#F85888",
//   ice: "#98D8D8",
//   dragon: "#7038F8",
//   dark: "#705848",
//   fairy: "#EE99AC",
//   stellar: "#FFD700", // Custom color for stellar
// };

const PokemonDetailPage = () => {
  const router = useRouter();
  const params = useParams();
  const id = params?.id ? String(params.id) : "";
  const [pokemon, setPokemon] = useState<any | null>(null);
  const [filter, setFilter] = useState("level-up");

  useEffect(() => {
    if (!id) return;
    fetchPokemonDetails(Number(id))
      .then((data) => {
        if (data.success) {
          const result = { ...data.result };
          result.moves = (result.moves || []).map((move: any) => ({
            ...move,
            type: move.type || "Normal",
          }));
          setPokemon(result);
        } else {
          console.warn("Failed to fetch Pokémon details.");
        }
      })
      .catch((error) => console.warn(error));
  }, [id]);

  const stats = useMemo(() => {
    if (!pokemon) return [];
    return [
      { label: "HP", value: pokemon.hp ?? pokemon.stats?.hp },
      { label: "Attack", value: pokemon.attack ?? pokemon.stats?.attack },
      { label: "Defense", value: pokemon.defense ?? pokemon.stats?.defense },
      { label: "Sp. Attack", value: pokemon.specialAttack ?? pokemon.stats?.specialAttack },
      { label: "Sp. Defense", value: pokemon.specialDefense ?? pokemon.stats?.specialDefense },
      { label: "Speed", value: pokemon.speed ?? pokemon.stats?.speed },
    ].filter((s) => s.value !== undefined && s.value !== null);
  }, [pokemon]);

  if (!pokemon) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-foreground/80">
        Loading...
      </div>
    );
  }

  const filteredMoves = (pokemon.moves || []).filter((move: any) => filter === "all" || move.move_method === filter);

  return (
    <div className="container mx-auto p-6 text-foreground max-h-full overflow-y-auto">
      <Button className="mb-6 gap-2" onClick={() => router.back()}>
        Back
      </Button>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="border rounded-lg border-white p-4">
          <div>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-sm text-muted-foreground">#{pokemon.id?.toString().padStart(3, "0")}</div>
                <h2 className="text-3xl capitalize">{pokemon.name}</h2>
              </div>
              <img
                src={pokemon.sprite}
                alt={pokemon.name}
                className="size-32 object-contain drop-shadow-xl"
              />
            </div>
          </div>
          <div className="flex flex-col gap-4">
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
          </div>
        </div>

        <div className="border rounded-lg border-white p-4">
          <div>
            <h3 className="font-mono text-lg">Base Stats</h3>
          </div>
          <div className="flex flex-col gap-3">
            {stats.map((stat) => (
              <StatBar key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-lg border border-border/50 p-4 md:col-span-2">
          <div>
            <div className="font-mono text-xs text-muted-foreground">Height</div>
            <div className="text-lg font-semibold">{pokemon.height} m</div>
          </div>
          <div>
            <div className="font-mono text-xs text-muted-foreground">Weight</div>
            <div className="text-lg font-semibold">{pokemon.weight} kg</div>
          </div>
          <div>
            <div className="font-mono text-xs text-muted-foreground">Base XP</div>
            <div className="text-lg font-semibold">{pokemon.baseExperience}</div>
          </div>
          <div>
            <div className="font-mono text-xs text-muted-foreground">Flavor</div>
            <div className="text-sm text-muted-foreground">{pokemon.flavorText}</div>
          </div>
        </div>

        <div className="border rounded-lg border-border/50 md:col-span-2 p-4">
          <div className="mb-4">
            <h3 className="font-mono text-lg mb-3">Move List</h3>
            <div className="flex flex-wrap gap-2 border-border/50 pb-3">
              {[
                { key: "level-up", label: "Level-Up" },
                { key: "tutor", label: "Tutor" },
                { key: "machine", label: "Machine" },
                { key: "all", label: "All" },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => setFilter(item.key)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    filter === item.key
                      ? "bg-primary text-white"
                      : "bg-transparent text-foreground border border-border/50 hover:bg-border/20"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            <div className="grid gap-3 sm:grid-cols-2">
              {filteredMoves.map((move: any, index: number) => (
                <div key={index} className="flex flex-col gap-2 rounded-lg border border-border/50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold capitalize">{move.name}</span>
                    {
                      <span
                        key={index}
                        className={`text-xs capitalize ${getTypeClass(move.type)}`}
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
                        {move.type || "Unknown"}
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
                    <div>
                      Method: <span className="text-foreground capitalize">{move.move_method || "Unknown"}</span>
                    </div>
                    <div>
                      Level: <span className="text-foreground">{move.move_method === "level-up" ? move.level ?? "-" : "-"}</span>
                    </div>
                  </div>
                </div>
              ))}
              {filteredMoves.length === 0 && (
                <div className="col-span-2 text-sm text-muted-foreground">No moves for this filter.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function StatBar({ label, value }: { label: string; value: number }) {
  const percentage = Math.min(((value || 0) / 255) * 100, 100);

  return (
    <div className="flex items-center gap-3">
      <div className="w-24 font-mono text-xs text-muted-foreground">{label}</div>
      <div className="flex-1">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-border/60">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
      <div className="w-12 text-right font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

export default PokemonDetailPage;