-- ================================================================
-- Pokemon Database Schema for PostgreSQL
-- Generated: 2025-12-28
-- Description: Comprehensive schema for Pokemon, Moves, Abilities, and Berries
-- ================================================================

-- ================================================================
-- SECTION 1: Drop existing tables (in reverse dependency order)
-- ================================================================

DROP TABLE IF EXISTS berry_flavors CASCADE;
DROP TABLE IF EXISTS ability_prose CASCADE;
DROP TABLE IF EXISTS ability_names CASCADE;
DROP TABLE IF EXISTS pokemon_stats CASCADE;
DROP TABLE IF EXISTS pokemon_types CASCADE;
DROP TABLE IF EXISTS berries CASCADE;
DROP TABLE IF EXISTS abilities CASCADE;
DROP TABLE IF EXISTS moves CASCADE;
DROP TABLE IF EXISTS pokemon CASCADE;
DROP TABLE IF EXISTS pokemon_species CASCADE;
DROP TABLE IF EXISTS move_effects CASCADE;
DROP TABLE IF EXISTS move_targets CASCADE;
DROP TABLE IF EXISTS stats CASCADE;
DROP TABLE IF EXISTS move_damage_classes CASCADE;
DROP TABLE IF EXISTS berry_firmness CASCADE;
DROP TABLE IF EXISTS contest_types CASCADE;
DROP TABLE IF EXISTS types CASCADE;
DROP TABLE IF EXISTS generations CASCADE;

-- ================================================================
-- SECTION 2: Base/Lookup Tables
-- ================================================================

-- Generations table
CREATE TABLE generations (
    id INTEGER PRIMARY KEY,
    main_region_id INTEGER,
    identifier VARCHAR(50) NOT NULL UNIQUE
);

COMMENT ON TABLE generations IS 'Pokemon generations (Gen I, Gen II, etc.)';
COMMENT ON COLUMN generations.identifier IS 'Generation name identifier (e.g., generation-i)';

-- Types table (Fire, Water, Grass, etc.)
CREATE TABLE types (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE,
    generation_id INTEGER NOT NULL,
    damage_class_id INTEGER,
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE RESTRICT
);

COMMENT ON TABLE types IS 'Pokemon and move types (Fire, Water, Grass, etc.)';

-- Contest types
CREATE TABLE contest_types (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE
);

COMMENT ON TABLE contest_types IS 'Contest type categories for moves and berries';

-- Move damage classes (Physical, Special, Status)
CREATE TABLE move_damage_classes (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE
);

COMMENT ON TABLE move_damage_classes IS 'Move damage classifications: physical, special, or status';

-- Stats (HP, Attack, Defense, etc.)
CREATE TABLE stats (
    id INTEGER PRIMARY KEY,
    damage_class_id INTEGER,
    identifier VARCHAR(50) NOT NULL UNIQUE,
    is_battle_only BOOLEAN NOT NULL DEFAULT FALSE,
    game_index INTEGER,
    FOREIGN KEY (damage_class_id) REFERENCES move_damage_classes(id) ON DELETE SET NULL
);

COMMENT ON TABLE stats IS 'Pokemon base stats (HP, Attack, Defense, Sp.Atk, Sp.Def, Speed)';

-- Move targets
CREATE TABLE move_targets (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE
);

COMMENT ON TABLE move_targets IS 'Defines what a move can target (single pokemon, all opponents, etc.)';

-- Move effects
CREATE TABLE move_effects (
    id INTEGER PRIMARY KEY
);

COMMENT ON TABLE move_effects IS 'Unique move effects referenced by moves table';

-- Berry firmness
CREATE TABLE berry_firmness (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE
);

COMMENT ON TABLE berry_firmness IS 'Berry firmness levels (very-soft, soft, hard, etc.)';

-- ================================================================
-- SECTION 3: Main Entity Tables
-- ================================================================

