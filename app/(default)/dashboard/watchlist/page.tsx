import React, { useEffect, useState } from 'react';
import { getWatchlist } from '@/services/pokemonService';

const WatchlistPage = () => {
  const [watchlist, setWatchlist] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWatchlist = async () => {
      try {
        const data = await getWatchlist();
        setWatchlist(data);
      } catch (error) {
        console.error('Failed to fetch watchlist:', error);
      } finally {
        setLoading(false);
      }
    };

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
      <ul>
        {watchlist.map((pokemon) => (
          <li key={pokemon.pokemonId}>
            <img src={pokemon.sprite} alt={pokemon.name} />
            <span>{pokemon.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default WatchlistPage;