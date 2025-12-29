export const searchPokemon = async ({
  searchterm = "",
  page = 0,
  sortby = 0,
  filter = {},
}: {
  searchterm?: string;
  page?: number;
  sortby?: number;
  filter?: {
    heightMin?: number;
    heightMax?: number;
    weightMin?: number;
    weightMax?: number;
    mustHaveTypes?: number[];
    mustNotHaveTypes?: number[];
    canLearnMove?: number;
    canLearnMoves?: { moveId: number; moveMethodId: number }[];
    stats?: Record<string, { min: number; max: number }>;
  };
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
          searchterm,
          page,
          sortby,
          filter,
        }),
      }
    );

    if (!response.ok) {
      throw new Error("Pokémon not found");
    }

    return response.json();
  } catch (error: any) {
    console.warn("Error searching Pokémon:", error);
    throw error;
  }
};

export const searchMove = async ({ searchterm = '', page = 0 }: { searchterm?: string; page?: number }) => {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/move/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          searchterm,
          page,
        }),
      }
    );
    if (!response.ok) {
      throw new Error("Move not found");
    }
    return response.json();
  } catch (error: any) {
    console.warn("Error searching Move:", error);
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
  } catch (error: any) {
    console.warn("Error searching Berry:", error);
    throw error;
  }
};

export const searchAbility = async ({ searchterm = '', page = 0 }: { searchterm?: string; page?: number }) => {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_ELASTICDASH_API}/pokemon/ability/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          searchterm,
          page,
        }),
      }
    );
    if (!response.ok) {
      throw new Error("Ability not found");
    }
    return response.json();
  } catch (error: any) {
    console.warn("Error searching Ability:", error);
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
  } catch (error: any) {
    console.warn("Error fetching Pokémon details:", error);
    throw error;
  }
};