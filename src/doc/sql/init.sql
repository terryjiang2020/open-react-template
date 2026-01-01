DROP TABLE IF EXISTS Users CASCADE;

CREATE TABLE Users (
	id SERIAL PRIMARY KEY,
	role_id INT, -- 1: Admin, 2: User
	username VARCHAR(100),
	email VARCHAR(200),
	email_verified BOOLEAN DEFAULT FALSE,
	validating_code VARCHAR(6),
	phone_number VARCHAR(20),
	password TEXT,
	business_name VARCHAR(100),
	gst_number VARCHAR(20),
	nzbn VARCHAR(20),
	company_address_line_1 VARCHAR(200),
	company_address_line_2 VARCHAR(200),
	company_city VARCHAR(100),
	company_state VARCHAR(100),
	company_zip_code VARCHAR(20),
	company_country_id INT,
	agent_number INT DEFAULT 1,
	full_name VARCHAR(100),
	photo_url VARCHAR(200),
	country VARCHAR(100),
	logged_in BOOLEAN DEFAULT FALSE,
	last_active TIMESTAMP DEFAULT NOW(),
	last_login_time TIMESTAMP DEFAULT NOW(),
	active BOOLEAN DEFAULT TRUE,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT
);

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(1, 'superadmin', 'tomlzfm16@gmail.com', true, '977553'),
(2, 'normaluser', 'terryjiang1996@gmail.com', true, '977223'),
(2, 'normaluser', 'callum@occodigital.com', true, '767264'),
(2, 'testuser', 'terryjiang2019@gmail.com', true, '813843'),
(2, 'normalusermingh', 'mingh2865@gmail.com', true, '736421');

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normaluserdarren', 'buihoangdat1992@gmail.com', true, '135423');


INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normalusermingx', 'randomuser@yopmail.com', true, '432123');

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normaluserfelix', 'felix.wang@emerge-group.co', true, '456783');

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normaluserrenbin', 'renbin@timble.co.nz', true, '453954');

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normaluserpingwu', 'ping.wu@secureco.co', true, '489756');

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normaluserrobharrison', 'rob.harrison@grow.inc', true, '891565');

-- Demo Account START

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'demoaccount_1', 'test1@example.com', true, '000001'), -- Dev ID: 7
(2, 'demoaccount_2', 'test2@example.com', true, '000002'), -- Dev ID: 8
(2, 'demoaccount_3', 'test3@example.com', true, '000003'), -- Dev ID: 9
(2, 'demoaccount_4', 'test4@example.com', true, '000004'); -- Dev ID: 10

-- Demo Account END

INSERT INTO Users
(role_id, username, email, email_verified, validating_code)
VALUES
(2, 'normaluserrobharrison', 'amir@octopyd.com', true, '564244')
RETURNING id;

--------------------------------------------

DROP TABLE IF EXISTS BillingAddresses CASCADE;

CREATE TABLE BillingAddresses (
	id SERIAL PRIMARY KEY,
	user_id INT,
	full_name VARCHAR(100),
	phone_number VARCHAR(20),
	address_line_1 VARCHAR(200),
	address_line_2 VARCHAR(200),
	city VARCHAR(100),
	state VARCHAR(100),
	zip_code VARCHAR(20),
	country_id INT,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT
);

--------------------------------------------

DROP TABLE IF EXISTS CreditCards CASCADE;

CREATE TABLE CreditCards (
	id SERIAL PRIMARY KEY,
	user_id INT,
	last_4_digits VARCHAR(20),
	stripe_customer_id VARCHAR(100),
	stripe_card_id VARCHAR(100),
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT
);

--------------------------------------------

DROP TABLE IF EXISTS UserApiTokens CASCADE;

CREATE TABLE UserApiTokens (
	id SERIAL PRIMARY KEY,
	user_id INT,
	token VARCHAR(200),
	status INT DEFAULT 1, -- 1: Active, 2: Inactive
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT NOT NULL,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT NOT NULL
);

--------------------------------------------

DROP TABLE IF EXISTS EmailVerifyLinks CASCADE;