-- Pokemon Species table
CREATE TABLE pokemon_species (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE,
    generation_id INTEGER NOT NULL,
    evolves_from_species_id INTEGER,
    evolution_chain_id INTEGER,
    color_id INTEGER,
    shape_id INTEGER,
    habitat_id INTEGER,
    gender_rate INTEGER,
    capture_rate INTEGER,
    base_happiness INTEGER,
    is_baby BOOLEAN NOT NULL DEFAULT FALSE,
    hatch_counter INTEGER,
    has_gender_differences BOOLEAN NOT NULL DEFAULT FALSE,
    growth_rate_id INTEGER,
    forms_switchable BOOLEAN NOT NULL DEFAULT FALSE,
    is_legendary BOOLEAN NOT NULL DEFAULT FALSE,
    is_mythical BOOLEAN NOT NULL DEFAULT FALSE,
    "order" INTEGER,
    conquest_order INTEGER,
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE RESTRICT,
    FOREIGN KEY (evolves_from_species_id) REFERENCES pokemon_species(id) ON DELETE SET NULL
);

COMMENT ON TABLE pokemon_species IS 'Pokemon species data (shared across all forms of a species)';
COMMENT ON COLUMN pokemon_species.identifier IS 'Species name identifier (e.g., bulbasaur)';
COMMENT ON COLUMN pokemon_species.gender_rate IS '-1 for genderless, 0-8 for female ratio (8 = 100% female)';

-- Pokemon table (individual forms)
CREATE TABLE pokemon (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE,
    species_id INTEGER NOT NULL,
    height INTEGER NOT NULL,
    weight INTEGER NOT NULL,
    base_experience INTEGER,
    "order" INTEGER,
    is_default BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (species_id) REFERENCES pokemon_species(id) ON DELETE CASCADE
);

COMMENT ON TABLE pokemon IS 'Individual Pokemon forms (e.g., mega evolutions, regional variants)';
COMMENT ON COLUMN pokemon.height IS 'Height in decimeters';
COMMENT ON COLUMN pokemon.weight IS 'Weight in hectograms';
COMMENT ON COLUMN pokemon.is_default IS 'Whether this is the default form for the species';

-- Moves table
CREATE TABLE moves (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE,
    generation_id INTEGER NOT NULL,
    type_id INTEGER NOT NULL,
    power INTEGER,
    pp INTEGER,
    accuracy INTEGER,
    priority INTEGER NOT NULL DEFAULT 0,
    target_id INTEGER,
    damage_class_id INTEGER,
    effect_id INTEGER,
    effect_chance INTEGER,
    contest_type_id INTEGER,
    contest_effect_id INTEGER,
    super_contest_effect_id INTEGER,
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE RESTRICT,
    FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT,
    FOREIGN KEY (target_id) REFERENCES move_targets(id) ON DELETE RESTRICT,
    FOREIGN KEY (damage_class_id) REFERENCES move_damage_classes(id) ON DELETE RESTRICT,
    FOREIGN KEY (effect_id) REFERENCES move_effects(id) ON DELETE RESTRICT,
    FOREIGN KEY (contest_type_id) REFERENCES contest_types(id) ON DELETE SET NULL
);

COMMENT ON TABLE moves IS 'Pokemon moves/attacks data';
COMMENT ON COLUMN moves.power IS 'Base power of the move (NULL for status moves)';
COMMENT ON COLUMN moves.pp IS 'Power Points - how many times the move can be used';
COMMENT ON COLUMN moves.accuracy IS 'Accuracy percentage (NULL for moves that never miss)';
COMMENT ON COLUMN moves.priority IS 'Move priority (-7 to +5, higher goes first)';

-- Abilities table
CREATE TABLE abilities (
    id INTEGER PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE,
    generation_id INTEGER NOT NULL,
    is_main_series BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE RESTRICT
);

COMMENT ON TABLE abilities IS 'Pokemon abilities (passive effects)';
COMMENT ON COLUMN abilities.is_main_series IS 'Whether this ability appears in main series games';

-- Berries table
CREATE TABLE berries (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL,
    firmness_id INTEGER NOT NULL,
    natural_gift_power INTEGER,
    natural_gift_type_id INTEGER,
    size INTEGER NOT NULL,
    max_harvest INTEGER NOT NULL,
    growth_time INTEGER NOT NULL,
    soil_dryness INTEGER NOT NULL,
    smoothness INTEGER NOT NULL,
    FOREIGN KEY (firmness_id) REFERENCES berry_firmness(id) ON DELETE RESTRICT,
    FOREIGN KEY (natural_gift_type_id) REFERENCES types(id) ON DELETE SET NULL
);

