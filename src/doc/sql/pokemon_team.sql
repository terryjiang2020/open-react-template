DROP TABLE IF EXISTS UserPokemonWatchlist CASCADE;

CREATE TABLE IF NOT EXISTS UserPokemonWatchlist (
	id SERIAL PRIMARY KEY,
	pokemon_id INT NOT NULL,
    user_id INT NOT NULL,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------------------------

DROP TABLE IF EXISTS UserPokemonTeams CASCADE;

CREATE TABLE IF NOT EXISTS UserPokemonTeams (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    team_name VARCHAR(100) NOT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    created_by INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by INT DEFAULT 0
);

----------------------------------------------------------------

DROP TABLE IF EXISTS UserPokemonTeamMembers CASCADE;

CREATE TABLE IF NOT EXISTS UserPokemonTeamMembers (
    id SERIAL PRIMARY KEY,
    team_id INT NOT NULL,
    pokemon_id INT NOT NULL,
    nickname VARCHAR(100),
    level INT DEFAULT 50,
    order_index INT NOT NULL,
    moves INT[],
    shiny BOOLEAN DEFAULT FALSE,
    deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    created_by INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by INT DEFAULT 0
);

----------------------------------------------------------------

-- Trigger function to adjust order_index for UserPokemonTeamMembers
CREATE OR REPLACE FUNCTION adjust_order_index()
RETURNS TRIGGER AS $$
BEGIN
    -- If the order_index is updated, shift other members' order_index accordingly
    IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
        UPDATE UserPokemonTeamMembers
        SET order_index = order_index + 1
        WHERE team_id = NEW.team_id
          AND id != NEW.id
          AND order_index >= NEW.order_index
          AND deleted = FALSE;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to call the adjust_order_index function on INSERT or UPDATE
CREATE TRIGGER adjust_order_index_trigger
AFTER INSERT OR UPDATE OF order_index
ON UserPokemonTeamMembers
FOR EACH ROW
EXECUTE FUNCTION adjust_order_index();

----------------------------------------------------------------

-- Items table
DROP TABLE IF EXISTS items CASCADE;

CREATE TABLE IF NOT EXISTS items (
    id INT PRIMARY KEY,
    identifier VARCHAR(100) NOT NULL,
    category_id INT NOT NULL,
    cost INT,
    fling_power INT,
    fling_effect_id INT
);

-- Item Names table
DROP TABLE IF EXISTS item_names CASCADE;

CREATE TABLE IF NOT EXISTS item_names (
    id SERIAL PRIMARY KEY,
    item_id INT NOT NULL,
    local_language_id INT NOT NULL,
    name VARCHAR(100) NOT NULL
);

INSERT INTO item_names (item_id, local_language_id, name)


-- Languages table
DROP TABLE IF EXISTS languages CASCADE;

CREATE TABLE IF NOT EXISTS languages (
    id INT PRIMARY KEY,
    iso639 VARCHAR(10),
    iso3166 VARCHAR(10),
    identifier VARCHAR(50) NOT NULL,
    official BOOLEAN NOT NULL DEFAULT FALSE,
    "order" INT NOT NULL
);

-- Insert data into languages table
INSERT INTO languages (id, iso639, iso3166, identifier, official, "order") VALUES
(1, 'ja', 'jp', 'ja-Hrkt', TRUE, 1),
(2, 'ja', 'jp', 'roomaji', TRUE, 3),
(3, 'ko', 'kr', 'ko', TRUE, 4),
(4, 'zh', 'cn', 'zh-Hant', TRUE, 5),
(5, 'fr', 'fr', 'fr', TRUE, 8),
(6, 'de', 'de', 'de', TRUE, 9),
(7, 'es', 'es', 'es', TRUE, 10),
(8, 'it', 'it', 'it', TRUE, 11),
(9, 'en', 'us', 'en', TRUE, 7),
(10, 'cs', 'cz', 'cs', FALSE, 12),
(11, 'ja', 'jp', 'ja', TRUE, 2),
(12, 'zh', 'cn', 'zh-Hans', TRUE, 6),
(13, 'pt-BR', 'br', 'pt-BR', FALSE, 13);

-- Language Names table
DROP TABLE IF EXISTS language_names CASCADE;

CREATE TABLE IF NOT EXISTS language_names (
    id SERIAL PRIMARY KEY,
    language_id INT NOT NULL,
    local_language_id INT NOT NULL,
    name VARCHAR(100) NOT NULL
);

-- Insert data into language_names table
INSERT INTO language_names (language_id, local_language_id, name) VALUES
(1, 1, '日本語'),
(1, 3, '일본어'),
(1, 5, 'Japonais'),
(1, 6, 'Japanisch'),
(1, 7, 'Japonés'),
(1, 9, 'Japanese'),
(2, 1, '正式ローマジ'),
(2, 3, '정식 로마자'),
(2, 5, 'Romaji'),
(2, 6, 'Rōmaji'),
(2, 9, 'Official roomaji'),
(3, 1, '韓国語'),
(3, 3, '한국어'),
(3, 5, 'Coréen'),
(3, 6, 'Koreanisch'),
(3, 7, 'Coreano'),
(3, 9, 'Korean'),
(4, 1, '中国語'),
(4, 3, '중국어'),
(4, 5, 'Chinois'),
(4, 6, 'Chinesisch'),
(4, 7, 'Chino'),
(4, 9, 'Chinese'),
(5, 1, 'フランス語'),
(5, 3, '프랑스어'),
(5, 5, 'Français'),
(5, 6, 'Französisch'),
(5, 7, 'Francés'),
(5, 9, 'French'),
(6, 1, 'ドイツ語'),
(6, 3, '도이치어'),
(6, 5, 'Allemand'),
(6, 6, 'Deutsch'),
(6, 7, 'Alemán'),
(6, 9, 'German'),
(7, 1, '西語'),
(7, 3, '스페인어'),
(7, 5, 'Espagnol'),
(7, 6, 'Spanisch'),
(7, 7, 'Español'),
(7, 9, 'Spanish'),
(8, 1, '伊語'),
(8, 3, '이탈리아어'),
(8, 5, 'Italien'),
(8, 6, 'Italienisch'),
(8, 7, 'Italiano'),
(8, 9, 'Italian'),
(9, 1, '英語'),
(9, 3, '영어'),
(9, 5, 'Anglais'),
(9, 6, 'Englisch'),
(9, 7, 'Inglés'),
(9, 9, 'English'),
(10, 1, 'チェコ語'),
(10, 3, '체코어'),
(10, 5, 'Tchèque'),
(10, 6, 'Tschechisch'),
(10, 7, 'Checo'),
(10, 9, 'Czech');