CREATE TABLE EmailVerifyLinks (
	id SERIAL PRIMARY KEY NOT NULL,
	email VARCHAR(200),
	new_email VARCHAR(200),
	url VARCHAR(200),
	code VARCHAR(6),
	user_id INT,
	user_type INT DEFAULT 1,
	used BOOLEAN DEFAULT FALSE,
	deleted BOOLEAN DEFAULT FALSE,
	valid_before TIMESTAMP NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

--------------------------------------------

DROP TABLE IF EXISTS Roles CASCADE;

CREATE TABLE Roles (
	id SERIAL PRIMARY KEY,
	name TEXT,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

INSERT INTO Roles (id, name)
VALUES 
(1, 'Admin'),
(2, 'User');

--------------------------------------------

DROP TABLE IF EXISTS ResetPasswordUrls CASCADE;

CREATE TABLE ResetPasswordUrls (
	id SERIAL PRIMARY KEY,
	user_id INT NOT NULL,
	alternative_id INT,
	url VARCHAR(200) NOT NULL,
	valid BOOLEAN DEFAULT TRUE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT
);

--------------------------------------------

DROP TABLE IF EXISTS UnsubscriptionUniqueUrls CASCADE;

CREATE TABLE UnsubscriptionUniqueUrls (
	id SERIAL PRIMARY KEY,
	email VARCHAR(200) NOT NULL,
	url VARCHAR(200) NOT NULL,
	user_id INT,
	used BOOLEAN DEFAULT FALSE,
	user_type INT DEFAULT 2, -- 2: User, 1: Undefined
	disabled BOOLEAN DEFAULT FALSE,
	reason_id INT,
	content TEXT,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT
);

----------------------------------------------

DROP TABLE IF EXISTS UserProfiles CASCADE;

CREATE TABLE UserProfiles (
	id SERIAL PRIMARY KEY,
	user_id INT,
	current_role_level_id INT,
	current_job_title VARCHAR(100),
	desired_annual_salary VARCHAR(50),
	desired_country_id INT,
	resume_url VARCHAR(200),
	linkedin_url VARCHAR(200),
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------

DROP TABLE IF EXISTS Notifications CASCADE;

CREATE TABLE Notifications (
	id SERIAL PRIMARY KEY,
	user_id INT,
	type_id INT,
	item_id INT,
	title VARCHAR(100),
	content TEXT,
	read BOOLEAN DEFAULT FALSE,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------

DROP TABLE IF EXISTS Plans CASCADE;

CREATE TABLE Plans (
	id SERIAL PRIMARY KEY,
	name VARCHAR(100),
	description TEXT,
	price DECIMAL(10, 2),
	currency VARCHAR(10),
	period INT, -- 1: Monthly, 2: Quarterly, 3: Yearly
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------

DROP TABLE IF EXISTS Subscriptions CASCADE;

CREATE TABLE Subscriptions (
	id SERIAL PRIMARY KEY,
	user_id INT,
	plan_id INT,
	subscription_start_date DATE,
	subscription_end_date DATE,
	subscription_status INT, -- 1: Active, 2: Inactive
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------

DROP TABLE IF EXISTS EmailAuthorizations CASCADE;

CREATE TABLE EmailAuthorizations (
	id SERIAL PRIMARY KEY,
	email VARCHAR(200),
	platform_id INT, -- 1: Gmail, 2: Outlook
	code VARCHAR(6),
	valid_before TIMESTAMP,
	used BOOLEAN DEFAULT FALSE,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------

DROP TABLE IF EXISTS UserCreditBalances CASCADE;

CREATE TABLE IF NOT EXISTS UserCreditBalances (
	id SERIAL PRIMARY KEY,
	user_id INT REFERENCES Users(id),
	amount INT DEFAULT 0, -- USD Cents
	-- Standard audit fields
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

INSERT INTO UserCreditBalances 
(user_id, amount)
VALUES
(7, 200),
(8, 200),
(9, 200),
(10, 200);

----------------------------------------------

DROP TABLE IF EXISTS UserCreditBalanceHistories CASCADE;

CREATE TABLE IF NOT EXISTS UserCreditBalanceHistories (
	id SERIAL PRIMARY KEY,
	user_id INT REFERENCES Users(id),
	amount INT DEFAULT 0, -- USD Cents
	message TEXT,
	-- Standard audit fields
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------

DROP TABLE IF EXISTS UserPlans CASCADE;

CREATE TABLE IF NOT EXISTS UserPlans (
	id SERIAL PRIMARY KEY,
	title TEXT,
	price INT DEFAULT 0,
	amount INT DEFAULT 0,
	purchase_link VARCHAR(200),
	stripe_prod_id VARCHAR(100),
	hidden BOOLEAN DEFAULT FALSE,
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

-- Test data

INSERT INTO UserPlans 
(title, price, amount, hidden, stripe_prod_id, purchase_link)
VALUES
('Beginner', 2500, 50, true, 'prod_SWlJEsfu2SjBLJ', 'https://buy.stripe.com/test_dRm7sE1bP0Th7gT5i9djO00'),
('Basic', 20000, 1000, false, 'prod_Shz9ywAhYgjk4X', 'https://buy.stripe.com/test_3cIaEQ2fT9pNgRth0RdjO01');


-- Prod data

INSERT INTO UserPlans 
(title, price, amount, hidden, stripe_prod_id, purchase_link)
VALUES
('Beginner', 2500, 50, true, 'prod_SWio7ZhQ44La8D', 'https://buy.stripe.com/dRm7sE1bP0Th7gT5i9djO00'),
('Basic', 20000, 1000, false, 'prod_ShyT5uDj9QKerG', 'https://buy.stripe.com/3cIaEQ2fT9pNgRth0RdjO01');

----------------------------------------------

DROP TABLE IF EXISTS UserPlanSubscriptions CASCADE;

CREATE TABLE IF NOT EXISTS UserPlanSubscriptions (
	id SERIAL PRIMARY KEY,
	user_id INT REFERENCES Users(id),
	plan_id INT REFERENCES UserPlans(id),
	stripe_event_id VARCHAR(100),
	stripe_subscription_id VARCHAR(100),
	start_date DATE,
	end_date DATE,
	amount INT DEFAULT 0,
	status INT DEFAULT 1, -- 0: Paused, 1: Active, 2: Cancelled
	deleted BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP DEFAULT NOW(),
	created_by INT DEFAULT 0,
	updated_at TIMESTAMP DEFAULT NOW(),
	updated_by INT DEFAULT 0
);

----------------------------------------------
