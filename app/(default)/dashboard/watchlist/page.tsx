"use client";

import React, { useEffect, useState } from 'react';
import { getWatchlist, removeFromWatchlist } from '@/services/pokemonService';
import { useRouter } from 'next/navigation';

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
      <table>
        <thead>
          <tr>
            <th>Sprite</th>
            <th>Name</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {watchlist.map((pokemon) => (
            <tr key={pokemon.pokemonId}>
              <td>
                <img src={pokemon.sprite} alt={pokemon.identifier} />
              </td>
              <td>{pokemon.identifier}</td>
              <td>
                <button onClick={() => handleViewDetails(pokemon.pokemonId)}>
                  View Details
                </button>
                <button
                  onClick={() => handleRemove(pokemon.pokemonId)}
                  style={{
                    backgroundColor: 'red',
                    color: 'white',
                    border: 'none',
                    padding: '5px 10px',
                    borderRadius: '5px',
                    cursor: 'pointer',
                  }}
                >
                  Remove from Watchlist
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default WatchlistPage;