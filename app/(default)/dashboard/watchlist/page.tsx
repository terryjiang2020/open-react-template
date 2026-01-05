"use client";

import React, { useEffect, useState } from 'react';
import { getWatchlist, removeFromWatchlist } from '@/services/pokemonService';
import { useRouter } from 'next/navigation';
import { typeColors } from '../pokemons/[id]/page';

const WatchlistPage = () => {
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const fetchWatchlist = async () => {
    try {
      const data = await getWatchlist();
      console.log('Fetched Watchlist data:', data);
      if (data.success) {
        setWatchlist(data.result);
      }
    } catch (error) {
      console.error('Failed to fetch watchlist:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (pokemonId: number) => {
    try {
      await removeFromWatchlist(pokemonId);
      fetchWatchlist();
    } catch (error) {
      console.error('Failed to remove from watchlist:', error);
    }
  };

  const handleViewDetails = (pokemonId: number) => {
    const currentPath = window.location.pathname;
    router.push(`/dashboard/pokemons/${pokemonId}?prevPage=${encodeURIComponent(currentPath)}`);
  };

  useEffect(() => {
    fetchWatchlist();
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (watchlist.length === 0) {
    return <div>Your watchlist is empty.</div>;
  }

  return (
    <div>
      <h1>Your Watchlist</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {watchlist.map((pokemon) => (
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
              {pokemon.pokemonTypeNames && pokemon.pokemonTypeNames.length > 0 ? (
                pokemon.pokemonTypeNames.map((type: string, index: number) => {
                  const typeIdentifier = type || "";
                  console.log('typeIdentifier: ', typeIdentifier);
                  const typeName = type || typeIdentifier;
                  const typeKey = typeIdentifier.toLowerCase();
                  const chipColor = typeColors[typeKey as keyof typeof typeColors] || "#ccc";
                  const chipBg = `${chipColor}26`; // light tint of the type color

                  return (
                    <span
                      key={index}
                      style={{
                        backgroundColor: chipBg,
                        color: chipColor,
                        border: `1px solid ${chipColor}`,
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
                onClick={() => handleViewDetails(pokemon.pokemonId)}
                className="flex-1 gap-1.5 border border-white rounded-lg text-base h-10 hover:bg-white/10"
              >
                View Details
              </button>
              <button
                onClick={() => handleRemove(pokemon.pokemonId)}
                className={`flex-1 gap-1.5 text-base h-10 ${
                  "border border-primary bg-primary/10 text-primary rounded-lg hover:bg-primary/20"
                }`}
              >
                Remove from Watchlist
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WatchlistPage;