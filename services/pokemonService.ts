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

export const searchMove = async ({ query = '', page = 0 }: { query: string; page: number }) => {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/move/search?searchterm=${query.toLowerCase()}&page=${page}`);
    if (!response.ok) {
      throw new Error("Move not found");
    }
    return response.json();
  } catch (error) {
    console.error("Error searching Move:", error);
    throw error;
  }
};

export const searchBerry = async ({ query = '', page = 0 }: { query: string; page: number }) => {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/berry/search?searchterm=${query.toLowerCase()}&page=${page}`);
    if (!response.ok) {
      throw new Error("Berry not found");
    }
    return response.json();
  } catch (error) {
    console.error("Error searching Berry:", error);
    throw error;
  }
};

export const searchAbility = async ({ query = '', page = 0 }: { query: string; page: number }) => {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/ability/search?searchterm=${query.toLowerCase()}&page=${page}`);
    if (!response.ok) {
      throw new Error("Ability not found");
    }
    return response.json();
  } catch (error) {
    console.error("Error searching Ability:", error);
    throw error;
  }
};