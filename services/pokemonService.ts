export const fetchPokemons = async () => {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/search`);
    if (!response.ok) {
      throw new Error("Failed to fetch Pokémon data");
    }
    return response.json();
  } catch (error) {
    console.error("Error fetching Pokémon data:", error);
    throw error;
  }
};

export const searchPokemon = async ({ query = '', page = 1 }: { query: string; page: number }) => {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/search?searchterm=${query.toLowerCase()}&page=${page}`);
    if (!response.ok) {
      throw new Error("Pokémon not found");
    }
    return response.json();
  } catch (error) {
    console.error("Error searching Pokémon:", error);
    throw error;
  }
};