COMMENT ON TABLE berries IS 'Berry items data';
COMMENT ON COLUMN berries.item_id IS 'Reference to item_id in items table';
COMMENT ON COLUMN berries.size IS 'Size in millimeters';
COMMENT ON COLUMN berries.growth_time IS 'Time to grow in hours';
COMMENT ON COLUMN berries.soil_dryness IS 'How much the berry dries the soil';
COMMENT ON COLUMN berries.smoothness IS 'Smoothness value for contests';

-- ================================================================
-- SECTION 4: Junction/Relationship Tables
-- ================================================================

-- Pokemon Types junction table
CREATE TABLE pokemon_types (
    pokemon_id INTEGER NOT NULL,
    type_id INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    PRIMARY KEY (pokemon_id, slot),
    FOREIGN KEY (pokemon_id) REFERENCES pokemon(id) ON DELETE CASCADE,
    FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT
);

COMMENT ON TABLE pokemon_types IS 'Links Pokemon to their types (1-2 types per Pokemon)';
COMMENT ON COLUMN pokemon_types.slot IS 'Type slot (1 or 2)';

CREATE TABLE pokemon_type_names (
    id SERIAL PRIMARY KEY,
    pokemon_type_id INTEGER NOT NULL,
    local_language_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL
);

-- Pokemon Stats junction table
CREATE TABLE pokemon_stats (
    pokemon_id INTEGER NOT NULL,
    stat_id INTEGER NOT NULL,
    base_stat INTEGER NOT NULL,
    effort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pokemon_id, stat_id),
    FOREIGN KEY (pokemon_id) REFERENCES pokemon(id) ON DELETE CASCADE,
    FOREIGN KEY (stat_id) REFERENCES stats(id) ON DELETE RESTRICT
);

COMMENT ON TABLE pokemon_stats IS 'Base stats for each Pokemon';
COMMENT ON COLUMN pokemon_stats.base_stat IS 'Base value for this stat';
COMMENT ON COLUMN pokemon_stats.effort IS 'Effort Value (EV) yield when defeated';

CREATE TABLE pokemon_stat_names (
    id SERIAL PRIMARY KEY,
    pokemon_stat_id INTEGER NOT NULL,
    local_language_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL
);

-- Ability Names (localized)
CREATE TABLE ability_names (
    ability_id INTEGER NOT NULL,
    local_language_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    PRIMARY KEY (ability_id, local_language_id),
    FOREIGN KEY (ability_id) REFERENCES abilities(id) ON DELETE CASCADE
);

COMMENT ON TABLE ability_names IS 'Localized ability names';

-- Ability Prose (descriptions)
CREATE TABLE ability_prose (
    ability_id INTEGER NOT NULL,
    local_language_id INTEGER NOT NULL,
    short_effect TEXT,
    effect TEXT,
    PRIMARY KEY (ability_id, local_language_id),
    FOREIGN KEY (ability_id) REFERENCES abilities(id) ON DELETE CASCADE
);

COMMENT ON TABLE ability_prose IS 'Ability descriptions and effects in different languages';
COMMENT ON COLUMN ability_prose.short_effect IS 'Brief description of the ability';
COMMENT ON COLUMN ability_prose.effect IS 'Detailed description of the ability';

-- Berry Flavors junction table
CREATE TABLE berry_flavors (
    berry_id INTEGER NOT NULL,
    contest_type_id INTEGER NOT NULL,
    flavor INTEGER NOT NULL,
    PRIMARY KEY (berry_id, contest_type_id),
    FOREIGN KEY (berry_id) REFERENCES berries(id) ON DELETE CASCADE,
    FOREIGN KEY (contest_type_id) REFERENCES contest_types(id) ON DELETE RESTRICT
);

COMMENT ON TABLE berry_flavors IS 'Berry flavor values for each contest type';
COMMENT ON COLUMN berry_flavors.flavor IS 'Flavor intensity (0-100)';

-- Ability Names table
CREATE TABLE IF NOT EXISTS ability_names (
    id SERIAL PRIMARY KEY,
    ability_id INT NOT NULL,
    local_language_id INT NOT NULL,
    name VARCHAR(100) NOT NULL
);

