"use client";

import React, { useState, useEffect } from 'react';
import { searchPokemon } from '@/services/pokemonService';
import { getTeams, createTeam, deleteTeam, addPokemonToTeam } from '@/services/teamService';

const TeamsPage = () => {
  const [teams, setTeams] = useState<any[]>([]);
  const [newTeamName, setNewTeamName] = useState('');
  const [selectedTeam, setSelectedTeam] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const fetchTeams = async () => {
    try {
      const data = await getTeams();
      console.log('Fetched Teams data:', data);
      if (data.success) {
        setTeams(data.result ? data.result : []);
      }
    } catch (error) {
      console.error('Failed to fetch teams:', error);
    }
  };

  const handleCreateTeam = async () => {
    if (!newTeamName) return;
    try {
      await createTeam(newTeamName);
      setNewTeamName('');
      fetchTeams();
    } catch (error) {
      console.error('Failed to create team:', error);
    }
  };

  const handleDeleteTeam = async (teamId: number) => {
    try {
      await deleteTeam(teamId);
      fetchTeams();
    } catch (error) {
      console.error('Failed to delete team:', error);
    }
  };

  const handleSearchPokemons = async () => {
    try {
      const results = await searchPokemon({ searchterm: searchTerm });
      setSearchResults(results);
    } catch (error) {
      console.error('Failed to search pokemons:', error);
    }
  };

  const handleAddPokemonToTeam = async (pokemonId: number) => {
    if (!selectedTeam || selectedTeam.pokemons.length >= 6) return;
    try {
      await addPokemonToTeam(selectedTeam.id, pokemonId);
      fetchTeams();
    } catch (error) {
      console.error('Failed to add Pokémon to team:', error);
    }
  };

  useEffect(() => {
    fetchTeams();
  }, []);

  return (
    <div>
      <h1>Manage Teams</h1>

      <div>
        <input
          type="text"
          value={newTeamName}
          onChange={(e) => setNewTeamName(e.target.value)}
          placeholder="Enter team name"
        />
        <button onClick={handleCreateTeam}>Create Team</button>
      </div>

      <div>
        <h2>Your Teams</h2>
        <ul>
          {teams.map((team: any) => (
            <li key={team.id}>
              <h3>{team.teamName}</h3>
              <button onClick={() => handleDeleteTeam(team.id)}>Delete Team</button>
              {/* <ul>
                {team.pokemons.map((pokemon: any) => (
                  <li key={pokemon.id}>{pokemon.name}</li>
                ))}
              </ul> */}
              <button onClick={() => setSelectedTeam(team)}>Add Pokémon</button>
            </li>
          ))}
        </ul>
      </div>

      {selectedTeam && (
        <div>
          <h2>Add Pokémon to {selectedTeam.name}</h2>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Pokémon"
          />
          <button onClick={handleSearchPokemons}>Search</button>
          <ul>
            {searchResults.map((pokemon) => (
              <li key={pokemon.id}>
                {pokemon.name}
                <button onClick={() => handleAddPokemonToTeam(pokemon.id)}>Add to Team</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default TeamsPage;