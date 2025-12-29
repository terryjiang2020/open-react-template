export const searchPokemon = async ({
  searchTerm = "",
  page = 0,
  heightMin = 0,
  heightMax = -1,
  weightMin = 0,
  weightMax = -1,
  mustHaveTypes = [],
  mustNotHaveTypes = [],
  canLearnMove,
  canLearnMoves = [],
  stats = {},
}: {
  searchTerm?: string;
  page?: number;
  heightMin?: number;
  heightMax?: number;
  weightMin?: number;
  weightMax?: number;
  mustHaveTypes?: number[];
  mustNotHaveTypes?: number[];
  canLearnMove?: number;
  canLearnMoves?: { moveId: number; moveMethodId: number }[];
  stats?: Record<string, { min: number; max: number }>;
}) => {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          searchTerm,
          page,
          heightMin,
          heightMax,
          weightMin,
          weightMax,
          mustHaveTypes,
          mustNotHaveTypes,
          canLearnMove,
          canLearnMoves,
          stats,
        }),
      }
    );

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

export const fetchPokemonDetails = async (id: number) => {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/details/${id}`);
    if (!response.ok) {
      throw new Error("Failed to fetch Pokémon details");
    }
    return response.json();
  } catch (error) {
    console.error("Error fetching Pokémon details:", error);
    throw error;
  }
};