-- Move Names table
CREATE TABLE IF NOT EXISTS move_names (
    id SERIAL PRIMARY KEY,
    move_id INT NOT NULL,
    local_language_id INT NOT NULL,
    name VARCHAR(100) NOT NULL
);

-- Pokemon Species Names table
DROP TABLE IF EXISTS pokemon_species_names CASCADE;

CREATE TABLE IF NOT EXISTS pokemon_species_names (
    id SERIAL PRIMARY KEY,
    pokemon_species_id INT NOT NULL,
    local_language_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    genus VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS pokemon_species_flavor_text (
    id SERIAL PRIMARY KEY,
    pokemon_species_id INT NOT NULL,
    local_language_id INT NOT NULL,
    flavor_text TEXT NOT NULL,
    version_id INT NOT NULL
);

DROP TABLE IF EXISTS pokemon_abilities CASCADE;

CREATE TABLE IF NOT EXISTS pokemon_abilities (
    id SERIAL PRIMARY KEY,
    pokemon_id INT NOT NULL,
    ability_id INT NOT NULL,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    slot INT NOT NULL
);

-- Pokemon Moves junction table
DROP TABLE IF EXISTS pokemon_moves CASCADE;

CREATE TABLE IF NOT EXISTS pokemon_moves (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL,
    move_id INTEGER NOT NULL,
    version_group_id INTEGER NOT NULL,
    move_method_id INTEGER NOT NULL,
    level INTEGER,
    order_index INTEGER,
    mastery INT
);

-- Pokemon Move Methods table
DROP TABLE IF EXISTS pokemon_move_methods CASCADE;

CREATE TABLE IF NOT EXISTS pokemon_move_methods (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(50) NOT NULL UNIQUE
);

-- ================================================================
-- SECTION 5: Indexes for Performance
-- ================================================================

-- Pokemon indexes
CREATE INDEX idx_pokemon_species_id ON pokemon(species_id);
CREATE INDEX idx_pokemon_order ON pokemon("order");
CREATE INDEX idx_pokemon_is_default ON pokemon(is_default);

-- Pokemon Species indexes
CREATE INDEX idx_pokemon_species_generation_id ON pokemon_species(generation_id);
CREATE INDEX idx_pokemon_species_evolves_from ON pokemon_species(evolves_from_species_id);
CREATE INDEX idx_pokemon_species_evolution_chain ON pokemon_species(evolution_chain_id);
CREATE INDEX idx_pokemon_species_is_legendary ON pokemon_species(is_legendary);
CREATE INDEX idx_pokemon_species_is_mythical ON pokemon_species(is_mythical);

-- Moves indexes
CREATE INDEX idx_moves_generation_id ON moves(generation_id);
CREATE INDEX idx_moves_type_id ON moves(type_id);
CREATE INDEX idx_moves_damage_class_id ON moves(damage_class_id);
CREATE INDEX idx_moves_target_id ON moves(target_id);
CREATE INDEX idx_moves_power ON moves(power);

-- Abilities indexes
CREATE INDEX idx_abilities_generation_id ON abilities(generation_id);
CREATE INDEX idx_abilities_is_main_series ON abilities(is_main_series);

-- Berries indexes
CREATE INDEX idx_berries_firmness_id ON berries(firmness_id);
CREATE INDEX idx_berries_natural_gift_type_id ON berries(natural_gift_type_id);

-- Pokemon Types indexes
CREATE INDEX idx_pokemon_types_type_id ON pokemon_types(type_id);

-- Pokemon Stats indexes
CREATE INDEX idx_pokemon_stats_stat_id ON pokemon_stats(stat_id);

-- Types indexes
CREATE INDEX idx_types_generation_id ON types(generation_id);

-- Stats indexes
CREATE INDEX idx_stats_damage_class_id ON stats(damage_class_id);

-- ================================================================
-- END OF SCHEMA
-- ================================================================

-- Summary:
-- - 9 base/lookup tables (generations, types, etc.)
-- - 5 main entity tables (pokemon, moves, abilities, berries, pokemon_species)
-- - 6 junction/relationship tables (pokemon_types, pokemon_stats, pokemon_moves, etc.)
-- - 23 indexes for query performance
-- - Full foreign key constraints with appropriate ON DELETE behaviors
-- - Comprehensive comments for documentation
