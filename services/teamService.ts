import axios from 'axios';

const API_BASE_URL = `${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/teams`;

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const getTeams = async () => {
  const response = await axios.get(`${API_BASE_URL}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const createTeam = async (teamName: string) => {
  const response = await axios.post(`${API_BASE_URL}`, { teamName }, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const deleteTeam = async (teamId: number) => {
  const response = await axios.delete(`${API_BASE_URL}/${teamId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const addPokemonToTeam = async (teamId: number, pokemonId: number) => {
  const response = await axios.post(`${API_BASE_URL}/${teamId}/members`, { pokemonId }, {
    headers: getAuthHeaders(),
  });
  return response.data;
};